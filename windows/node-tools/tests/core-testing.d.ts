// Nur für tsc (tsconfig `paths`): In `@pds/core/testing` hat eine Hilfsfunktion, die hier nicht
// gebraucht wird, einen Typfehler (core wird nicht mit tsc geprüft). Zur Laufzeit gilt das echte Modul.

/** Server-Verbindung mit Rechten auf master (Standard: SQL Server aus docker/docker-compose.dev.yml) */
export declare const TEST_SERVER_URL: string

/** `TEST_DATABASE=sqlite` (pnpm test:sqlite): Tests ohne Docker; sonst SQL Server */
export declare const TEST_DIALECT: 'mssql' | 'sqlite'
