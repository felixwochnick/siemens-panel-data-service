import type { ColumnType, Generated } from 'kysely'
import type { CoreDatabase } from '@pds/core/database'
import type { AnalysisStage, AnalysisStatus, AnalysisTrigger, FileKind, LogLevel, ProjectSource } from '../../shared/types/api'

/** Zeitpunkt mit Standardwert der Datenbank, im Code optional überschreibbar */
type DefaultNow = ColumnType<Date, Date | undefined, Date>

/**
 * Fortlaufende 64-Bit-ID (bigint): SQL Server liefert sie als Text (tedious), SQLite als Zahl. Nach außen immer als
 * Text (`String(id)`), damit API und MCP mit beiden Datenbanken gleich aussehen.
 */
type BigIntId = Generated<string | number>

/** Spalte, die beim Anlegen fehlen darf (NULL bzw. Standardwert) */
type Optional<T> = ColumnType<T, T | undefined, T>

export interface SettingsTable {
  /** immer 1 (genau eine Zeile) */
  id: number
  /** JSON der PdsSettings; Netzlaufwerk-Passwort als `enc:v1:…` */
  data: string
  updatedAt: DefaultNow
  updatedBy: string | null
}

export interface ProjectsTable {
  id: Generated<number>
  source: ProjectSource
  /** ohne Endung */
  name: string
  /** folder: relativ zum Projektordner; upload: NULL */
  path: string | null
  /** eindeutig je Quelle: kleingeschriebener Pfad (Trennzeichen /) bzw. Name */
  pathKey: string
  fileKind: FileKind
  /** upload: neueste hochgeladene Datei, relativ zu uploads/<projectId>/ */
  uploadFile: Optional<string | null>
  sourceModified: Optional<Date | null>
  /** neueste erfolgreiche Analyse */
  currentAnalysisId: Optional<number | null>
  createdAt: DefaultNow
  createdBy: string | null
  updatedAt: DefaultNow
}

export interface AnalysesTable {
  id: Generated<number>
  projectId: number
  trigger: AnalysisTrigger
  triggeredBy: string | null
  status: Optional<AnalysisStatus>
  stage: Optional<AnalysisStage | null>
  queuedAt: DefaultNow
  startedAt: Optional<Date | null>
  finishedAt: Optional<Date | null>
  /** upload: analysierte Datei (relativ zu uploads/<projectId>/) */
  uploadFile: Optional<string | null>
  sourceModified: Optional<Date | null>
  eplanProjectName: Optional<string | null>
  eplanVersion: Optional<string | null>
  workerVersion: Optional<string | null>
  countConnections: Optional<number | null>
  countHashMarks: Optional<number | null>
  countUnmatchedHashMarks: Optional<number | null>
  countTwisted: Optional<number | null>
  countTwistSymbols: Optional<number | null>
  countUnmatchedTwistTicks: Optional<number | null>
  countShielded: Optional<number | null>
  countShields: Optional<number | null>
  countCables: Optional<number | null>
  countTexts: Optional<number | null>
  countPages: Optional<number | null>
  errorCode: Optional<string | null>
  errorDetail: Optional<string | null>
}

export interface AnalysisEventsTable {
  id: BigIntId
  analysisId: number
  at: Date
  level: LogLevel
  code: string
  /** JSON */
  params: string | null
  detail: string | null
}

export interface ConnectionsTable {
  analysisId: number
  idx: number
  /** StorableObject.ToStringIdentifier(): nur innerhalb einer Analyse eindeutig, über Stände hinweg nicht stabil */
  eplanId: string
  page: string
  definition: string
  designation: string
  source: string
  destination: string
  cable: string
  wireNumber: string
  crossSection: string
  wireType: string
  length: string
  partNumbers: string
  hashMark: boolean
  twisted: boolean
  shielded: boolean
}

export interface CablesTable {
  analysisId: number
  idx: number
  kind: 'cable' | 'shield'
  name: string
  definition: string
  page: string
  source: string
  destination: string
  type: string
  wireCountAndCrossSection: string
  length: string
  partNumbers: string
}

export interface CableWiresTable {
  analysisId: number
  cableIdx: number
  idx: number
  connectionIdx: number | null
  definition: string
  page: string
  source: string
  destination: string
  length: string
  wireNumber: string
  crossSection: string
  partNumbers: string
}

export interface ShieldsTable {
  analysisId: number
  idx: number
  page: string
  name: string
  type: string
  wireCountAndCrossSection: string
}

export interface ShieldWiresTable {
  analysisId: number
  shieldIdx: number
  idx: number
  connectionIdx: number
}

export interface TextsTable {
  analysisId: number
  idx: number
  page: string
  text: string
}

export interface AuditTable {
  id: BigIntId
  at: DefaultNow
  userId: string | null
  action: string
  /** JSON, ohne Geheimnisse */
  details: string | null
}

/** Spalten jeder Sicht v_current_* (aktueller Stand je Projekt) */
interface CurrentView {
  projectId: number
  projectName: string
}

/** Fachtabellen und Sichten (Schema `pds`) */
export interface PdsTables {
  'pds.settings': SettingsTable
  'pds.projects': ProjectsTable
  'pds.analyses': AnalysesTable
  'pds.analysisEvents': AnalysisEventsTable
  'pds.connections': ConnectionsTable
  'pds.cables': CablesTable
  'pds.cableWires': CableWiresTable
  'pds.shields': ShieldsTable
  'pds.shieldWires': ShieldWiresTable
  'pds.texts': TextsTable
  'pds.audit': AuditTable
  'pds.vCurrentConnections': CurrentView & ConnectionsTable
  'pds.vCurrentCables': CurrentView & CablesTable
  'pds.vCurrentCableWires': CurrentView & CableWiresTable & { cableName: string }
  'pds.vCurrentShields': CurrentView & ShieldsTable
  'pds.vCurrentShieldWires': CurrentView & ShieldWiresTable & { shieldName: string }
  'pds.vCurrentTexts': CurrentView & TextsTable
}

export type AppDatabase = CoreDatabase & PdsTables
