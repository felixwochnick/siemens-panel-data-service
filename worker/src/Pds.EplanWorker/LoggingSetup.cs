using System;
using System.IO;
using Serilog;
using Serilog.Events;

namespace Pds.EplanWorker
{
    internal static class LoggingSetup
    {
        private const string ConsoleTemplate = "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}";
        private const string FileTemplate = "{Timestamp:yyyy-MM-dd HH:mm:ss.fff} [{Level:u3}] {Message:lj}{NewLine}{Exception}";

        /// <summary>
        /// Serilog nach stderr (nie stdout: im Modus stdio gehört stdout dem Protokoll) und, wenn
        /// <paramref name="logDirectory"/> gesetzt ist, in die tägliche Datei <c>eplan-worker-&lt;Datum&gt;.log</c>.
        /// </summary>
        public static void Configure(string logDirectory)
        {
            var config = new LoggerConfiguration()
                .MinimumLevel.Information()
                .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
                .WriteTo.Console(outputTemplate: ConsoleTemplate, standardErrorFromLevel: LogEventLevel.Verbose);

            string fileError = null;
            if (!string.IsNullOrEmpty(logDirectory))
            {
                try
                {
                    Directory.CreateDirectory(logDirectory);
                    config.WriteTo.File(
                        Path.Combine(logDirectory, "eplan-worker-.log"),
                        rollingInterval: RollingInterval.Day,
                        retainedFileCountLimit: 31,
                        outputTemplate: FileTemplate);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    fileError = ex.Message;
                }
            }

            Log.Logger = config.CreateLogger();
            if (fileError != null)
            {
                Log.Warning("Log-Ordner {Folder} nicht nutzbar, Logs nur auf stderr: {Error}", logDirectory, fileError);
            }
        }
    }
}
