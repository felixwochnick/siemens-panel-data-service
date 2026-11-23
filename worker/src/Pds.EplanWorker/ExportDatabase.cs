using System;
using System.Globalization;
using System.IO;
using Microsoft.Data.Sqlite;

namespace EplanElectricP8Api
{
    internal sealed class ExportRecord
    {
        public string ProjectPath { get; set; }

        /// <summary>Letzte Änderung des Projekts (UTC), gemessen direkt nach dem Export.</summary>
        public DateTime ProjectModified { get; set; }

        public DateTime ExportedAt { get; set; }
        public bool Success { get; set; }
        public string Error { get; set; }
    }

    /// <summary>
    /// Merkt sich pro Projekt den Stand des letzten Exports, damit nur neue oder geänderte Projekte exportiert werden.
    /// </summary>
    internal sealed class ExportDatabase
    {
        private readonly string _connectionString;

        public ExportDatabase(DatabaseConfig config)
        {
            string directory = Path.GetDirectoryName(Path.GetFullPath(config.Path));
            Directory.CreateDirectory(directory);
            _connectionString = new SqliteConnectionStringBuilder { DataSource = config.Path }.ToString();
        }

        public void Initialize()
        {
            Execute(@"CREATE TABLE IF NOT EXISTS exports (
                        project_path     TEXT PRIMARY KEY COLLATE NOCASE,
                        project_modified TEXT NOT NULL,
                        exported_at      TEXT NOT NULL,
                        success          INTEGER NOT NULL,
                        error            TEXT)");
        }

        public ExportRecord Get(string projectPath)
        {
            using (var connection = Open())
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT project_modified, exported_at, success, error FROM exports WHERE project_path = $path";
                command.Parameters.AddWithValue("$path", projectPath);
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                    {
                        return null;
                    }

                    return new ExportRecord
                    {
                        ProjectPath = projectPath,
                        ProjectModified = ParseDate(reader.GetString(0)),
                        ExportedAt = ParseDate(reader.GetString(1)),
                        Success = reader.GetInt64(2) != 0,
                        Error = reader.IsDBNull(3) ? null : reader.GetString(3),
                    };
                }
            }
        }

        public void Save(ExportRecord record)
        {
            Execute(@"INSERT INTO exports (project_path, project_modified, exported_at, success, error)
                      VALUES ($path, $modified, $exported, $success, $error)
                      ON CONFLICT(project_path) DO UPDATE SET
                        project_modified = excluded.project_modified,
                        exported_at      = excluded.exported_at,
                        success          = excluded.success,
                        error            = excluded.error",
                command =>
                {
                    command.Parameters.AddWithValue("$path", record.ProjectPath);
                    command.Parameters.AddWithValue("$modified", FormatDate(record.ProjectModified));
                    command.Parameters.AddWithValue("$exported", FormatDate(record.ExportedAt));
                    command.Parameters.AddWithValue("$success", record.Success ? 1 : 0);
                    command.Parameters.AddWithValue("$error", (object)record.Error ?? DBNull.Value);
                });
        }

        private SqliteConnection Open()
        {
            var connection = new SqliteConnection(_connectionString);
            connection.Open();
            return connection;
        }

        private void Execute(string sql, Action<SqliteCommand> addParameters = null)
        {
            using (var connection = Open())
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                addParameters?.Invoke(command);
                command.ExecuteNonQuery();
            }
        }

        private static string FormatDate(DateTime value)
        {
            return value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
        }

        private static DateTime ParseDate(string value)
        {
            return DateTime.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime();
        }
    }
}
