#!/bin/bash
# Legt Datenbank und App-Login an (idempotent). Läuft als einmaliger Dienst mit dem MSSQL-Image.
# Die App selbst braucht so keine Rechte auf master; Tabellen legt sie per Migration in ihrer Datenbank an.
set -euo pipefail

: "${MSSQL_HOST:?MSSQL_HOST fehlt}"
: "${MSSQL_SA_PASSWORD:?MSSQL_SA_PASSWORD fehlt}"
: "${DB_NAME:?DB_NAME fehlt}"
: "${DB_USER:?DB_USER fehlt}"
: "${DB_PASSWORD:?DB_PASSWORD fehlt}"

SQLCMD=(/opt/mssql-tools18/bin/sqlcmd -C -b -S "$MSSQL_HOST" -U sa -P "$MSSQL_SA_PASSWORD")

# Werte landen in T-SQL-Literalen bzw. Bezeichnern: ' verdoppeln, ] in Namen nicht erlauben
case "$DB_NAME$DB_USER" in *"]"*|*"'"*) echo "DB_NAME/DB_USER dürfen weder ] noch ' enthalten" >&2; exit 1 ;; esac
DB_PASSWORD_SQL="${DB_PASSWORD//\'/\'\'}"

for i in $(seq 1 60); do
  if "${SQLCMD[@]}" -Q "SELECT 1" > /dev/null 2>&1; then break; fi
  echo "Warte auf SQL Server ($i) …"
  sleep 2
done

"${SQLCMD[@]}" -v DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD_SQL" -i /dev/stdin <<'SQL'
IF DB_ID(N'$(DB_NAME)') IS NULL
  CREATE DATABASE [$(DB_NAME)];
GO
-- Leser blockieren Schreiber nicht (Zeilenversionierung)
ALTER DATABASE [$(DB_NAME)] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;
GO
IF SUSER_ID(N'$(DB_USER)') IS NULL
  CREATE LOGIN [$(DB_USER)] WITH PASSWORD = N'$(DB_PASSWORD)';
ELSE
  ALTER LOGIN [$(DB_USER)] WITH PASSWORD = N'$(DB_PASSWORD)';
GO
USE [$(DB_NAME)];
IF USER_ID(N'$(DB_USER)') IS NULL
  CREATE USER [$(DB_USER)] FOR LOGIN [$(DB_USER)];
ALTER ROLE db_owner ADD MEMBER [$(DB_USER)];
GO
SQL

echo "Datenbank $DB_NAME und Login $DB_USER sind bereit."
