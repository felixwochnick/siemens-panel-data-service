using System;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using Pds.EplanWorker.Eplan;
using Serilog;

namespace Pds.EplanWorker.Hosting
{
    /// <summary>
    /// Beenden auf Anforderung des Clients (<c>exit</c>), z. B. nach <c>restart_required</c> oder einer hängenden
    /// Analyse. Ist EPLAN frei, wird es noch ordentlich beendet; dann endet der Prozess sofort mit dem Code.
    /// Als Dienst sieht Windows das als Absturz und startet ihn über die Wiederherstellungsaktionen neu.
    /// </summary>
    internal sealed class ProcessExit
    {
        private static readonly TimeSpan EplanExitTimeout = TimeSpan.FromSeconds(30);

        private readonly EplanHost _eplan;
        private readonly WorkerController _worker;
        private readonly Microsoft.Extensions.Logging.ILogger _logger;

        public ProcessExit(EplanHost eplan, WorkerController worker, Microsoft.Extensions.Logging.ILogger logger)
        {
            _eplan = eplan;
            _worker = worker;
            _logger = logger;
        }

        public void Exit(int code)
        {
            if (_worker.IsBusy)
            {
                // Die Analyse hängt vermutlich (Zeitlimit des Clients); auf EPLAN zu warten hätte keinen Sinn
                _logger.LogWarning("Beende mit Code {Code} während einer laufenden Analyse", code);
            }
            else
            {
                _logger.LogInformation("Beende mit Code {Code}", code);
                _eplan.Shutdown(EplanExitTimeout);
            }

            Log.CloseAndFlush();
            // Hart beenden: Environment.Exit würde auf das Herunterfahren des Hosts warten, das an einem hängenden
            // EPLAN-Thread hängen bleiben kann
            TerminateProcess(GetCurrentProcess(), unchecked((uint)code));
            Environment.Exit(code);
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();
    }
}
