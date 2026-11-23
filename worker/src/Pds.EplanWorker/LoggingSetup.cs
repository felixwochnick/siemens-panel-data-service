using System;
using System.IO;
using Serilog;
using Serilog.Events;

namespace EplanElectricP8Api
{
    internal static class LoggingSetup
    {
        private const string ConsoleTemplate = "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}";
        private const string FileTemplate = "{Timestamp:yyyy-MM-dd HH:mm:ss.fff} [{Level:u3}] {Message:lj}{NewLine}{Exception}";

        /// <summary>
        /// Konfiguriert Serilog für Konsole und, wenn <paramref name="logDirectory"/> gesetzt ist, für eine tägliche Log-Datei.
        /// </summary>
        public static void Configure(string level, string logDirectory)
        {
            var logLevel = Enum.TryParse(level, true, out LogEventLevel parsed) ? parsed : LogEventLevel.Information;

            var logger = new LoggerConfiguration()
                .MinimumLevel.Is(logLevel)
                .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
                .MinimumLevel.Override("Quartz", LogEventLevel.Warning)
                .WriteTo.Console(outputTemplate: ConsoleTemplate);

            if (!string.IsNullOrEmpty(logDirectory))
            {
                Directory.CreateDirectory(logDirectory);
                logger.WriteTo.File(
                    Path.Combine(logDirectory, "eplan-export_.log"),
                    rollingInterval: RollingInterval.Day,
                    outputTemplate: FileTemplate);
            }

            Log.Logger = logger.CreateLogger();
        }
    }
}
