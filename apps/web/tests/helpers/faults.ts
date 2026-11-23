import type { Kysely, KyselyPlugin, RootOperationNode } from 'kysely'

type StatementKind = 'InsertQueryNode' | 'UpdateQueryNode' | 'DeleteQueryNode'

interface Rule {
  kind: StatementKind
  table: string
  remaining: number
}

/**
 * Tabellenname einer Anweisung ohne Schema (snake_case wie nach dem CamelCasePlugin). Unter SQLite hat das
 * Kompatibilitäts-Plugin das Schema schon in den Namen gezogen (`pds_analyses`) – das Präfix fällt hier wieder weg.
 */
function tableOf(node: RootOperationNode): string | undefined {
  const target = (node as { into?: unknown, table?: unknown }).into ?? (node as { table?: unknown }).table
  const table = (target as { table?: { schema?: unknown, identifier?: { name?: string } } } | undefined)?.table
  const name = table?.identifier?.name
  return name && !table?.schema ? name.replace(/^(?:core|pds)_/, '') : name
}

/**
 * Datenbank mit eingestreuten Fehlern für Tests: passende Anweisungen scheitern, bevor sie den Server erreichen
 * (wie eine abgerissene Verbindung). `times` begrenzt die Anzahl, Standard: bis `heal()`.
 */
export function withFaults<DB>(db: Kysely<DB>) {
  const rules: Rule[] = []
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      const table = tableOf(node)
      const rule = rules.find(r => r.kind === node.kind && r.table === table && r.remaining > 0)
      if (rule) {
        rule.remaining--
        throw new Error(`Simulierter Datenbankfehler (${node.kind} ${table})`)
      }
      return node
    },
    async transformResult({ result }) {
      return result
    },
  }
  return {
    db: db.withPlugin(plugin),
    fail(kind: StatementKind, table: string, times = Number.POSITIVE_INFINITY) {
      rules.push({ kind, table, remaining: times })
    },
    heal() {
      rules.length = 0
    },
  }
}
