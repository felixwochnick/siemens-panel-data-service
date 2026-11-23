import type { Kysely } from 'kysely'
import type { AppDatabase } from '../database/types'
import { createWindowsDriveConnector } from '../lib/drive'
import type { DriveConnector } from '../lib/drive'
import { AnalysisQueue } from './queue'
import type { QueueOptions } from './queue'
import { runScheduledScan } from './scan'
import { ProjectScheduler } from './scheduler'
import { loadSettings } from './settings'
import type { SettingsDeps } from './settings'
import { WorkerClient } from './worker-client'
import type { WorkerClientOptions, WorkerSpec } from './worker-client'

/** Alles, was Services, API und MCP-Werkzeuge brauchen; in Nuxt einmal je Prozess (useAppContext), in Tests je Datei */
export interface AppContext extends SettingsDeps {
  /** Datenordner (absolut) mit uploads/ und work/ */
  dataDir: string
  /** Ordner mit den Protokolldateien des Windows-Dienstes ('' = nicht gesetzt) */
  logDir: string
  worker: WorkerClient
  queue: AnalysisQueue
  scheduler: ProjectScheduler
  drive: DriveConnector
  now: () => Date
  /** Zeile für stdout bzw. app.log */
  log: (line: string) => void
}

export interface AppContextOptions {
  db: Kysely<AppDatabase>
  secretKey: Buffer
  dataDir: string
  logDir?: string
  /** Verbindung zum Worker (NUXT_EPLAN_WORKER); null = kein Worker */
  workerSpec?: WorkerSpec | null
  worker?: Omit<WorkerClientOptions, 'spec'>
  drive?: DriveConnector
  queue?: Omit<QueueOptions, 'db' | 'secretKey' | 'dataDir' | 'worker' | 'drive'>
  now?: () => Date
  log?: (line: string) => void
}

export function createAppContext(options: AppContextOptions): AppContext {
  const { db, secretKey, dataDir } = options
  const log = options.log ?? ((line: string) => console.info(line))
  const now = options.now ?? (() => new Date())
  const drive = options.drive ?? createWindowsDriveConnector()
  const worker = new WorkerClient({ spec: options.workerSpec ?? null, log, now, ...options.worker })
  const queue = new AnalysisQueue({ db, secretKey, dataDir, worker, drive, now, print: log, ...options.queue })
  const ctx: AppContext = {
    db,
    secretKey,
    dataDir,
    logDir: options.logDir ?? '',
    worker,
    queue,
    drive,
    now,
    log,
    scheduler: undefined as unknown as ProjectScheduler,
  }
  ctx.scheduler = new ProjectScheduler({
    loadSettings: async () => (await loadSettings(ctx)).settings,
    run: async () => {
      await runScheduledScan(ctx)
    },
    log,
  })
  ctx.onSettingsChanged = () => ctx.scheduler.reload()
  return ctx
}
