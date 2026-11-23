import type { EventLogger, LogEvent } from '../../server/lib/log'

export const DRIVE_PASSWORD = 'Dr!ve-Pa55'

/** Sammelt Ereignisse eines Loggers */
export function recorder(): { log: EventLogger, events: LogEvent[], codes: () => string[] } {
  const events: LogEvent[] = []
  return { log: e => events.push(e), events, codes: () => events.map(e => e.code) }
}
