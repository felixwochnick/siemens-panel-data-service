using System;
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Eplan.EplApi.Starter;
using Eplan.EplApi.System;
using Microsoft.Extensions.Logging;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Besitzt die EPLAN Instanz des Prozesses. EPLAN darf nur einmal initialisiert werden und muss
    /// von genau einem STA-Thread aus bedient werden; alle Aufrufe laufen daher über eine Warteschlange.
    /// </summary>
    internal sealed class EplanWorker : IDisposable
    {
        private readonly EplanConfig _config;
        private readonly bool _allowDialogs;
        private readonly ILogger<EplanWorker> _logger;
        private readonly BlockingCollection<Action> _queue = new BlockingCollection<Action>();
        private readonly TaskCompletionSource<bool> _ready =
            new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        private Thread _thread;
        private int _disposed;

        /// <param name="allowDialogs">Lizenz-/Login-Dialoge erlauben (nur bei interaktivem Start, nicht als Dienst).</param>
        public EplanWorker(EplanConfig config, bool allowDialogs, ILogger<EplanWorker> logger)
        {
            _config = config;
            _allowDialogs = allowDialogs;
            _logger = logger;
        }

        /// <summary>Wird abgeschlossen, sobald EPLAN initialisiert ist (oder schlägt mit dem Startfehler fehl).</summary>
        public Task Ready => _ready.Task;

        /// <summary>Startet den EPLAN-Thread. Kehrt sofort zurück; der Start von EPLAN dauert ggf. länger.</summary>
        public void Start()
        {
            lock (_queue)
            {
                if (_thread != null)
                {
                    return;
                }

                _thread = new Thread(ThreadMain) { Name = "EPLAN", IsBackground = true };
                _thread.SetApartmentState(ApartmentState.STA);
                _thread.Start();
            }
        }

        /// <summary>Führt <paramref name="func"/> auf dem EPLAN-Thread aus. Startet EPLAN bei Bedarf.</summary>
        public async Task<T> InvokeAsync<T>(Func<T> func)
        {
            Start();
            await _ready.Task.ConfigureAwait(false);

            var result = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Add(() =>
            {
                try
                {
                    result.SetResult(func());
                }
                catch (Exception ex)
                {
                    result.SetException(ex);
                }
            });
            return await result.Task.ConfigureAwait(false);
        }

        /// <summary>Wartet, bis laufende Aufträge abgearbeitet sind, und beendet EPLAN.</summary>
        public void Dispose()
        {
            // Kann mehrfach aufgerufen werden (Hosted Service und DI-Container)
            if (Interlocked.Exchange(ref _disposed, 1) == 1)
            {
                return;
            }

            _queue.CompleteAdding();
            _thread?.Join();
            _queue.Dispose();
        }

        private void ThreadMain()
        {
            object app;
            try
            {
                _logger.LogInformation("Starte EPLAN ({ProductBin}) ...", _config.ProductBin);

                // Muss vor jedem Zugriff auf andere EPLAN Typen passieren, damit die DLLs aus dem EPLAN Bin-Ordner geladen werden
                var resolver = new AssemblyResolver();
                resolver.SetBinPaths(_config.PlatformBin, _config.ProductBin);
                resolver.PinToEplan();

                app = InitEplan();
                _ready.SetResult(true);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "EPLAN konnte nicht gestartet werden");
                _queue.CompleteAdding();
                _ready.SetException(ex);
                return;
            }

            try
            {
                foreach (var work in _queue.GetConsumingEnumerable())
                {
                    work();
                }
            }
            finally
            {
                ExitEplan(app);
                _logger.LogInformation("EPLAN beendet.");
            }
        }

        // Eigene Methoden ohne Inlining: EPLAN Typen werden erst geladen, nachdem der AssemblyResolver aktiv ist
        [MethodImpl(MethodImplOptions.NoInlining)]
        private object InitEplan()
        {
            var app = new EplApplication();
            app.EplanBinFolder = _config.ProductBin;
            if (!_allowDialogs)
            {
                app.QuietMode = EplApplication.QuietModes.ShowNoDialogs;
            }
            app.Init(_config.ApplicationModifier ?? "", _allowDialogs, _allowDialogs);

            _logger.LogInformation("EPLAN gestartet: {Variant} {Version}", app.Variant, app.Version);
            return app;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ExitEplan(object app)
        {
            ((EplApplication)app).Exit();
        }
    }
}
