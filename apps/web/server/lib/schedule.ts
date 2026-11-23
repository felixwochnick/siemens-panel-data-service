// Zeitplan-Hilfen aus dem ESWC-Controller (packages/controller/src/schedule.ts)
import { Cron } from 'croner'
import type { CronOptions } from 'croner'

/**
 * croner-Optionen passend zum Ausdruck. Die App muss beim Planen dieselben Optionen verwenden
 * (`new Cron(expr, { ...cronOptions(expr), timezone, protect: true }, fn)`), sonst weichen Vorschau und Ausführung ab.
 *
 * - 6/7 Felder gelten als Quartz: Wochentage 1–7 mit SUN=1 (`alternativeWeekdays`).
 * - 5 Felder gelten als klassisches cron: Wochentage 0–7 mit SUN=0/7.
 * - `0/5` (Quartz-Schrittweite mit Startwert) braucht `sloppyRanges`; `?` ersetzt croner selbst durch `*`.
 */
export function cronOptions(expr: string): Pick<CronOptions, 'mode' | 'sloppyRanges' | 'alternativeWeekdays'> {
  const fields = (expr ?? '').trim().split(/\s+/).filter(Boolean).length
  return {
    mode: 'auto',
    sloppyRanges: true,
    alternativeWeekdays: fields >= 6,
  }
}

function createCron(expr: string, timezone?: string): Cron {
  return new Cron(expr.trim(), { ...cronOptions(expr), ...(timezone ? { timezone } : {}), paused: true })
}

export function isValidCron(expr: string): boolean {
  if (typeof expr !== 'string' || !expr.trim()) return false
  try {
    const job = createCron(expr)
    // Ausdrücke ohne jede künftige Ausführung (z. B. 30. Februar) gelten als ungültig
    const ok = job.nextRun(new Date()) !== null
    job.stop()
    return ok
  }
  catch {
    return false
  }
}

/** Nächste Ausführungen; ungültiger Ausdruck oder ungültige Zeitzone ⇒ leere Liste */
export function nextRuns(expr: string, timezone: string, count: number, from?: Date): Date[] {
  if (!isValidCron(expr) || !(count > 0)) return []
  try {
    const job = createCron(expr, timezone)
    const runs = job.nextRuns(Math.floor(count), from ?? new Date())
    job.stop()
    return runs
  }
  catch {
    return []
  }
}
