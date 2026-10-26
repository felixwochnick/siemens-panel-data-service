using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Startet EPLAN mit dem Dienst und beendet es beim Stoppen.
    /// Muss vor Quartz registriert werden, damit EPLAN erst nach dem letzten Job beendet wird.
    /// </summary>
    internal sealed class EplanHostedService : IHostedService
    {
        private readonly EplanWorker _worker;

        public EplanHostedService(EplanWorker worker)
        {
            _worker = worker;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            // Nicht auf EPLAN warten: Windows bricht den Dienststart nach ca. 30 Sekunden ab, Jobs warten selbst auf Ready
            _worker.Start();
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            return Task.Run(() => _worker.Dispose());
        }
    }
}
