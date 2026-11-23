import { Cron } from 'croner'
import { cronOptions, isValidCron, nextRuns } from '../lib/schedule'
import { isValidTimezone } from '../lib/settings'
import type { PdsSettings, SchedulerInfo } from '../../shared/types/api'

type ScheduleSettings = Pick<PdsSettings, 'schedulerEnabled' | 'cronSchedule' | 'timezone'>

/** Nächste Ausführungen; leer bei ungültigem Ausdruck oder ungültiger Zeitzone */
export function previewRuns(cron: string, timezone: string, count = 5, from?: Date): Date[] {
  if (!isValidCron(cron) || !isValidTimezone(timezone)) return []
  try {
    return nextRuns(cron, timezone, count, from)
  }
  catch {
    return []
  }
}

export interface SchedulerOptions {
  /** liest die aktuellen Einstellungen (ohne Rechteprüfung) */
  loadSettings: () => Promise<ScheduleSettings>
  /** ein Lauf: Projektordner scannen und Aufträge einreihen */
  run: () => Promise<void>
  log?: (line: string) => void
}

/**
 * Plant Läufe nach den Einstellungen (croner, Zeitzone aus den Einstellungen, wie im ESWC). `protect` verhindert, dass
 * sich Termine überholen. Nach der Installation ist der Zeitplan aus (schedulerEnabled = false).
 */
export class ProjectScheduler {
  private job: Cron | null = null
  private stopped = false
  private queue: Promise<void> = Promise.resolve()
  private readonly log: (line: string) => void

  constructor(private readonly options: SchedulerOptions) {
    this.log = options.log ?? (line => console.info(line))
  }

  /** Einstellungen neu lesen und neu planen (nach jedem Speichern); Aufrufe laufen nacheinander, Fehler nur im Log */
  reload(): Promise<void> {
    return this.load().catch((error) => {
      this.log(`[scheduler] Zeitplan konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Wie reload, gibt einen Fehler aber weiter – der Start des Servers versucht es dann erneut */
  load(): Promise<void> {
    const result = this.queue.then(() => this.apply())
    this.queue = result.catch(() => {})
    return result
  }

  private async apply() {
    const settings = await this.options.loadSettings()
    if (this.stopped) return
    this.job?.stop()
    this.job = null
    if (!settings.schedulerEnabled) {
      this.log('[scheduler] Zeitplan ist aus')
      return
    }
    if (!isValidCron(settings.cronSchedule) || !isValidTimezone(settings.timezone)) {
      this.log(`[scheduler] Zeitplan ungültig (${settings.cronSchedule}, ${settings.timezone}) – nicht eingeplant`)
      return
    }
    // Dieselben croner-Optionen wie Vorschau und Prüfung (Quartz-Wochentage, `0/5`)
    this.job = new Cron(settings.cronSchedule.trim(), { ...cronOptions(settings.cronSchedule), timezone: settings.timezone, protect: true }, () => this.tick())
    this.log(`[scheduler] eingeplant: ${settings.cronSchedule} (${settings.timezone}), nächster Lauf ${this.job.nextRun()?.toISOString() ?? '–'}`)
  }

  private async tick() {
    try {
      await this.options.run()
    }
    catch (error) {
      this.log(`[scheduler] Lauf fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Planung beenden (Server fährt herunter) */
  stop(): void {
    this.stopped = true
    this.job?.stop()
    this.job = null
  }

  /** Zustand für Übersicht und MCP */
  info(settings: ScheduleSettings, count = 5): SchedulerInfo {
    const valid = isValidCron(settings.cronSchedule) && isValidTimezone(settings.timezone)
    return {
      enabled: settings.schedulerEnabled,
      cronSchedule: settings.cronSchedule,
      timezone: settings.timezone,
      valid,
      active: !!this.job && !!this.job.nextRun(),
      nextRuns: settings.schedulerEnabled && valid ? previewRuns(settings.cronSchedule, settings.timezone, count).map(d => d.toISOString()) : [],
    }
  }
}
