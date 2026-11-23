using System.Collections.Generic;

namespace EplanElectricP8Api
{
    public class ConfigModel
    {
        public LoggingConfig Logging { get; set; } = new LoggingConfig();
        public EplanConfig Eplan { get; set; } = new EplanConfig();
        public DatabaseConfig Database { get; set; } = new DatabaseConfig();
        public ExportConfig Export { get; set; } = new ExportConfig();
    }

    public class LoggingConfig
    {
        /// <summary>Log-Verzeichnis. Wird durch --logging überschrieben. Leer = "logs" neben der exe.</summary>
        public string Directory { get; set; }

        /// <summary>Minimales Log-Level: Verbose, Debug, Information, Warning, Error, Fatal.</summary>
        public string Level { get; set; } = "Information";
    }

    public class EplanConfig
    {
        /// <summary>Bin-Ordner der EPLAN Platform (enthält die Eplan.EplApi.*.dll).</summary>
        public string PlatformBin { get; set; } = @"C:\Program Files\EPLAN\Platform\2025.0.3\Bin";

        /// <summary>Bin-Ordner der Produktvariante (enthält die W3u.exe).</summary>
        public string ProductBin { get; set; } = @"C:\Program Files\EPLAN\Electric P8\2025.0.3\Bin";

        /// <summary>Leer = Variante aus der install.xml verwenden.</summary>
        public string ApplicationModifier { get; set; } = "";
    }

    public class DatabaseConfig
    {
        /// <summary>Pfad zur SQLite-Datei, in der die Exporte protokolliert werden.</summary>
        public string Path { get; set; } = "exports.db";
    }

    public class ExportConfig
    {
        /// <summary>Ordner, der nach EPLAN Projekten durchsucht wird.</summary>
        public string ProjectFolder { get; set; } = "";

        /// <summary>Unterordner ebenfalls durchsuchen.</summary>
        public bool Recursive { get; set; } = true;

        /// <summary>Dateimuster der Projektdateien: Projekte (*.elk) und Projektarchive (*.zw1).</summary>
        public List<string> FilePatterns { get; set; } = DefaultFilePatterns();

        /// <summary>Zielordner; pro Projekt wird ein Unterordner mit dem Projektnamen angelegt.</summary>
        public string OutputFolder { get; set; } = "export";

        /// <summary>Quartz Cron-Ausdruck (6 Felder: Sek Min Std Tag Monat Wochentag).</summary>
        public string CronSchedule { get; set; } = "0 0 2 * * ?";

        /// <summary>Öffnungsmodus: ReadOnly | Standard | Exclusive.</summary>
        public string OpenMode { get; set; } = "ReadOnly";

        /// <summary>Sprache der Beschriftung, z.B. de_DE.</summary>
        public string Language { get; set; } = "de_DE";

        /// <summary>Beschriftungs-Exporte (Action "label"), die pro Projekt ausgeführt werden.</summary>
        public List<LabelExportConfig> Labels { get; set; } = LabelExportConfig.Defaults();

        public static List<string> DefaultFilePatterns()
        {
            return new List<string> { "*.elk", "*.zw1" };
        }
    }

    public class LabelExportConfig
    {
        /// <summary>Anzeigename im Log.</summary>
        public string Name { get; set; }

        /// <summary>Name des Beschriftungsschemas in EPLAN.</summary>
        public string ConfigScheme { get; set; }

        /// <summary>Dateiname im Projekt-Ausgabeordner; {project} wird durch den Projektnamen ersetzt.</summary>
        public string FileName { get; set; }

        public static List<LabelExportConfig> Defaults()
        {
            // Verbindungen werden immer direkt exportiert (ConnectionExporter); Schema-Exporte nur bei Bedarf konfigurieren
            return new List<LabelExportConfig>();
        }
    }
}
