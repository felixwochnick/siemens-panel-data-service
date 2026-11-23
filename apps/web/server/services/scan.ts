import { errorText } from '../lib/log'
import type { EventLogger } from '../lib/log'
import type { FolderSkip } from '../../shared/types/api'
import { enqueueAnalysis } from './analyses'
import type { AppContext } from './context'
import { ServiceError } from './errors'
import { ensureFolderAvailable, folderProjectStates, isChanged, scanFolder, upsertFolderProject } from './folder'
import { runRetention } from './retention'
import { loadSettings } from './settings'

export interface ScanRunResult {
  found: number
  queued: number
  skipped: FolderSkip[]
}

/**
 * Ein Lauf des Zeitplans: Aufbewahrung, Netzlaufwerk verbinden, Projektordner scannen, Projekte anlegen bzw.
 * aktualisieren und einen Auftrag `schedule` für neue, seit der letzten erfolgreichen Analyse geänderte oder zuletzt
 * gescheiterte Projekte einreihen (nicht, wenn schon einer offen ist).
 */
export async function runScheduledScan(ctx: AppContext): Promise<ScanRunResult> {
  await runRetention(ctx).catch(error => ctx.log(`[retention] fehlgeschlagen: ${errorText(error)}`))
  const { settings, unreadable } = await loadSettings(ctx)
  if (!settings.folder.trim()) throw new ServiceError(400, 'folder_not_configured')
  const log: EventLogger = event => ctx.log(`[scheduler] ${event.code} ${JSON.stringify(event.params ?? {})}`)
  await ensureFolderAvailable(ctx, settings, unreadable, 'always', log)
  const scan = await scanFolder(settings)
  const states = await folderProjectStates(ctx.db)
  let queued = 0
  for (const item of scan.items) {
    const state = states.get(item.pathKey)
    const projectId = await upsertFolderProject(ctx.db, item, null, ctx.now())
    if (state?.latestStatus === 'queued' || state?.latestStatus === 'running') continue
    const failed = state?.latestStatus === 'failed' || state?.latestStatus === 'aborted'
    if (state && !failed && !isChanged(item.sourceModified, state.currentSourceModified)) continue
    try {
      await enqueueAnalysis(ctx.db, { projectId, trigger: 'schedule', userId: null, now: ctx.now() })
      queued++
    }
    catch (error) {
      if (!(error instanceof ServiceError) || error.statusCode !== 409) throw error
    }
  }
  if (queued) ctx.queue.kick()
  ctx.log(`[scheduler] Lauf: ${scan.items.length} Projekte, ${queued} eingereiht, ${scan.skipped.length} übersprungen`)
  return { found: scan.items.length, queued, skipped: scan.skipped }
}
