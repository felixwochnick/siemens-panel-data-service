using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Pds.EplanWorker.Eplan;
using Pds.EplanWorker.Server;

namespace Pds.EplanWorker.Hosting
{
    /// <summary>
    /// Bedient die Clients: Named Pipe (<c>service</c>, <c>run</c>) oder eine Sitzung über stdin/stdout (<c>stdio</c>,
    /// danach endet der Prozess). EPLAN startet erst mit der ersten Analyse – Windows bricht den Dienststart sonst nach
    /// ca. 30 Sekunden ab.
    /// </summary>
    internal sealed class WorkerService : BackgroundService
    {
        /// <summary>
        /// Höchstens so lange wartet der Stopp auf EPLAN; bleibt unter dem Shutdown-Zeitlimit des Hosts (30 s), sonst
        /// beendet der Host den Stopp vorher.
        /// </summary>
        private static readonly TimeSpan EplanShutdownTimeout = TimeSpan.FromSeconds(20);

        private readonly CommandLineOptions _options;
        private readonly EplanHost _eplan;
        private readonly WorkerController _worker;
        private readonly Action<int> _exit;
        private readonly Stream _stdin;
        private readonly Stream _stdout;
        private readonly IHostApplicationLifetime _lifetime;
        private readonly ILogger _logger;

        public WorkerService(CommandLineOptions options, EplanHost eplan, WorkerController worker, Action<int> exit, Stream stdin,
            Stream stdout, IHostApplicationLifetime lifetime, ILogger logger)
        {
            _options = options;
            _eplan = eplan;
            _worker = worker;
            _exit = exit;
            _stdin = stdin;
            _stdout = stdout;
            _lifetime = lifetime;
            _logger = logger;
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            // Nicht im Start des Hosts blockieren (Dienststart muss schnell zurückkehren)
            await Task.Yield();
            try
            {
                if (_options.Mode == WorkerMode.Stdio)
                {
                    await new Session(_stdin, _stdout, _worker, _exit, _logger).RunAsync(stoppingToken).ConfigureAwait(false);
                    _logger.LogInformation("stdin geschlossen, Worker wird beendet");
                }
                else
                {
                    await new PipeServer(_options.PipeName, _worker, _exit, _logger).RunAsync(stoppingToken).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.LogCritical(ex, "Worker mit Fehler beendet");
                Environment.ExitCode = 1;
            }
            finally
            {
                _lifetime.StopApplication();
            }
        }

        public override async Task StopAsync(CancellationToken cancellationToken)
        {
            await base.StopAsync(cancellationToken).ConfigureAwait(false);
            // EPLAN beenden, solange der Dienst noch „wird beendet“ meldet: Windows sieht ihn erst danach als gestoppt,
            // und MSI-Update bzw. Neustart finden pds-eplan.exe nicht mehr gesperrt
            _eplan.Shutdown(EplanShutdownTimeout);
        }
    }
}
