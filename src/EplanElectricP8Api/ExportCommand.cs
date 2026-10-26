using System;
using System.ComponentModel;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;
using Spectre.Console;
using Spectre.Console.Cli;

namespace EplanElectricP8Api
{
    /// <summary>Exportiert ein einzelnes Projekt sofort und beendet sich danach.</summary>
    internal sealed class ExportCommand : AsyncCommand<ExportCommand.Settings>
    {
        public sealed class Settings : CommandSettings
        {
            [CommandArgument(0, "<PROJECT>")]
            [Description("Pfad zur EPLAN Projektdatei (.elk), zum .edb Ordner oder zum Projektarchiv (.zw1)")]
            public string ProjectPath { get; set; }

            [CommandOption("-o|--output <PATH>")]
            [Description("Ausgabeordner (Standard: export.output_folder aus der config.yaml)")]
            public string OutputFolder { get; set; }

            [CommandOption("-c|--config <PATH>")]
            [Description("Pfad zur config.yaml (optional; ohne Datei gelten die Standardwerte)")]
            public string ConfigFile { get; set; }
        }

        public override ValidationResult Validate(CommandContext context, Settings settings)
        {
            if (settings.ProjectPath.IndexOf('"') >= 0)
            {
                // Entsteht in PowerShell, wenn ein Pfad mit Leerzeichen auf \ endet: \" maskiert das Anführungszeichen
                return ValidationResult.Error("Ungültiger Pfad: " + settings.ProjectPath
                    + " (abschließenden Backslash entfernen)");
            }

            // .edb Ordner wird ebenfalls akzeptiert und auf die .elk Datei daneben umgesetzt
            settings.ProjectPath = ProjectFiles.ResolveProjectFile(settings.ProjectPath);
            if (!File.Exists(settings.ProjectPath))
            {
                return ValidationResult.Error("Projektdatei nicht gefunden: " + settings.ProjectPath);
            }
            if (!ProjectFiles.HasProjectData(settings.ProjectPath))
            {
                return ValidationResult.Error("Projektordner fehlt: " + ProjectFiles.DataFolder(settings.ProjectPath)
                    + " (die .elk Datei allein enthält keine Projektdaten)");
            }
            if (settings.ConfigFile != null && !File.Exists(settings.ConfigFile))
            {
                return ValidationResult.Error("Konfigurationsdatei nicht gefunden: " + settings.ConfigFile);
            }
            return ValidationResult.Success();
        }

        public override async Task<int> ExecuteAsync(CommandContext context, Settings settings)
        {
            string configPath = settings.ConfigFile ?? ConfigLoader.DefaultConfigPath;
            var config = File.Exists(configPath) ? ConfigLoader.Load(configPath) : new ConfigModel();

            // Einzel-Export: nur Konsole, keine Log-Datei
            LoggingSetup.Configure(config.Logging.Level, null);
            var loggerFactory = new SerilogLoggerFactory(Log.Logger);

            string projectPath = settings.ProjectPath;
            string outputFolder = Path.GetFullPath(settings.OutputFolder ?? config.Export.OutputFolder);

            var worker = new EplanWorker(config.Eplan, Environment.UserInteractive, loggerFactory.CreateLogger<EplanWorker>());
            try
            {
                var exporter = new ProjectExporter(config.Export, loggerFactory.CreateLogger<ProjectExporter>());
                var result = await worker.InvokeAsync(() => exporter.Export(projectPath, outputFolder));

                if (!result.Success)
                {
                    AnsiConsole.MarkupLine("[red bold]{0} Export(e) fehlgeschlagen.[/]", result.Errors.Count);
                    return 1;
                }

                AnsiConsole.MarkupLine("[green bold]Alle Exporte erfolgreich.[/]");
                return 0;
            }
            catch (Exception ex)
            {
                Log.Fatal(ex, "Export fehlgeschlagen");
                return 1;
            }
            finally
            {
                worker.Dispose();
                Log.CloseAndFlush();
            }
        }
    }
}
