import type { MigrationSet } from '../migrator'
import { sqliteSql, tsql } from '../migrator'

/** SQLite: ID wie NEWID() (UUID v4, klein geschrieben) */
export const SQLITE_UUID = `(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
  || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))`

/** SQLite: Zeitpunkt wie SYSUTCDATETIME() im Format, das der Adapter schreibt (ISO, UTC, Millisekunden) */
export const SQLITE_NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

export const coreMigrations: MigrationSet = {
  schema: 'core',
  mssql: {
    '0001_users_sessions': tsql(
      `CREATE TABLE core.users (
        id uniqueidentifier NOT NULL CONSTRAINT df_users_id DEFAULT NEWSEQUENTIALID(),
        issuer nvarchar(400) NOT NULL,
        subject nvarchar(255) NOT NULL,
        email nvarchar(320) NULL,
        display_name nvarchar(200) NOT NULL,
        is_admin bit NOT NULL CONSTRAINT df_users_is_admin DEFAULT 0,
        created_at datetime2(3) NOT NULL CONSTRAINT df_users_created_at DEFAULT SYSUTCDATETIME(),
        last_login_at datetime2(3) NULL,
        CONSTRAINT pk_users PRIMARY KEY (id),
        CONSTRAINT uq_users_identity UNIQUE (issuer, subject)
      )`,
      `CREATE TABLE core.sessions (
        id uniqueidentifier NOT NULL CONSTRAINT df_sessions_id DEFAULT NEWID(),
        user_id uniqueidentifier NOT NULL,
        expires_at datetime2(3) NOT NULL,
        created_at datetime2(3) NOT NULL CONSTRAINT df_sessions_created_at DEFAULT SYSUTCDATETIME(),
        user_agent nvarchar(500) NULL,
        CONSTRAINT pk_sessions PRIMARY KEY (id),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES core.users (id) ON DELETE CASCADE
      )`,
      'CREATE INDEX ix_sessions_user ON core.sessions (user_id)',
    ),
    // OAuth-Server für MCP: Programme, Autorisierungscodes, Verbindungen und deren Tokens (nur als Hash)
    '0002_mcp_oauth': tsql(
      `CREATE TABLE core.oauth_clients (
        id nvarchar(100) NOT NULL,
        name nvarchar(100) NOT NULL,
        redirect_uris nvarchar(max) NOT NULL,
        secret_hash varchar(64) NULL,
        created_at datetime2(3) NOT NULL CONSTRAINT df_oauth_clients_created_at DEFAULT SYSUTCDATETIME(),
        last_used_at datetime2(3) NULL,
        CONSTRAINT pk_oauth_clients PRIMARY KEY (id),
        CONSTRAINT ck_oauth_clients_redirect_uris CHECK (ISJSON(redirect_uris) = 1)
      )`,
      `CREATE TABLE core.oauth_codes (
        code_hash varchar(64) NOT NULL,
        client_id nvarchar(100) NOT NULL,
        user_id uniqueidentifier NOT NULL,
        redirect_uri nvarchar(2000) NOT NULL,
        code_challenge varchar(128) NOT NULL,
        access varchar(10) NOT NULL,
        expires_at datetime2(3) NOT NULL,
        CONSTRAINT pk_oauth_codes PRIMARY KEY (code_hash),
        CONSTRAINT fk_oauth_codes_client FOREIGN KEY (client_id) REFERENCES core.oauth_clients (id) ON DELETE CASCADE,
        CONSTRAINT fk_oauth_codes_user FOREIGN KEY (user_id) REFERENCES core.users (id) ON DELETE CASCADE,
        CONSTRAINT ck_oauth_codes_access CHECK (access IN ('read', 'write'))
      )`,
      `CREATE TABLE core.mcp_connections (
        id uniqueidentifier NOT NULL CONSTRAINT df_mcp_connections_id DEFAULT NEWID(),
        user_id uniqueidentifier NOT NULL,
        client_id nvarchar(100) NOT NULL,
        name nvarchar(100) NOT NULL,
        access varchar(10) NOT NULL,
        expires_at datetime2(3) NOT NULL,
        created_at datetime2(3) NOT NULL CONSTRAINT df_mcp_connections_created_at DEFAULT SYSUTCDATETIME(),
        last_used_at datetime2(3) NULL,
        CONSTRAINT pk_mcp_connections PRIMARY KEY (id),
        CONSTRAINT fk_mcp_connections_user FOREIGN KEY (user_id) REFERENCES core.users (id) ON DELETE CASCADE,
        CONSTRAINT fk_mcp_connections_client FOREIGN KEY (client_id) REFERENCES core.oauth_clients (id) ON DELETE CASCADE,
        CONSTRAINT ck_mcp_connections_access CHECK (access IN ('read', 'write'))
      )`,
      'CREATE INDEX ix_mcp_connections_user ON core.mcp_connections (user_id)',
      `CREATE TABLE core.mcp_tokens (
        token_hash varchar(64) NOT NULL,
        connection_id uniqueidentifier NOT NULL,
        kind varchar(10) NOT NULL,
        expires_at datetime2(3) NOT NULL,
        used_at datetime2(3) NULL,
        CONSTRAINT pk_mcp_tokens PRIMARY KEY (token_hash),
        CONSTRAINT fk_mcp_tokens_connection FOREIGN KEY (connection_id) REFERENCES core.mcp_connections (id) ON DELETE CASCADE,
        CONSTRAINT ck_mcp_tokens_kind CHECK (kind IN ('access', 'refresh'))
      )`,
      'CREATE INDEX ix_mcp_tokens_connection ON core.mcp_tokens (connection_id)',
    ),
    // Verbindung endet spätestens mit der Sitzung (Ende steht am Code); Indizes für Aufräumen und die Obergrenze
    // anonymer Registrierungen (gefiltert: nur nie genutzte Programme zählen)
    '0003_mcp_oauth_limits': tsql(
      'ALTER TABLE core.oauth_codes ADD connection_expires_at datetime2(3) NULL',
      'CREATE INDEX ix_oauth_clients_unused ON core.oauth_clients (created_at) WHERE last_used_at IS NULL',
      'CREATE INDEX ix_oauth_codes_expires_at ON core.oauth_codes (expires_at)',
      'CREATE INDEX ix_mcp_connections_expires_at ON core.mcp_connections (expires_at)',
      'CREATE INDEX ix_mcp_tokens_expires_at ON core.mcp_tokens (expires_at)',
    ),
  },
  // Gleicher Endstand wie SQL Server; Tabellen ohne Schema als core_<tabelle>, Zeitpunkte als ISO-Text (`datetime`),
  // Booleans als 0/1 (`boolean`) – der Adapter wandelt anhand dieser Typnamen um
  sqlite: {
    '0001_users_sessions': sqliteSql(
      `CREATE TABLE core_users (
        id text NOT NULL DEFAULT ${SQLITE_UUID},
        issuer text NOT NULL,
        subject text NOT NULL,
        email text NULL,
        display_name text NOT NULL,
        is_admin boolean NOT NULL DEFAULT 0,
        created_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        last_login_at datetime NULL,
        CONSTRAINT pk_users PRIMARY KEY (id),
        CONSTRAINT uq_users_identity UNIQUE (issuer, subject)
      )`,
      `CREATE TABLE core_sessions (
        id text NOT NULL DEFAULT ${SQLITE_UUID},
        user_id text NOT NULL,
        expires_at datetime NOT NULL,
        created_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        user_agent text NULL,
        CONSTRAINT pk_sessions PRIMARY KEY (id),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES core_users (id) ON DELETE CASCADE
      )`,
      'CREATE INDEX ix_sessions_user ON core_sessions (user_id)',
    ),
    '0002_mcp_oauth': sqliteSql(
      `CREATE TABLE core_oauth_clients (
        id text NOT NULL,
        name text NOT NULL,
        redirect_uris text NOT NULL,
        secret_hash text NULL,
        created_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        last_used_at datetime NULL,
        CONSTRAINT pk_oauth_clients PRIMARY KEY (id),
        CONSTRAINT ck_oauth_clients_redirect_uris CHECK (json_valid(redirect_uris))
      )`,
      `CREATE TABLE core_oauth_codes (
        code_hash text NOT NULL,
        client_id text NOT NULL,
        user_id text NOT NULL,
        redirect_uri text NOT NULL,
        code_challenge text NOT NULL,
        access text NOT NULL,
        expires_at datetime NOT NULL,
        CONSTRAINT pk_oauth_codes PRIMARY KEY (code_hash),
        CONSTRAINT fk_oauth_codes_client FOREIGN KEY (client_id) REFERENCES core_oauth_clients (id) ON DELETE CASCADE,
        CONSTRAINT fk_oauth_codes_user FOREIGN KEY (user_id) REFERENCES core_users (id) ON DELETE CASCADE,
        CONSTRAINT ck_oauth_codes_access CHECK (access IN ('read', 'write'))
      )`,
      `CREATE TABLE core_mcp_connections (
        id text NOT NULL DEFAULT ${SQLITE_UUID},
        user_id text NOT NULL,
        client_id text NOT NULL,
        name text NOT NULL,
        access text NOT NULL,
        expires_at datetime NOT NULL,
        created_at datetime NOT NULL DEFAULT ${SQLITE_NOW},
        last_used_at datetime NULL,
        CONSTRAINT pk_mcp_connections PRIMARY KEY (id),
        CONSTRAINT fk_mcp_connections_user FOREIGN KEY (user_id) REFERENCES core_users (id) ON DELETE CASCADE,
        CONSTRAINT fk_mcp_connections_client FOREIGN KEY (client_id) REFERENCES core_oauth_clients (id) ON DELETE CASCADE,
        CONSTRAINT ck_mcp_connections_access CHECK (access IN ('read', 'write'))
      )`,
      'CREATE INDEX ix_mcp_connections_user ON core_mcp_connections (user_id)',
      `CREATE TABLE core_mcp_tokens (
        token_hash text NOT NULL,
        connection_id text NOT NULL,
        kind text NOT NULL,
        expires_at datetime NOT NULL,
        used_at datetime NULL,
        CONSTRAINT pk_mcp_tokens PRIMARY KEY (token_hash),
        CONSTRAINT fk_mcp_tokens_connection FOREIGN KEY (connection_id) REFERENCES core_mcp_connections (id) ON DELETE CASCADE,
        CONSTRAINT ck_mcp_tokens_kind CHECK (kind IN ('access', 'refresh'))
      )`,
      'CREATE INDEX ix_mcp_tokens_connection ON core_mcp_tokens (connection_id)',
    ),
    '0003_mcp_oauth_limits': sqliteSql(
      'ALTER TABLE core_oauth_codes ADD COLUMN connection_expires_at datetime NULL',
      'CREATE INDEX ix_oauth_clients_unused ON core_oauth_clients (created_at) WHERE last_used_at IS NULL',
      'CREATE INDEX ix_oauth_codes_expires_at ON core_oauth_codes (expires_at)',
      'CREATE INDEX ix_mcp_connections_expires_at ON core_mcp_connections (expires_at)',
      'CREATE INDEX ix_mcp_tokens_expires_at ON core_mcp_tokens (expires_at)',
    ),
  },
}
