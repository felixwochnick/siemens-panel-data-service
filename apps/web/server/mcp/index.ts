import { z } from 'zod'
import { defineMcpTool } from '@pds/core/mcp'
import type { McpServerDefinition, McpToolContext } from '@pds/core/mcp'
import enAnalyses from '../../i18n/locales/en/analyses.json'
import enApp from '../../i18n/locales/en/app.json'
import { EPLAN_OPEN_MODES, LOG_LEVELS, PROJECT_SOURCES } from '../../shared/types/api'
import type { AnalysisEventInfo, AnalysisInfo, DatabaseDialect, ProjectInfo } from '../../shared/types/api'
import { LIMITS } from '../lib/settings'
import type { Actor } from '../services/access'
import { getAnalysis, listAnalysisEvents, startAnalysis } from '../services/analyses'
import type { AppContext } from '../services/context'
import { getStatus } from '../services/control'
import { ServiceError } from '../services/errors'
import { listFolderProjects } from '../services/folder'
import { getProject, listProjects } from '../services/projects'
import { listShields, listTexts, queryCables, queryConnections } from '../services/results'
import { getSettings, patchSettings, setSchedulerEnabled } from '../services/settings'

const instructions = `EPLAN Panel Data Service (PDS) reads EPLAN Electric P8 projects and stores the results in a database: connections (wires with #-mark, twisted and shielded flags), cables with their wires, shields and free texts. You act for the signed-in person with exactly their rights.

Terms:
- Project: an EPLAN project, either uploaded as .zw1 archive (source upload) or found in the project folder of the server (source folder, .elk + .edb or .zw1; path relative to that folder).
- Analysis: one run of a project through EPLAN (status queued, running, succeeded, failed, aborted). Every analysis is kept as its own version; the current version of a project is its newest succeeded analysis. Analyses run one at a time; a project has at most one open (queued or running) analysis.
- Results of a succeeded analysis: connections (idx, page, designation, source, destination, cable, wire number, cross-section, wire type, length, part numbers, hashMark, twisted, shielded), cables (kind cable or shield, with wires; connectionIdx points into connections), shields (connectionIdx lists the shielded connections) and texts.

Workflow:
1. get_status shows the EPLAN worker, the queue and the latest analyses. list_projects and get_project show projects with their analyses.
2. Results: query_connections, query_cables, list_shields, list_texts. They read the current version of a project (projectId) unless you pass analysisId. Use filters and limit/offset instead of reading everything.
3. With write access: start_analysis queues a project (by projectId or by a path from list_folder_projects). Administrators can also switch the schedule (set_scheduler) and change settings (update_settings, never passwords). Tell the person what you are about to change first.`

/** Texte zu den Fehlercodes der App (englisch, für das Modell); alles andere stammt aus core */
const appErrors = enApp.errors as Record<string, string>
const errorText = (code: string) => (Object.hasOwn(appErrors, code) ? appErrors[code] : undefined)

/** Englische Zeile zu einem Ereignis (Codes allein sagen dem Modell wenig) */
const eventTexts = enAnalyses.analysisEvents as Record<string, string>
function eventMessage(event: Pick<AnalysisEventInfo, 'code' | 'params'>): string {
  const template = Object.hasOwn(eventTexts, event.code) ? eventTexts[event.code]! : event.code
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(event.params?.[key] ?? '-'))
}

const DATABASE_NAMES: Record<DatabaseDialect, string> = { mssql: 'SQL Server', sqlite: 'SQLite' }

/** Die Person hinter der Verbindung handelt mit genau ihren Rechten – die Services prüfen sie */
const actorOf = (ctx: McpToolContext): Actor => ({ id: ctx.user.id, isAdmin: ctx.user.isAdmin })

const analysisForModel = (a: AnalysisInfo) => ({
  id: a.id,
  projectId: a.projectId,
  projectName: a.projectName,
  trigger: a.trigger,
  triggeredBy: a.triggeredBy,
  status: a.status,
  ...(a.stage && { stage: a.stage }),
  queuedAt: a.queuedAt,
  startedAt: a.startedAt,
  finishedAt: a.finishedAt,
  isCurrent: a.isCurrent,
  ...(a.counts && { counts: a.counts }),
  ...(a.eplanProjectName && { eplanProjectName: a.eplanProjectName }),
  ...(a.errorCode && { error: { code: a.errorCode, message: eventMessage({ code: a.errorCode, params: null }), detail: a.errorDetail } }),
})

const projectForModel = (p: ProjectInfo) => ({
  id: p.id,
  source: p.source,
  name: p.name,
  ...(p.path && { path: p.path }),
  fileKind: p.fileKind,
  sourceModified: p.sourceModified,
  current: p.currentAnalysis && { analysisId: p.currentAnalysis.id, finishedAt: p.currentAnalysis.finishedAt, counts: p.currentAnalysis.counts },
  latest: p.latestAnalysis && { analysisId: p.latestAnalysis.id, status: p.latestAnalysis.status, ...(p.latestAnalysis.errorCode && { errorCode: p.latestAnalysis.errorCode }) },
})

const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict()

/** Welcher Stand: aktueller Stand eines Projekts oder eine bestimmte Analyse */
const target = {
  projectId: z.number().int().min(1).optional().describe('Project id: reads its current version (newest succeeded analysis)'),
  analysisId: z.number().int().min(1).optional().describe('A specific succeeded analysis instead of the current version'),
}
const pageInput = (max: number, fallback: number) => ({
  limit: z.number().int().min(1).max(max).default(fallback).describe(`Number of rows (1–${max}), default ${fallback}`),
  offset: z.number().int().min(0).default(0).describe('Rows to skip'),
})
const contains = (what: string) => z.string().trim().min(1).max(200).optional().describe(`${what} contains (case-insensitive)`)

/** update_settings: nur nicht-geheime Felder, unbekannte (z. B. password) werden abgelehnt */
const settingsPatch = {
  folder: z.string().max(1000).optional().describe('Project folder on the server (local path, mapped drive or UNC path); empty = no folder projects'),
  source: z.enum(['local', 'network']).optional().describe('network: (re)connect the network drive before each access (Windows only)'),
  networkDrive: strict({
    mapping: z.string().max(10).optional().describe('Drive letter, e.g. P'),
    networkPath: z.string().max(1000).optional().describe('UNC path, e.g. \\\\server\\share'),
    user: z.string().max(320).optional(),
  }).optional(),
  recursive: z.boolean().optional().describe('Also search subfolders'),
  filePatterns: z.array(z.string().max(100)).max(LIMITS.filePatterns.max).optional().describe('File patterns, e.g. ["*.elk", "*.zw1"]; only .elk and .zw1 files are projects'),
  eplan: strict({
    platformBin: z.string().max(1000).optional().describe('Bin folder of EPLAN Platform'),
    productBin: z.string().max(1000).optional().describe('Bin folder of EPLAN Electric P8'),
    applicationModifier: z.string().max(200).optional(),
    openMode: z.enum(EPLAN_OPEN_MODES).optional(),
  }).optional(),
  schedulerEnabled: z.boolean().optional().describe('Prefer set_scheduler, which checks that the settings are complete'),
  cronSchedule: z.string().max(200).optional().describe('Quartz 6-field ("0 0 2 * * ?" = daily at 02:00) or 5-field cron expression'),
  timezone: z.string().max(100).optional().describe('IANA time zone of the schedule, e.g. Europe/Berlin'),
  analysisTimeoutMinutes: z.number().int().min(LIMITS.analysisTimeoutMinutes.min).max(LIMITS.analysisTimeoutMinutes.max).optional(),
  retentionDays: z.number().int().min(LIMITS.retentionDays.min).max(LIMITS.retentionDays.max).optional().describe('Delete analyses older than this, except the current version of each project'),
  uploadMaxMb: z.number().int().min(LIMITS.uploadMaxMb.min).max(LIMITS.uploadMaxMb.max).optional(),
}

/** Der MCP-Server der App: Werkzeuge rufen nur Services auf (nie SQL) */
export function createPdsMcpServer(app: AppContext): McpServerDefinition {
  return {
    name: 'pds',
    title: 'EPLAN Panel Data Service',
    version: '1.0.0',
    instructions,
    errorText,
    tools: [
      defineMcpTool({
        name: 'get_status',
        title: 'Get status',
        description: 'Overview: database type, EPLAN worker (connected or not, EPLAN state), the running analysis with its stage, queued analyses, the latest finished analyses. For administrators also settings issues and the schedule with its next runs.',
        access: 'read',
        input: {},
        handler: async (_input, ctx) => {
          const status = await getStatus(app, actorOf(ctx))
          return {
            database: DATABASE_NAMES[status.database],
            worker: status.worker,
            running: status.queue.running && analysisForModel(status.queue.running),
            queued: status.queue.queued.map(analysisForModel),
            queuedCount: status.queue.queuedCount,
            recentAnalyses: status.recentAnalyses.map(analysisForModel),
            ...(status.admin && { issues: status.admin.issues, scheduler: status.admin.scheduler }),
          }
        },
      }),

      defineMcpTool({
        name: 'list_projects',
        title: 'List projects',
        description: 'Projects (uploaded and from the project folder) sorted by name, with their current version and the status of the newest analysis.',
        access: 'read',
        input: {
          search: contains('Name or path'),
          source: z.enum(PROJECT_SOURCES).optional(),
          limit: z.number().int().min(1).max(200).default(50),
          page: z.number().int().min(1).default(1).describe('Page (1-based) of size limit'),
        },
        handler: async (input, ctx) => {
          const result = await listProjects(app.db, actorOf(ctx), { search: input.search, source: input.source, page: input.page, pageSize: input.limit })
          return { total: result.total, projects: result.items.map(projectForModel) }
        },
      }),

      defineMcpTool({
        name: 'get_project',
        title: 'Get project',
        description: 'One project with its analyses (versions), newest first, including counters of succeeded analyses and errors of failed ones.',
        access: 'read',
        input: { projectId: z.number().int().min(1), limit: z.number().int().min(1).max(200).default(20).describe('Number of analyses') },
        handler: async (input, ctx) => {
          const project = await getProject(app.db, actorOf(ctx), input.projectId)
          return { ...projectForModel(project), analysisCount: project.analyses.length, analyses: project.analyses.slice(0, input.limit).map(analysisForModel) }
        },
      }),

      defineMcpTool({
        name: 'list_folder_projects',
        title: 'List projects in the project folder',
        description: 'Projects found in the project folder of the server (.elk with .edb folder, or .zw1), with their path, last change and whether they changed since the last succeeded analysis. Use the path with start_analysis.',
        access: 'read',
        input: {
          search: contains('Path'),
          changedOnly: z.boolean().default(false).describe('Only new or changed projects'),
          ...pageInput(500, 100),
        },
        handler: async (input, ctx) => {
          const scan = await listFolderProjects(app, actorOf(ctx))
          const needle = input.search?.toLowerCase()
          const items = scan.items.filter(item => (!needle || item.path.toLowerCase().includes(needle)) && (!input.changedOnly || item.changed))
          return { folder: scan.folder, total: items.length, items: items.slice(input.offset, input.offset + input.limit), skipped: scan.skipped }
        },
      }),

      defineMcpTool({
        name: 'get_analysis',
        title: 'Get analysis',
        description: 'One analysis with its events in order (code and English message), optionally only from a minimum level (warn = warnings and errors).',
        access: 'read',
        input: {
          analysisId: z.number().int().min(1),
          level: z.enum(LOG_LEVELS).optional().describe('Minimum level of events; default all'),
          ...pageInput(500, 200),
        },
        handler: async (input, ctx) => {
          const actor = actorOf(ctx)
          const analysis = await getAnalysis(app.db, actor, input.analysisId)
          const events = await listAnalysisEvents(app.db, actor, input.analysisId, { level: input.level, offset: input.offset, limit: input.limit })
          return {
            ...analysisForModel(analysis),
            eventCount: events.total,
            events: events.items.map(event => ({ at: event.at, level: event.level, code: event.code, message: eventMessage(event), ...(event.detail && { detail: event.detail }) })),
          }
        },
      }),

      defineMcpTool({
        name: 'query_connections',
        title: 'Query connections',
        description: 'Connections of a project version with filters (all filters combine with AND). Returns total (after filtering) and the rows from offset. Booleans: hashMark (a # text marks the wire), twisted, shielded.',
        access: 'read',
        input: {
          ...target,
          page: contains('Page'),
          cable: contains('Cable name'),
          designation: contains('Connection designation'),
          endpoint: contains('Source or destination'),
          hashMark: z.boolean().optional(),
          twisted: z.boolean().optional(),
          shielded: z.boolean().optional(),
          ...pageInput(1000, 100),
        },
        handler: async (input, ctx) => queryConnections(app.db, actorOf(ctx), input, input, input),
      }),

      defineMcpTool({
        name: 'query_cables',
        title: 'Query cables',
        description: 'Cables and shields (like the EPLAN cable navigator) of a project version with their wires. connectionIdx of a wire points into the connections (null for 3D or unknown).',
        access: 'read',
        input: {
          ...target,
          name: contains('Cable name'),
          page: contains('Page'),
          kind: z.enum(['cable', 'shield']).optional(),
          ...pageInput(200, 50),
        },
        handler: async (input, ctx) => queryCables(app.db, actorOf(ctx), input, input, input),
      }),

      defineMcpTool({
        name: 'list_shields',
        title: 'List shields',
        description: 'Shields of a project version (shield symbols and shielded cables) with the indexes of the shielded connections (connectionIdx, see query_connections).',
        access: 'read',
        input: { ...target, ...pageInput(500, 100) },
        handler: async (input, ctx) => listShields(app.db, actorOf(ctx), input, input),
      }),

      defineMcpTool({
        name: 'list_texts',
        title: 'List texts',
        description: 'Free texts of a project version (not on report pages), per page from top to bottom.',
        access: 'read',
        input: { ...target, page: contains('Page'), contains: contains('Text'), ...pageInput(1000, 200) },
        handler: async (input, ctx) => listTexts(app.db, actorOf(ctx), input, input, input),
      }),

      defineMcpTool({
        name: 'get_settings',
        title: 'Get settings',
        description: 'Settings (administrators only): project folder, network drive, EPLAN paths, schedule, timeout, retention, upload limit. The network drive password appears only as { set, readable }. issues lists what is missing.',
        access: 'read',
        input: {},
        handler: async (_input, ctx) => {
          const result = await getSettings(app, actorOf(ctx))
          return { settings: result.settings, issues: result.issues, updatedAt: result.updatedAt, updatedBy: result.updatedBy }
        },
      }),

      defineMcpTool({
        name: 'start_analysis',
        title: 'Start analysis',
        description: 'Queues an analysis of a known project (projectId) or of a project in the project folder (folderPath as listed by list_folder_projects). Returns immediately; follow it with get_analysis. Fails with analysis_already_queued if the project already has an open analysis.',
        access: 'write',
        input: {
          projectId: z.number().int().min(1).optional(),
          folderPath: z.string().trim().min(1).max(1000).optional().describe('Path relative to the project folder, e.g. Line 1\\Plant.elk'),
        },
        handler: async (input, ctx) => {
          if ((input.projectId === undefined) === (input.folderPath === undefined)) throw new ServiceError(400, 'project_or_folder_path_required')
          const result = await startAnalysis(app, actorOf(ctx), input.projectId !== undefined ? { projectId: input.projectId } : { folderPaths: [input.folderPath!] }, 'mcp')
          if (!result.queued.length) throw new ServiceError(409, result.skipped[0]?.code ?? 'analysis_already_queued')
          return analysisForModel(result.queued[0]!)
        },
      }),

      defineMcpTool({
        name: 'set_scheduler',
        title: 'Enable or disable the schedule',
        description: 'Administrators only. Switches scheduled analyses of the project folder on or off. Enabling requires complete settings and a project folder. Returns the schedule with the next runs.',
        access: 'write',
        idempotent: true,
        input: { enabled: z.boolean() },
        handler: async (input, ctx) => {
          const actor = actorOf(ctx)
          await setSchedulerEnabled(app, actor, input.enabled, 'mcp')
          return (await getStatus(app, actor)).admin?.scheduler
        },
      }),

      defineMcpTool({
        name: 'update_settings',
        title: 'Update settings',
        description: 'Administrators only. Changes settings; omitted fields stay as they are. Passwords cannot be set here. Fails with invalid_settings and the list of issues (path + code) when a value is invalid. Returns the changed fields and the remaining issues.',
        access: 'write',
        destructive: true,
        idempotent: true,
        input: settingsPatch,
        handler: async (input, ctx) => {
          const result = await patchSettings(app, actorOf(ctx), input, 'mcp')
          return { changed: result.changed, settings: result.settings, issues: result.issues }
        },
      }),
    ],
  }
}
