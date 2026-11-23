using System;
using System.ComponentModel;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Quartz;
using Serilog;
using Spectre.Console;
using Spectre.Console.Cli;

namespace EplanElectricP8Api
{
    /// <summary>Startet den Dienst: exportiert Projekte nach Cron-Zeitplan (oder einmalig mit --now).</summary>
    internal sealed class RunCommand : AsyncCommand<RunCommand.Settings>
    {
        public const string ServiceName = "EplanP8ExportService";

        public sealed class Settings : CommandSettings
        {
            [CommandOption("-c|--config <PATH>")]
            [Description("Pfad zur config.yaml (Standard: neben der exe)")]
            public string ConfigFile { get; set; }

            [CommandOption("-l|--logging <PATH>")]
            [Description("Log-Verzeichnis (überschreibt logging.directory)")]
            public string LoggingDirectory { get; set; }

            [CommandOption("--now")]
            [Description("Export-Lauf sofort einmal ausführen und beenden — ignoriert den Cron-Zeitplan")]
            public bool RunNow { get; set; }
        }

        public override async Task<int> ExecuteAsync(CommandContext context, Settings settings)
        {
            string configPath = Path.GetFullPath(settings.ConfigFile ?? ConfigLoader.DefaultConfigPath);
            if (!File.Exists(configPath))
            {
                AnsiConsole.MarkupLine("[red bold]Fehler:[/] Konfigurationsdatei nicht gefunden: [yellow]{0}[/]", Markup.Escape(configPath));
                AnsiConsole.MarkupLine("[dim]Mit [bold]configure[/] kann eine erstellt werden.[/]");
                return 1;
            }

            var config = ConfigLoader.Load(configPath);
            string logDir = settings.LoggingDirectory
                ?? config.Logging.Directory
                ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
            LoggingSetup.Configure(config.Logging.Level, logDir);

            try
            {
                PrintBanner(configPath, logDir, config, settings.RunNow);

                var builder = Host.CreateApplicationBuilder();
                builder.Services.AddSerilog();

                builder.Services.AddSingleton(config.Export);
                builder.Services.AddSingleton(config.Database);
                builder.Services.AddSingleton(sp => new EplanWorker(
                    config.Eplan, Environment.UserInteractive, sp.GetRequiredService<ILogger<EplanWorker>>()));
                builder.Services.AddSingleton<ExportDatabase>();
                builder.Services.AddSingleton<ProjectExporter>();
                builder.Services.AddTransient<ExportJob>();

                if (!settings.RunNow)
                {
                    // Reihenfolge wichtig: Hosted Services werden in umgekehrter Reihenfolge gestoppt,
                    // so wird EPLAN erst beendet, nachdem Quartz den laufenden Job abgeschlossen hat
                    builder.Services.AddHostedService<EplanHostedService>();
                    builder.Services.AddQuartz(q =>
                    {
                        var jobKey = new JobKey("ExportJob");
                        q.AddJob<ExportJob>(opts => opts.WithIdentity(jobKey).StoreDurably());
                        q.AddTrigger(opts => opts
                            .ForJob(jobKey)
                            .WithIdentity("ExportJob-trigger")
                            .WithCronSchedule(config.Export.CronSchedule));
                    });
                    builder.Services.AddQuartzHostedService(opt => opt.WaitForJobsToComplete = true);
                    builder.Services.AddWindowsService(opt => opt.ServiceName = ServiceName);
                }

                using (var host = builder.Build())
                {
                    host.Services.GetRequiredService<ExportDatabase>().Initialize();

                    if (settings.RunNow)
                    {
                        // EPLAN wird erst beim ersten Export gestartet
                        await host.Services.GetRequiredService<ExportJob>().RunAsync(CancellationToken.None);
                        return 0;
                    }

                    Log.Information("Dienst gestartet — nächster Lauf nach Zeitplan {Schedule}", config.Export.CronSchedule);
                    await host.RunAsync();
                    return 0;
                }
            }
            catch (Exception ex)
            {
                Log.Fatal(ex, "Unerwarteter Fehler");
                return 1;
            }
            finally
            {
                Log.CloseAndFlush();
            }
        }

        private static void PrintBanner(string configPath, string logDir, ConfigModel config, bool runNow)
        {
            if (!Environment.UserInteractive)
            {
                return;
            }

            AnsiConsole.Write(new Rule("[blue]EPLAN Electric P8 Export[/]").RuleStyle("blue dim").LeftJustified());
            var grid = new Grid().AddColumn(new GridColumn().NoWrap()).AddColumn();
            grid.AddRow("[bold]Config[/]", Markup.Escape(configPath));
            grid.AddRow("[bold]Logs[/]", Markup.Escape(logDir));
            grid.AddRow("[bold]Datenbank[/]", Markup.Escape(config.Database.Path));
            grid.AddRow("[bold]EPLAN[/]", Markup.Escape(config.Eplan.ProductBin));
            grid.AddRow("[bold]Projekte[/]", Markup.Escape(config.Export.ProjectFolder + "\\{"
                + string.Join(", ", config.Export.FilePatterns ?? ExportConfig.DefaultFilePatterns()) + "}")
                + (config.Export.Recursive ? " [dim](rekursiv)[/]" : ""));
            grid.AddRow("[bold]Ausgabe[/]", Markup.Escape(config.Export.OutputFolder));
            grid.AddRow("[bold]Modus[/]", runNow ? "[yellow]sofort (--now)[/]" : "Zeitplan " + Markup.Escape(config.Export.CronSchedule));
            grid.AddRow("[bold]Exporte[/]", Markup.Escape(string.Join(", ", config.Export.Labels.ConvertAll(l => l.ConfigScheme))));
            AnsiConsole.Write(grid);
            AnsiConsole.WriteLine();
        }
    }
}
