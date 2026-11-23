import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementColumnMetadata } from 'node:sqlite'
import {
  AliasNode,
  CamelCasePlugin,
  CompiledQuery,
  Kysely,
  LimitNode,
  OperationNodeTransformer,
  ReferenceNode,
  ReturningNode,
  SchemableIdentifierNode,
  SelectAllNode,
  SelectionNode,
  SqliteAdapter,
  SqliteDialect,
  SqliteDriver,
  ValueNode,
} from 'kysely'
import type {
  DatabaseConnection,
  DeleteQueryNode,
  DialectAdapter,
  Driver,
  InsertQueryNode,
  KyselyPlugin,
  OperationNode,
  OutputNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryId,
  QueryResult,
  RootOperationNode,
  SelectQueryNode,
  SqliteDatabase,
  SqliteDialectConfig,
  SqliteStatement,
  UnknownRow,
  UpdateQueryNode,
} from 'kysely'

/*
 * SQLite über das in Node eingebaute `node:sqlite` (kein natives Zusatzmodul, das Windows-Paket bleibt gleich).
 *
 * Der Code der Dienste ist für SQL Server geschrieben (TOP, OFFSET … FETCH, OUTPUT inserted.*, Schemas `core`/`pds`).
 * Statt ihn zweimal zu führen, übersetzt SqliteCompatPlugin diese Eigenheiten; so bleiben auch Fehlerbehebungen aus
 * `siemens-lpd-apps` übertragbar. Tabellen heißen in SQLite `<schema>_<tabelle>` (SQLite kennt keine Schemas).
 *
 * Datentypen: Zeitpunkte als ISO-Text in UTC mit Millisekunden (`2026-01-01T12:00:00.000Z`, sortiert und vergleicht
 * richtig), Booleans als 0/1. Der Adapter wandelt beim Schreiben um und beim Lesen anhand des deklarierten Spaltentyps
 * (`datetime`, `boolean`) zurück; berechnete Spalten ohne Typ (z. B. `max(started_at)`) erkennt er am ISO-Format.
 */

/** Pfad aus `sqlite:<pfad>` (z. B. `sqlite:./.data/pds.db`, `sqlite:C:\Daten\pds.db`, `sqlite::memory:`) */
export function parseSqliteUrl(url: string): string | undefined {
  if (!/^sqlite:/i.test(url)) return undefined
  const path = url.slice('sqlite:'.length).trim()
  if (!path) throw new Error('NUXT_DATABASE_URL: Nach sqlite: fehlt der Pfad der Datenbankdatei')
  return path
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function toSqliteValue(value: unknown): SQLInputValue {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined) return null
  return value as SQLInputValue
}

type Converter = (value: unknown) => unknown

const toDate: Converter = value => typeof value === 'string' ? new Date(value) : value
const toBoolean: Converter = value => typeof value === 'number' || typeof value === 'bigint' ? Number(value) !== 0 : value
const isoToDate: Converter = value => typeof value === 'string' && ISO_UTC.test(value) ? new Date(value) : value

function converterFor(column: StatementColumnMetadata): Converter | undefined {
  const type = column.type?.toLowerCase()
  if (type === 'datetime') return toDate
  if (type === 'boolean') return toBoolean
  if (type === undefined || type === null || type === '') return isoToDate
  return undefined
}

function rowConverter(columns: StatementColumnMetadata[]): (row: unknown) => unknown {
  const converters = columns.flatMap((column) => {
    const convert = converterFor(column)
    return convert ? [[column.name, convert] as const] : []
  })
  if (!converters.length) return row => row
  return (row) => {
    const record = row as Record<string, unknown>
    for (const [name, convert] of converters) record[name] = convert(record[name])
    return record
  }
}

/** Kyselys SQLite-Treiber erwartet die API von better-sqlite3; dies bildet sie auf `node:sqlite` ab */
class NodeSqliteDatabase implements SqliteDatabase {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  prepare(sql: string): SqliteStatement {
    const statement = this.db.prepare(sql)
    const columns = statement.columns()
    const convert = rowConverter(columns)
    const bind = (parameters: ReadonlyArray<unknown>) => parameters.map(toSqliteValue)
    return {
      // Auch INSERT … RETURNING liefert Zeilen
      reader: columns.length > 0,
      all: parameters => statement.all(...bind(parameters)).map(convert),
      run: (parameters) => {
        const { changes, lastInsertRowid } = statement.run(...bind(parameters))
        return { changes, lastInsertRowid }
      },
      iterate: function* (parameters) {
        for (const row of statement.iterate(...bind(parameters))) yield convert(row)
      },
    }
  }
}

/**
 * Öffnet die Datei (legt den Ordner an). WAL: Lesende blockieren den Schreibenden nicht; busy_timeout: ein zweiter
 * Prozess (z. B. Werkzeug neben dem Dienst) wartet kurz statt sofort zu scheitern – `node:sqlite` arbeitet synchron,
 * solange wartet also der ganze Prozess (im Betrieb schreibt nur der Dienst, Werkzeuge halten die Sperre kurz);
 * Fremdschlüssel sind in SQLite sonst aus.
 */
export function openSqliteFile(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    if (path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
    }
  }
  catch (error) {
    db.close()
    throw error
  }
  return db
}

// ── Übersetzung der SQL-Server-Eigenheiten ──────────────────────────────────

const PSEUDO_TABLES = new Set(['inserted', 'deleted'])

function pseudoTableName(node: ReferenceNode): string | undefined {
  const name = node.table?.table.identifier.name
  return name && PSEUDO_TABLES.has(name.toLowerCase()) ? name : undefined
}

/** `inserted.id` → `id`, `deleted.*` → `*` (RETURNING kennt keine Pseudotabellen) */
function stripPseudoTable(selection: OperationNode): SelectionNode {
  const inner = SelectionNode.is(selection) ? selection.selection : selection
  if (ReferenceNode.is(inner) && pseudoTableName(inner)) {
    if (SelectAllNode.is(inner.column)) return SelectionNode.createSelectAll()
    return SelectionNode.create(inner.column)
  }
  if (AliasNode.is(inner) && ReferenceNode.is(inner.node) && pseudoTableName(inner.node) && !SelectAllNode.is(inner.node.column))
    return SelectionNode.create(AliasNode.create(inner.node.column, inner.alias))
  throw new Error('SQLite: OUTPUT unterstützt nur Spalten von inserted/deleted')
}

function outputToReturning<T extends { output?: OutputNode, returning?: ReturningNode }>(node: T): T {
  if (!node.output) return node
  if (node.returning) throw new Error('SQLite: OUTPUT und RETURNING zusammen werden nicht unterstützt')
  return { ...node, output: undefined, returning: ReturningNode.create(node.output.selections.map(stripPseudoTable)) }
}

class SqliteCompatTransformer extends OperationNodeTransformer {
  /** `core.users` → `core_users` */
  protected override transformSchemableIdentifier(node: SchemableIdentifierNode, queryId?: QueryId): SchemableIdentifierNode {
    const transformed = super.transformSchemableIdentifier(node, queryId)
    if (!transformed.schema) return transformed
    return SchemableIdentifierNode.create(`${transformed.schema.name}_${transformed.identifier.name}`)
  }

  /** TOP n → LIMIT n; OFFSET x ROWS FETCH NEXT n ROWS ONLY → LIMIT n OFFSET x */
  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    const transformed = super.transformSelectQuery(node, queryId)
    let result: SelectQueryNode = transformed
    if (transformed.top) {
      if (transformed.top.modifiers) throw new Error(`SQLite: TOP … ${transformed.top.modifiers} wird nicht unterstützt`)
      if (transformed.limit || transformed.fetch) throw new Error('SQLite: TOP zusammen mit LIMIT/FETCH wird nicht unterstützt')
      result = { ...result, top: undefined, limit: LimitNode.create(ValueNode.createImmediate(transformed.top.expression)) }
    }
    if (transformed.fetch) {
      if (transformed.fetch.modifier !== 'only') throw new Error('SQLite: FETCH … WITH TIES wird nicht unterstützt')
      if (transformed.limit) throw new Error('SQLite: FETCH zusammen mit LIMIT wird nicht unterstützt')
      result = { ...result, fetch: undefined, limit: LimitNode.create(transformed.fetch.rowCount) }
    }
    // SQLite verlangt zu OFFSET ein LIMIT (-1 = unbegrenzt)
    if (result.offset && !result.limit) result = { ...result, limit: LimitNode.create(ValueNode.createImmediate(-1)) }
    return result
  }

  protected override transformInsertQuery(node: InsertQueryNode, queryId?: QueryId): InsertQueryNode {
    return outputToReturning(super.transformInsertQuery(node, queryId))
  }

  protected override transformUpdateQuery(node: UpdateQueryNode, queryId?: QueryId): UpdateQueryNode {
    const transformed = outputToReturning(super.transformUpdateQuery(node, queryId))
    if (transformed.top) throw new Error('SQLite: UPDATE TOP wird nicht unterstützt')
    return transformed
  }

  protected override transformDeleteQuery(node: DeleteQueryNode, queryId?: QueryId): DeleteQueryNode {
    const transformed = outputToReturning(super.transformDeleteQuery(node, queryId))
    if (transformed.top) throw new Error('SQLite: DELETE TOP wird nicht unterstützt')
    return transformed
  }
}

/** Übersetzt Schemas, TOP/FETCH und OUTPUT für SQLite */
export class SqliteCompatPlugin implements KyselyPlugin {
  readonly #transformer = new SqliteCompatTransformer()

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node, args.queryId)
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result
  }
}

/**
 * Transaktionen beginnen mit BEGIN IMMEDIATE: Sie holen die Schreibsperre sofort (kein SQLITE_BUSY beim späteren
 * Hochstufen einer Lesetransaktion) und reihen einen zweiten Prozess ein – so auch zwei gleichzeitig startende
 * Migrationen.
 */
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'))
  }
}

/**
 * SQLite kann DDL in Transaktionen. Kyselys Adapter meldet das nicht, dann liefe jede Migration Anweisung für
 * Anweisung ohne Transaktion: Ein Fehler mittendrin hinterließe halbe Migrationen, die jeder Neustart erneut anstößt.
 */
class TransactionalSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true
  }
}

class NodeSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig

  constructor(config: SqliteDialectConfig) {
    super(config)
    this.#config = config
  }

  override createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#config)
  }

  override createAdapter(): DialectAdapter {
    return new TransactionalSqliteAdapter()
  }
}

/** Kysely-Client für eine SQLite-Datei; die Datei wird erst bei der ersten Abfrage geöffnet */
export function createSqliteDatabase<DB>(path: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new NodeSqliteDialect({ database: async () => new NodeSqliteDatabase(openSqliteFile(path)) }),
    plugins: [new SqliteCompatPlugin(), new CamelCasePlugin()],
  })
}
