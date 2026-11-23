import type { MigrationSet } from '@pds/core/database'
import { SQLITE_NOW, sqliteSql, tsql } from '@pds/core/database'

const now = (table: string, column: string) => `${column} datetime2(3) NOT NULL CONSTRAINT df_${table}_${column} DEFAULT SYSUTCDATETIME()`

/** Spalten einer Ergebnis-Tabelle; Texte aus EPLAN ohne Längengrenze (Eigenschaften können beliebig lang sein) */
const MSSQL_CONNECTION_COLUMNS = `
        eplan_id nvarchar(max) NOT NULL,
        page nvarchar(max) NOT NULL,
        definition nvarchar(max) NOT NULL,
        designation nvarchar(max) NOT NULL,
        source nvarchar(max) NOT NULL,
        destination nvarchar(max) NOT NULL,
        cable nvarchar(max) NOT NULL,
        wire_number nvarchar(max) NOT NULL,
        cross_section nvarchar(max) NOT NULL,
        wire_type nvarchar(max) NOT NULL,
        length nvarchar(max) NOT NULL,
        part_numbers nvarchar(max) NOT NULL,
        hash_mark bit NOT NULL,
        twisted bit NOT NULL,
        shielded bit NOT NULL,`

const SQLITE_CONNECTION_COLUMNS = `
        eplan_id text NOT NULL,
        page text NOT NULL,
        definition text NOT NULL,
        designation text NOT NULL,
        source text NOT NULL,
        destination text NOT NULL,
        cable text NOT NULL,
        wire_number text NOT NULL,
        cross_section text NOT NULL,
        wire_type text NOT NULL,
        length text NOT NULL,
        part_numbers text NOT NULL,
        hash_mark boolean NOT NULL,
        twisted boolean NOT NULL,
        shielded boolean NOT NULL,`

/** Zählerspalten der Analyse (AnalysisCounts), NULL bis zum Erfolg */
const COUNT_COLUMNS = [
  'count_connections',
  'count_hash_marks',
  'count_unmatched_hash_marks',
  'count_twisted',
  'count_twist_symbols',
  'count_unmatched_twist_ticks',
  'count_shielded',
  'count_shields',
  'count_cables',
  'count_texts',
  'count_pages',
]

/**
 * Sichten für die Weiterverarbeitung durch andere Systeme: nur der aktuelle Stand je Projekt
 * (projects.current_analysis_id = neueste erfolgreiche Analyse). `s` ist das Schema-Präfix (`pds.` bzw. `pds_`).
 */
function views(s: string): string[] {
  const head = `p.id AS project_id, p.name AS project_name`
  return [
    `CREATE VIEW ${s}v_current_connections AS
      SELECT ${head}, c.analysis_id, c.idx, c.eplan_id, c.page, c.definition, c.designation, c.source, c.destination, c.cable,
        c.wire_number, c.cross_section, c.wire_type, c.length, c.part_numbers, c.hash_mark, c.twisted, c.shielded
      FROM ${s}projects p INNER JOIN ${s}connections c ON c.analysis_id = p.current_analysis_id`,
    `CREATE VIEW ${s}v_current_cables AS
      SELECT ${head}, c.analysis_id, c.idx, c.kind, c.name, c.definition, c.page, c.source, c.destination, c.type,
        c.wire_count_and_cross_section, c.length, c.part_numbers
      FROM ${s}projects p INNER JOIN ${s}cables c ON c.analysis_id = p.current_analysis_id`,
    `CREATE VIEW ${s}v_current_cable_wires AS
      SELECT ${head}, w.analysis_id, w.cable_idx, c.name AS cable_name, w.idx, w.connection_idx, w.definition, w.page,
        w.source, w.destination, w.length, w.wire_number, w.cross_section, w.part_numbers
      FROM ${s}projects p
        INNER JOIN ${s}cable_wires w ON w.analysis_id = p.current_analysis_id
        INNER JOIN ${s}cables c ON c.analysis_id = w.analysis_id AND c.idx = w.cable_idx`,
    `CREATE VIEW ${s}v_current_shields AS
      SELECT ${head}, sh.analysis_id, sh.idx, sh.page, sh.name, sh.type, sh.wire_count_and_cross_section
      FROM ${s}projects p INNER JOIN ${s}shields sh ON sh.analysis_id = p.current_analysis_id`,
    `CREATE VIEW ${s}v_current_shield_wires AS
      SELECT ${head}, w.analysis_id, w.shield_idx, sh.name AS shield_name, w.idx, w.connection_idx
      FROM ${s}projects p
        INNER JOIN ${s}shield_wires w ON w.analysis_id = p.current_analysis_id
        INNER JOIN ${s}shields sh ON sh.analysis_id = w.analysis_id AND sh.idx = w.shield_idx`,
    `CREATE VIEW ${s}v_current_texts AS
      SELECT ${head}, t.analysis_id, t.idx, t.page, t.text
      FROM ${s}projects p INNER JOIN ${s}texts t ON t.analysis_id = p.current_analysis_id`,
  ]
}

/*
 * Schema `pds`: Einstellungen (eine Zeile), Projekte, Analysen (Stände) mit Ereignissen, Ergebnisse je Analyse,
 * Änderungsprotokoll. Ergebnisse hängen per Cascade an der Analyse, Analysen am Projekt; Adern an ihrem Kabel bzw.
 * Schirm (SQL Server erlaubt keine zwei Cascade-Wege zur selben Tabelle). Verweise auf core.users sind SET NULL:
 * Benutzer dürfen verschwinden, der Verlauf bleibt. projects.current_analysis_id verweist ohne Aktion auf die Analyse
 * (ein Kreis aus Cascades ist in SQL Server verboten); die Dienste setzen ihn vor dem Löschen zurück.
 * `trigger` ist in T-SQL reserviert und steht deshalb in eckigen Klammern (Kysely quotet ohnehin).
 */
export const pdsMigrations: MigrationSet = {
  schema: 'pds',
  mssql: {
    '0001_init': tsql(
      `CREATE TABLE pds.settings (
        id int NOT NULL,
        data nvarchar(max) NOT NULL,
        ${now('settings', 'updated_at')},
        updated_by uniqueidentifier NULL,
        CONSTRAINT pk_settings PRIMARY KEY (id),
        CONSTRAINT ck_settings_single_row CHECK (id = 1),
        CONSTRAINT ck_settings_data CHECK (ISJSON(data) = 1),
        CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES core.users (id) ON DELETE SET NULL
      )`,
      // path_key: kleingeschriebener Pfad (folder, Trennzeichen /) bzw. Name (upload); eindeutig je Quelle.
      // 800 Zeichen: Schlüssel eines Index höchstens 1700 Byte
      `CREATE TABLE pds.projects (
        id int IDENTITY(1, 1) NOT NULL,
        source varchar(10) NOT NULL,
        name nvarchar(400) NOT NULL,
        path nvarchar(800) NULL,
        path_key nvarchar(800) NOT NULL,
        file_kind varchar(3) NOT NULL,
        upload_file nvarchar(600) NULL,
        source_modified datetime2(3) NULL,
        current_analysis_id int NULL,
        ${now('projects', 'created_at')},
        created_by uniqueidentifier NULL,
        ${now('projects', 'updated_at')},
        CONSTRAINT pk_projects PRIMARY KEY (id),
        CONSTRAINT uq_projects_source_path_key UNIQUE (source, path_key),
        CONSTRAINT ck_projects_source CHECK (source IN ('upload', 'folder')),
        CONSTRAINT ck_projects_file_kind CHECK (file_kind IN ('elk', 'zw1')),
        CONSTRAINT ck_projects_path CHECK ((source = 'folder' AND path IS NOT NULL) OR (source = 'upload' AND path IS NULL)),
        CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES core.users (id) ON DELETE SET NULL
      )`,
      `CREATE TABLE pds.analyses (
        id int IDENTITY(1, 1) NOT NULL,
        project_id int NOT NULL,
        [trigger] varchar(10) NOT NULL,
        triggered_by uniqueidentifier NULL,
        status varchar(10) NOT NULL CONSTRAINT df_analyses_status DEFAULT 'queued',
        stage varchar(30) NULL,
        ${now('analyses', 'queued_at')},
        started_at datetime2(3) NULL,
        finished_at datetime2(3) NULL,
        upload_file nvarchar(600) NULL,
        source_modified datetime2(3) NULL,
        eplan_project_name nvarchar(400) NULL,
        eplan_version varchar(50) NULL,
        worker_version varchar(50) NULL,
        ${COUNT_COLUMNS.map(c => `${c} int NULL`).join(',\n        ')},
        error_code varchar(50) NULL,
        error_detail nvarchar(2000) NULL,
        CONSTRAINT pk_analyses PRIMARY KEY (id),
        CONSTRAINT fk_analyses_project FOREIGN KEY (project_id) REFERENCES pds.projects (id) ON DELETE CASCADE,
        CONSTRAINT fk_analyses_triggered_by FOREIGN KEY (triggered_by) REFERENCES core.users (id) ON DELETE SET NULL,
        CONSTRAINT ck_analyses_trigger CHECK ([trigger] IN ('upload', 'manual', 'schedule', 'mcp')),
        CONSTRAINT ck_analyses_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'aborted'))
      )`,
      'CREATE INDEX ix_analyses_project_status ON pds.analyses (project_id, status)',
      'CREATE INDEX ix_analyses_status_queued_at ON pds.analyses (status, queued_at, id)',
      'CREATE INDEX ix_analyses_queued_at ON pds.analyses (queued_at DESC)',
      'CREATE INDEX ix_analyses_finished_at ON pds.analyses (finished_at)',
      // Höchstens ein offener Auftrag je Projekt und eine laufende Analyse insgesamt – auch über Prozesse hinweg
      'CREATE UNIQUE INDEX uq_analyses_open_project ON pds.analyses (project_id) WHERE status IN (\'queued\', \'running\')',
      'CREATE UNIQUE INDEX uq_analyses_single_running ON pds.analyses (status) WHERE status = \'running\'',
      `ALTER TABLE pds.projects ADD CONSTRAINT fk_projects_current_analysis
        FOREIGN KEY (current_analysis_id) REFERENCES pds.analyses (id)`,
      'CREATE INDEX ix_projects_current_analysis ON pds.projects (current_analysis_id)',
      `CREATE TABLE pds.analysis_events (
        id bigint IDENTITY(1, 1) NOT NULL,
        analysis_id int NOT NULL,
        at datetime2(3) NOT NULL,
        level varchar(5) NOT NULL,
        code varchar(100) NOT NULL,
        params nvarchar(max) NULL,
        detail nvarchar(2000) NULL,
        CONSTRAINT pk_analysis_events PRIMARY KEY (id),
        CONSTRAINT fk_analysis_events_analysis FOREIGN KEY (analysis_id) REFERENCES pds.analyses (id) ON DELETE CASCADE,
        CONSTRAINT ck_analysis_events_level CHECK (level IN ('debug', 'info', 'warn', 'error')),
        CONSTRAINT ck_analysis_events_params CHECK (params IS NULL OR ISJSON(params) = 1)
      )`,
      'CREATE INDEX ix_analysis_events_analysis ON pds.analysis_events (analysis_id, id)',
      `CREATE TABLE pds.connections (
        analysis_id int NOT NULL,
        idx int NOT NULL,${MSSQL_CONNECTION_COLUMNS}
        CONSTRAINT pk_connections PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_connections_analysis FOREIGN KEY (analysis_id) REFERENCES pds.analyses (id) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds.cables (
        analysis_id int NOT NULL,
        idx int NOT NULL,
        kind varchar(10) NOT NULL,
        name nvarchar(max) NOT NULL,
        definition nvarchar(max) NOT NULL,
        page nvarchar(max) NOT NULL,
        source nvarchar(max) NOT NULL,
        destination nvarchar(max) NOT NULL,
        [type] nvarchar(max) NOT NULL,
        wire_count_and_cross_section nvarchar(max) NOT NULL,
        length nvarchar(max) NOT NULL,
        part_numbers nvarchar(max) NOT NULL,
        CONSTRAINT pk_cables PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_cables_analysis FOREIGN KEY (analysis_id) REFERENCES pds.analyses (id) ON DELETE CASCADE,
        CONSTRAINT ck_cables_kind CHECK (kind IN ('cable', 'shield'))
      )`,
      `CREATE TABLE pds.cable_wires (
        analysis_id int NOT NULL,
        cable_idx int NOT NULL,
        idx int NOT NULL,
        connection_idx int NULL,
        definition nvarchar(max) NOT NULL,
        page nvarchar(max) NOT NULL,
        source nvarchar(max) NOT NULL,
        destination nvarchar(max) NOT NULL,
        length nvarchar(max) NOT NULL,
        wire_number nvarchar(max) NOT NULL,
        cross_section nvarchar(max) NOT NULL,
        part_numbers nvarchar(max) NOT NULL,
        CONSTRAINT pk_cable_wires PRIMARY KEY (analysis_id, cable_idx, idx),
        CONSTRAINT fk_cable_wires_cable FOREIGN KEY (analysis_id, cable_idx) REFERENCES pds.cables (analysis_id, idx) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds.shields (
        analysis_id int NOT NULL,
        idx int NOT NULL,
        page nvarchar(max) NOT NULL,
        name nvarchar(max) NOT NULL,
        [type] nvarchar(max) NOT NULL,
        wire_count_and_cross_section nvarchar(max) NOT NULL,
        CONSTRAINT pk_shields PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_shields_analysis FOREIGN KEY (analysis_id) REFERENCES pds.analyses (id) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds.shield_wires (
        analysis_id int NOT NULL,
        shield_idx int NOT NULL,
        idx int NOT NULL,
        connection_idx int NOT NULL,
        CONSTRAINT pk_shield_wires PRIMARY KEY (analysis_id, shield_idx, idx),
        CONSTRAINT fk_shield_wires_shield FOREIGN KEY (analysis_id, shield_idx) REFERENCES pds.shields (analysis_id, idx) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds.texts (
        analysis_id int NOT NULL,
        idx int NOT NULL,
        page nvarchar(max) NOT NULL,
        [text] nvarchar(max) NOT NULL,
        CONSTRAINT pk_texts PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_texts_analysis FOREIGN KEY (analysis_id) REFERENCES pds.analyses (id) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds.audit (
        id bigint IDENTITY(1, 1) NOT NULL,
        ${now('audit', 'at')},
        user_id uniqueidentifier NULL,
        action varchar(50) NOT NULL,
        details nvarchar(max) NULL,
        CONSTRAINT pk_audit PRIMARY KEY (id),
        CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES core.users (id) ON DELETE SET NULL,
        CONSTRAINT ck_audit_details CHECK (details IS NULL OR ISJSON(details) = 1)
      )`,
      'CREATE INDEX ix_audit_at ON pds.audit (at DESC)',
      ...views('pds.'),
    ),
  },
  /*
   * SQLite: Tabellen als pds_<tabelle>, gleicher Endstand. Namen vergleichen wie unter SQL Server ohne Rücksicht auf
   * Groß-/Kleinschreibung (NOCASE); path_key ist ohnehin kleingeschrieben.
   */
  sqlite: {
    '0001_init': sqliteSql(
      `CREATE TABLE pds_settings (
        id integer NOT NULL,
        data text NOT NULL,
        updated_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        updated_by text NULL,
        CONSTRAINT pk_settings PRIMARY KEY (id),
        CONSTRAINT ck_settings_single_row CHECK (id = 1),
        CONSTRAINT ck_settings_data CHECK (json_valid(data)),
        CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES core_users (id) ON DELETE SET NULL
      )`,
      `CREATE TABLE pds_projects (
        id integer NOT NULL CONSTRAINT pk_projects PRIMARY KEY AUTOINCREMENT,
        source text NOT NULL,
        name text NOT NULL COLLATE NOCASE,
        path text NULL,
        path_key text NOT NULL,
        file_kind text NOT NULL,
        upload_file text NULL,
        source_modified datetime NULL,
        current_analysis_id integer NULL,
        created_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        created_by text NULL,
        updated_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        CONSTRAINT uq_projects_source_path_key UNIQUE (source, path_key),
        CONSTRAINT ck_projects_source CHECK (source IN ('upload', 'folder')),
        CONSTRAINT ck_projects_file_kind CHECK (file_kind IN ('elk', 'zw1')),
        CONSTRAINT ck_projects_path CHECK ((source = 'folder' AND path IS NOT NULL) OR (source = 'upload' AND path IS NULL)),
        CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES core_users (id) ON DELETE SET NULL,
        CONSTRAINT fk_projects_current_analysis FOREIGN KEY (current_analysis_id) REFERENCES pds_analyses (id)
      )`,
      'CREATE INDEX ix_projects_current_analysis ON pds_projects (current_analysis_id)',
      `CREATE TABLE pds_analyses (
        id integer NOT NULL CONSTRAINT pk_analyses PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        "trigger" text NOT NULL,
        triggered_by text NULL,
        status text NOT NULL DEFAULT 'queued',
        stage text NULL,
        queued_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        started_at datetime NULL,
        finished_at datetime NULL,
        upload_file text NULL,
        source_modified datetime NULL,
        eplan_project_name text NULL,
        eplan_version text NULL,
        worker_version text NULL,
        ${COUNT_COLUMNS.map(c => `${c} integer NULL`).join(',\n        ')},
        error_code text NULL,
        error_detail text NULL,
        CONSTRAINT fk_analyses_project FOREIGN KEY (project_id) REFERENCES pds_projects (id) ON DELETE CASCADE,
        CONSTRAINT fk_analyses_triggered_by FOREIGN KEY (triggered_by) REFERENCES core_users (id) ON DELETE SET NULL,
        CONSTRAINT ck_analyses_trigger CHECK ("trigger" IN ('upload', 'manual', 'schedule', 'mcp')),
        CONSTRAINT ck_analyses_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'aborted'))
      )`,
      'CREATE INDEX ix_analyses_project_status ON pds_analyses (project_id, status)',
      'CREATE INDEX ix_analyses_status_queued_at ON pds_analyses (status, queued_at, id)',
      'CREATE INDEX ix_analyses_queued_at ON pds_analyses (queued_at DESC)',
      'CREATE INDEX ix_analyses_finished_at ON pds_analyses (finished_at)',
      'CREATE UNIQUE INDEX uq_analyses_open_project ON pds_analyses (project_id) WHERE status IN (\'queued\', \'running\')',
      'CREATE UNIQUE INDEX uq_analyses_single_running ON pds_analyses (status) WHERE status = \'running\'',
      `CREATE TABLE pds_analysis_events (
        id integer NOT NULL CONSTRAINT pk_analysis_events PRIMARY KEY AUTOINCREMENT,
        analysis_id integer NOT NULL,
        at datetime NOT NULL,
        level text NOT NULL,
        code text NOT NULL,
        params text NULL,
        detail text NULL,
        CONSTRAINT fk_analysis_events_analysis FOREIGN KEY (analysis_id) REFERENCES pds_analyses (id) ON DELETE CASCADE,
        CONSTRAINT ck_analysis_events_level CHECK (level IN ('debug', 'info', 'warn', 'error')),
        CONSTRAINT ck_analysis_events_params CHECK (params IS NULL OR json_valid(params))
      )`,
      'CREATE INDEX ix_analysis_events_analysis ON pds_analysis_events (analysis_id, id)',
      `CREATE TABLE pds_connections (
        analysis_id integer NOT NULL,
        idx integer NOT NULL,${SQLITE_CONNECTION_COLUMNS}
        CONSTRAINT pk_connections PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_connections_analysis FOREIGN KEY (analysis_id) REFERENCES pds_analyses (id) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds_cables (
        analysis_id integer NOT NULL,
        idx integer NOT NULL,
        kind text NOT NULL,
        name text NOT NULL,
        definition text NOT NULL,
        page text NOT NULL,
        source text NOT NULL,
        destination text NOT NULL,
        "type" text NOT NULL,
        wire_count_and_cross_section text NOT NULL,
        length text NOT NULL,
        part_numbers text NOT NULL,
        CONSTRAINT pk_cables PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_cables_analysis FOREIGN KEY (analysis_id) REFERENCES pds_analyses (id) ON DELETE CASCADE,
        CONSTRAINT ck_cables_kind CHECK (kind IN ('cable', 'shield'))
      )`,
      `CREATE TABLE pds_cable_wires (
        analysis_id integer NOT NULL,
        cable_idx integer NOT NULL,
        idx integer NOT NULL,
        connection_idx integer NULL,
        definition text NOT NULL,
        page text NOT NULL,
        source text NOT NULL,
        destination text NOT NULL,
        length text NOT NULL,
        wire_number text NOT NULL,
        cross_section text NOT NULL,
        part_numbers text NOT NULL,
        CONSTRAINT pk_cable_wires PRIMARY KEY (analysis_id, cable_idx, idx),
        CONSTRAINT fk_cable_wires_cable FOREIGN KEY (analysis_id, cable_idx) REFERENCES pds_cables (analysis_id, idx) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds_shields (
        analysis_id integer NOT NULL,
        idx integer NOT NULL,
        page text NOT NULL,
        name text NOT NULL,
        "type" text NOT NULL,
        wire_count_and_cross_section text NOT NULL,
        CONSTRAINT pk_shields PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_shields_analysis FOREIGN KEY (analysis_id) REFERENCES pds_analyses (id) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds_shield_wires (
        analysis_id integer NOT NULL,
        shield_idx integer NOT NULL,
        idx integer NOT NULL,
        connection_idx integer NOT NULL,
        CONSTRAINT pk_shield_wires PRIMARY KEY (analysis_id, shield_idx, idx),
        CONSTRAINT fk_shield_wires_shield FOREIGN KEY (analysis_id, shield_idx) REFERENCES pds_shields (analysis_id, idx) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds_texts (
        analysis_id integer NOT NULL,
        idx integer NOT NULL,
        page text NOT NULL,
        "text" text NOT NULL,
        CONSTRAINT pk_texts PRIMARY KEY (analysis_id, idx),
        CONSTRAINT fk_texts_analysis FOREIGN KEY (analysis_id) REFERENCES pds_analyses (id) ON DELETE CASCADE
      )`,
      `CREATE TABLE pds_audit (
        id integer NOT NULL CONSTRAINT pk_audit PRIMARY KEY AUTOINCREMENT,
        at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        user_id text NULL,
        action text NOT NULL,
        details text NULL,
        CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES core_users (id) ON DELETE SET NULL,
        CONSTRAINT ck_audit_details CHECK (details IS NULL OR json_valid(details))
      )`,
      'CREATE INDEX ix_audit_at ON pds_audit (at DESC)',
      ...views('pds_'),
    ),
  },
}
