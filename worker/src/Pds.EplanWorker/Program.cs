using System;
using System.IO;
using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Pds.EplanWorker.Eplan;
using Pds.EplanWorker.Hosting;
using Pds.EplanWorker.Protocol;
using Serilog;
using Serilog.Extensions.Logging;

namespace Pds.EplanWorker
{
    /// <summary>
    /// EPLAN-Worker <c>pds-eplan.exe</c>: startet EPLAN, stellt Archive wieder her, öffnet Projekte und schreibt deren
    /// Rohdaten als JSON. Spricht JSON-Zeilen über eine Named Pipe (service, run) oder stdin/stdout (stdio).
    /// </summary>
    internal static class Program
    {
        private static int Main(string[] args)
        {
            string defaultLogDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "EPLAN Panel Data Service", "logs");

            CommandLineOptions options;
            try
            {
                options = CommandLineOptions.Parse(args, defaultLogDirectory);
            }
            catch (ArgumentException ex)
            {
                Console.Error.WriteLine(ex.Message);
                Console.Error.WriteLine();
                Console.Error.Write(CommandLineOptions.Usage);
                return 2;
            }

            string version = WorkerVersion();
            if (options.ShowHelp)
            {
                Console.Out.Write(CommandLineOptions.Usage);
                return 0;
            }
            if (options.ShowVersion)
            {
                Console.Out.WriteLine(version);
                return 0;
            }

            // stdio: stdout gehört allein dem Protokoll. Rohe Streams holen, bevor irgendetwas Console.Out benutzt,
            // und Console.Out auf stderr umleiten – verirrte Ausgaben (auch aus Bibliotheken) landen dann dort.
            Stream stdin = null;
            Stream stdout = null;
            if (options.Mode == WorkerMode.Stdio)
            {
                stdin = Console.OpenStandardInput();
                stdout = Console.OpenStandardOutput();
            }
            ConfigureConsole(options.Mode);

            LoggingSetup.Configure(options.LogDirectory);
            var loggerFactory = new SerilogLoggerFactory(Log.Logger);
            var logger = loggerFactory.CreateLogger("pds-eplan");
            try
            {
                logger.LogInformation("pds-eplan {Version} startet ({Mode}, Protokoll {Protocol})",
                    version, options.Mode, ProtocolConstants.ProtocolVersion);
#if EPLAN_STUBS
                logger.LogWarning("Gegen die Compile-Stubs der EPLAN-API gebaut: Analysen schlagen mit eplan_start_failed fehl.");
#endif

                // Nach dem Host freigeben: erst keine neuen Anfragen mehr, dann EPLAN beenden
                using (var eplan = new EplanHost(options.AllowDialogs, loggerFactory.CreateLogger("EPLAN")))
                {
                    var worker = new WorkerController(new ProjectReader(eplan, logger), version, logger);
                    var exit = new ProcessExit(eplan, worker, logger);

                    var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
                    {
                        // Keine Standard-Logger (die Konsole von Microsoft.Extensions.Logging schreibt nach stdout),
                        // keine appsettings.json/Umgebungsvariablen: der Worker hat nur seine Kommandozeile
                        DisableDefaults = true,
                        ContentRootPath = AppDomain.CurrentDomain.BaseDirectory,
                    });
                    builder.Services.AddSerilog();
                    if (options.Mode == WorkerMode.Service)
                    {
                        builder.Services.AddWindowsService(service => service.ServiceName = ProtocolConstants.ServiceName);
                    }
                    builder.Services.AddHostedService(services => new WorkerService(options, worker, exit.Exit, stdin, stdout,
                        services.GetRequiredService<IHostApplicationLifetime>(), logger));

                    using (var host = builder.Build())
                    {
                        host.Run();
                    }
                }

                logger.LogInformation("pds-eplan beendet");
                return Environment.ExitCode;
            }
            catch (Exception ex)
            {
                logger.LogCritical(ex, "pds-eplan mit Fehler beendet");
                return 1;
            }
            finally
            {
                loggerFactory.Dispose();
                Log.CloseAndFlush();
            }
        }

        private static void ConfigureConsole(WorkerMode mode)
        {
            if (mode == WorkerMode.Service)
            {
                // Als Dienst gibt es keine Konsole
                return;
            }

            try
            {
                // Umlaute auf stderr für den Client bzw. die Konsole; ohne BOM (.NET Framework schreibt sonst eines,
                // wenn die Ausgabe umgeleitet ist). Vor SetOut, weil das Setzen die Writer neu anlegt.
                Console.OutputEncoding = JsonText.Utf8;
            }
            catch (Exception ex) when (ex is IOException || ex is ArgumentException || ex is PlatformNotSupportedException)
            {
                // Keine Konsole angehängt: Standardkodierung bleibt
            }

            if (mode == WorkerMode.Stdio)
            {
                Console.SetOut(Console.Error);
            }
        }

        /// <summary>Version aus der Assembly (MSBuild-Eigenschaft Version), ohne „+commit“.</summary>
        private static string WorkerVersion()
        {
            var assembly = typeof(Program).Assembly;
            string version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                ?? assembly.GetName().Version?.ToString()
                ?? "0.0.0";
            int plus = version.IndexOf('+');
            return plus < 0 ? version : version.Substring(0, plus);
        }
    }
}
