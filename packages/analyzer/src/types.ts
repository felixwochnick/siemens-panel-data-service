// Vertrag zwischen EPLAN-Worker (worker/) und Auswertung, siehe
// docs/superpowers/specs/2026-11-23-pds-monorepo-design.md, Abschnitt „Rohdaten“.
// Der Worker liest nur; jede Entscheidung (Zuordnung, Zeilenaufbau) trifft analyze().

export const RAW_FORMAT = 1

/** Punkt auf einer Seite in mm (Seitenkoordinaten, y wächst nach oben) */
export interface RawPagePoint {
  page: string
  x: number
  y: number
}

export interface RawPage {
  name: string
  /** Automatisch erzeugte Auswertungsseite (Page.ReportBlock != null) */
  isReport: boolean
}

/** Anschluss einer Verbindung (StartPin/EndPin) */
export interface RawPin {
  /** ParentFunction.Name; "" ohne Funktion */
  functionName: string
  /** Pin.Name, z. B. "1/L1" oder "B" */
  pinName: string
  /** Pin.Designation (Nummer des Symbolanschlusses) */
  pinDesignation: string
  /** FUNC_PLCPLUG_DESIGNATION_AUTOMATIC der Funktion */
  plugAutomatic: string
  /** FUNC_PLCPLUG_DESIGNATION_MANUAL der Funktion */
  plugManual: string
  /** ParentFunction ist ein Schirm (Shield) */
  parentIsShield: boolean
}

/** Gerätesymbol am Ende einer Verbindung: Ursprung des Symbols und Anschlusspunkt relativ dazu */
export interface RawSymbolEnd extends RawPagePoint {
  pinX: number
  pinY: number
}

export interface RawCableRef {
  name: string
  /** FUNC_CABLETYPE, z. B. "GSC-01" */
  type: string
  /** FUNC_CABLEWIRECOUNTANDCROSSSECTION, z. B. "4x0,22" */
  wireCountAndCrossSection: string
}

export interface RawShieldRef extends RawPagePoint {
  name: string
}

export interface RawConnection {
  /** StorableObject.ToStringIdentifier() */
  id: string
  /** Connection3D (Schaltschrankaufbau, Doppelung der Schaltplan-Verbindung) */
  is3d: boolean
  page: string
  /** Name der Funktionsdefinition, z. B. "Ader / Draht" */
  definition: string
  /** CONNECTION_DESIGNATION */
  designation: string
  /** CONNECTION_SOURCE (wie im Verbindungsnavigator), "" wenn leer */
  sourceProperty: string
  /** CONNECTION_DESTINATION */
  destinationProperty: string
  /** CONNECTION_WIRENUMBER (Farbe/Nummer) */
  wireNumber: string
  /** CONNECTION_WIRECROSSSECTION_WITH_UNIT */
  crossSection: string
  /** CONNECTION_WIRETYPE */
  wireType: string
  /** CONNECTION_WIRELENGTH_FULL */
  length: string
  /** ArticleReferences[].PartNr, nicht leer, Reihenfolge der API */
  partNumbers: string[]
  /** CableDefinitionLine */
  cable: RawCableRef | null
  start: RawPin | null
  end: RawPin | null
  /** Connection.Shieldings */
  shieldings: RawShieldRef[]
  /** SymbolReferences in API-Reihenfolge (Gerät, Winkel, Unterbrechungsstelle, …) */
  symbols: RawPagePoint[]
  startSymbol: RawSymbolEnd | null
  endSymbol: RawSymbolEnd | null
}

export interface RawText extends RawPagePoint {
  /** Deutsch, sonst sprachneutral, sonst Englisch; getrimmt */
  content: string
  /** Ecken von GetBoundingBox(); [] wenn unlesbar */
  box: [number, number][]
  /** Text gehört zu keiner Gruppe (Symbol, Makro, Gerätegrafik) */
  free: boolean
}

export interface RawLine {
  page: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface RawShield extends RawPagePoint {
  name: string
  /** SymbolVariant.VariantNr: 0 rechts, 1 oben, 2 links, 3 unten, sonst gespiegelt; -1 unlesbar */
  variant: number
  /** RECTANGLE_WIDTH in mm, null wenn unlesbar */
  width: number | null
  /** RECTANGLE_HEIGHT in mm, null wenn unlesbar */
  height: number | null
}

export interface RawCableDefinition extends RawPagePoint {
  kind: 'cable' | 'shield'
  name: string
  definition: string
  /** FUNC_CABLE_SOURCE */
  sourceProperty: string
  /** FUNC_CABLE_DESTINATION */
  destinationProperty: string
  type: string
  wireCountAndCrossSection: string
  /** FUNC_CABLELENGTH_FULL */
  length: string
  partNumbers: string[]
  /** Kabel: CableConnections; Schirm: Pins[].Connections – als RawConnection.id, entdoppelt */
  wires: string[]
}

export interface RawProject {
  format: typeof RAW_FORMAT
  worker: string
  eplanVersion: string
  project: { name: string, pageCount: number }
  pages: RawPage[]
  connections: RawConnection[]
  texts: RawText[]
  lines: RawLine[]
  shields: RawShield[]
  cableDefinitions: RawCableDefinition[]
}

// ── Ergebnis ──────────────────────────────────────────────────────────────────

export interface ConnectionRow {
  idx: number
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
  /** ", "-getrennt, entdoppelt */
  partNumbers: string
  hashMark: boolean
  twisted: boolean
  shielded: boolean
}

export interface CableWireRow {
  idx: number
  /** Index in AnalysisResult.connections; null bei 3D-Verbindung oder unbekannter id */
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

/** Kabel bzw. Schirm wie im EPLAN Kabelnavigator */
export interface CableRow {
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
  wires: CableWireRow[]
}

/** Blatt „Schirme“: Schirmsymbol oder geschirmtes Kabel (GSC…) mit den abgeschirmten Adern */
export interface ShieldRow {
  idx: number
  page: string
  name: string
  type: string
  wireCountAndCrossSection: string
  /** Indizes in AnalysisResult.connections, aufsteigend */
  connectionIdx: number[]
}

export interface TextRow {
  idx: number
  page: string
  text: string
}

export interface AnalysisCounts {
  connections: number
  hashMarks: number
  unmatchedHashMarks: number
  twisted: number
  twistSymbols: number
  unmatchedTwistTicks: number
  shielded: number
  shields: number
  cables: number
  texts: number
  pages: number
}

export interface AnalyzerNotice {
  level: 'info' | 'warn'
  /** snake_case, übersetzt in der App unter analysisEvents.<code> */
  code: string
  params?: Record<string, string | number>
}

export interface AnalysisResult {
  connections: ConnectionRow[]
  cables: CableRow[]
  shields: ShieldRow[]
  texts: TextRow[]
  counts: AnalysisCounts
  notices: AnalyzerNotice[]
}
