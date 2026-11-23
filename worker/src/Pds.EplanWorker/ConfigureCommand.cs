using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using Spectre.Console;
using Spectre.Console.Cli;

namespace EplanElectricP8Api
{
    /// <summary>Interaktiver Assistent, der eine config.yaml erstellt oder eine bestehende bearbeitet.</summary>
    internal sealed class ConfigureCommand : Command<ConfigureCommand.Settings>
    {
        private static readonly string[] LogLevels = { "Verbose", "Debug", "Information", "Warning", "Error", "Fatal" };
        private static readonly string[] OpenModes = { "ReadOnly", "Standard", "Exclusive" };

        public sealed class Settings : CommandSettings
        {
            [CommandOption("-o|--output <PATH>")]
            [Description("Zieldatei (Standard: config.yaml neben der exe)")]
            public string OutputFile { get; set; }
        }

        public override int Execute(CommandContext context, Settings settings)
        {
            string outputPath = Path.GetFullPath(settings.OutputFile ?? ConfigLoader.DefaultConfigPath);

            AnsiConsole.Write(new Rule("[blue]EPLAN Electric P8 Export — Konfiguration[/]").RuleStyle("blue dim").LeftJustified());
            AnsiConsole.MarkupLine("[dim]Mit [bold]Enter[/] wird der Wert in Klammern übernommen.[/]");
            AnsiConsole.WriteLine();

            // Bestehende Datei als Vorgabe verwenden
            var config = File.Exists(outputPath) ? ConfigLoader.Load(outputPath) : new ConfigModel();

            Section("Logging");
            config.Logging.Directory = Ask("Log-Verzeichnis (leer = 'logs' neben der exe)", config.Logging.Directory, allowEmpty: true);
            config.Logging.Level = Choose("Log-Level", LogLevels, config.Logging.Level);

            Section("EPLAN");
            config.Eplan.PlatformBin = Ask("Bin-Ordner der EPLAN Platform", config.Eplan.PlatformBin);
            config.Eplan.ProductBin = Ask("Bin-Ordner von Electric P8", config.Eplan.ProductBin);
            config.Eplan.ApplicationModifier = Ask("Application Modifier (leer = aus install.xml)", config.Eplan.ApplicationModifier, allowEmpty: true);

            Section("Datenbank");
            config.Database.Path = Ask("SQLite-Datei", config.Database.Path);

            Section("Export");
            config.Export.ProjectFolder = Ask("Projektordner", config.Export.ProjectFolder);
            config.Export.Recursive = AnsiConsole.Confirm("Unterordner durchsuchen?", config.Export.Recursive);
            var patterns = Ask("Dateimuster (mit Komma getrennt)",
                string.Join(", ", config.Export.FilePatterns ?? ExportConfig.DefaultFilePatterns()));
            config.Export.FilePatterns = new List<string>(
                patterns.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)).ConvertAll(p => p.Trim());
            config.Export.OutputFolder = Ask("Ausgabeordner", config.Export.OutputFolder);
            config.Export.CronSchedule = Ask("Cron-Zeitplan (Sek Min Std Tag Monat Wochentag)", config.Export.CronSchedule);
            config.Export.OpenMode = Choose("Öffnungsmodus", OpenModes, config.Export.OpenMode);
            config.Export.Language = Ask("Sprache", config.Export.Language);
            config.Export.Labels = ConfigureLabels(config.Export.Labels);

            AnsiConsole.WriteLine();
            if (!AnsiConsole.Confirm("Speichern nach [cyan]" + Markup.Escape(outputPath) + "[/]?"))
            {
                AnsiConsole.MarkupLine("[yellow]Abgebrochen — nichts gespeichert.[/]");
                return 0;
            }

            ConfigLoader.Save(config, outputPath);
            AnsiConsole.MarkupLine("[green bold]Gespeichert.[/]");
            return 0;
        }

        private static List<LabelExportConfig> ConfigureLabels(List<LabelExportConfig> labels)
        {
            var table = new Table().AddColumns("Name", "Schema", "Datei");
            foreach (var label in labels)
            {
                table.AddRow(Markup.Escape(label.Name ?? ""), Markup.Escape(label.ConfigScheme ?? ""), Markup.Escape(label.FileName ?? ""));
            }
            AnsiConsole.Write(table);

            if (AnsiConsole.Confirm("Diese Beschriftungs-Exporte übernehmen?"))
            {
                return labels;
            }

            var result = new List<LabelExportConfig>();
            do
            {
                var label = new LabelExportConfig
                {
                    Name = Ask("Name", null),
                    ConfigScheme = Ask("Beschriftungsschema", null),
                };
                label.FileName = Ask("Dateiname ({project} = Projektname)", "{project}_" + label.Name + ".txt");
                result.Add(label);
            }
            while (AnsiConsole.Confirm("Weiteren Export hinzufügen?", false));

            return result;
        }

        private static void Section(string title)
        {
            AnsiConsole.WriteLine();
            AnsiConsole.Write(new Rule("[bold]" + title + "[/]").LeftJustified());
        }

        private static string Ask(string question, string defaultValue, bool allowEmpty = false)
        {
            var prompt = new TextPrompt<string>(question);
            if (!string.IsNullOrEmpty(defaultValue))
            {
                prompt.DefaultValue(defaultValue);
            }
            if (allowEmpty)
            {
                prompt.AllowEmpty();
            }

            string answer = AnsiConsole.Prompt(prompt);
            return string.IsNullOrWhiteSpace(answer) ? (allowEmpty ? null : defaultValue) : answer.Trim();
        }

        private static string Choose(string title, string[] choices, string current)
        {
            var prompt = new SelectionPrompt<string>().Title(title + " [dim](aktuell: " + Markup.Escape(current ?? "-") + ")[/]");
            // Aktuellen Wert an den Anfang stellen, damit Enter ihn übernimmt
            int index = Array.FindIndex(choices, c => string.Equals(c, current, StringComparison.OrdinalIgnoreCase));
            if (index > 0)
            {
                prompt.AddChoice(choices[index]);
            }
            for (int i = 0; i < choices.Length; i++)
            {
                if (i != index || index == 0)
                {
                    prompt.AddChoice(choices[i]);
                }
            }

            string choice = AnsiConsole.Prompt(prompt);
            AnsiConsole.MarkupLine(title + ": [cyan]" + choice + "[/]");
            return choice;
        }
    }
}
