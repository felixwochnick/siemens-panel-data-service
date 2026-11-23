// Gepuffertes Schreiben von Ereignissen (aus dem RunExecutor des ESWC): ein Datenbankfehler hält die Analyse nicht an
export interface EventQueueOptions<T> {
  write: (rows: T[]) => Promise<void>
  /** Zeilen je Anweisung (SQL Server: höchstens 2100 Parameter) */
  chunkSize: number
  max: number
  /** erster Fehler einer Störung (nicht jeder Versuch) */
  onError: (error: unknown) => void
  /** einmalig, sobald die ältesten Einträge verworfen werden */
  onDrop: () => void
}

/**
 * Einträge auf dem Weg in die Datenbank: Schreiben nacheinander in Blöcken; scheitert ein Block, kommt er wieder an
 * den Anfang und wird beim nächsten flush erneut versucht (geschriebene Blöcke nie doppelt). Während einer längeren
 * Störung bleiben höchstens `max` Einträge – die ältesten fallen mit einer einzigen Warnung weg.
 */
export class EventQueue<T> {
  private items: T[] = []
  private writing: Promise<void> = Promise.resolve()
  private failing = false
  private warned = false
  /** wegen der Obergrenze verworfene Einträge */
  dropped = 0

  constructor(private readonly options: EventQueueOptions<T>) {}

  /** wartende Einträge (ohne den Block, der gerade geschrieben wird) */
  get size(): number {
    return this.items.length
  }

  /** Alles Wartende herausnehmen (die Aufruferin schreibt es selbst, z. B. in einer Transaktion) */
  drain(): T[] {
    return this.items.splice(0)
  }

  push(item: T): void {
    this.items.push(item)
    this.trim()
  }

  /** schreibt alles Wartende; erfüllt sich immer (Fehler bleiben in der Warteschlange) */
  flush(): Promise<void> {
    this.writing = this.writing.then(() => this.writeAll())
    return this.writing
  }

  private async writeAll(): Promise<void> {
    while (this.items.length) {
      const chunk = this.items.splice(0, this.options.chunkSize)
      try {
        await this.options.write(chunk)
        this.failing = false
      }
      catch (error) {
        this.items.unshift(...chunk)
        this.trim()
        if (!this.failing) this.options.onError(error)
        this.failing = true
        return
      }
    }
  }

  private trim(): void {
    const excess = this.items.length - this.options.max
    if (excess <= 0) return
    this.items.splice(0, excess)
    this.dropped += excess
    if (!this.warned) {
      this.warned = true
      this.options.onDrop()
    }
  }
}
