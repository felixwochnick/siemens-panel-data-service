using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Eplan.EplApi.Starter;
using Eplan.EplApi.System;
using Microsoft.Extensions.Logging;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker.Eplan
{
    /// <summary>
    /// Besitzt die EPLAN-Instanz des Prozesses. EPLAN darf nur einmal initialisiert werden und muss von genau einem
    /// STA-Thread aus bedient werden; alle Aufrufe laufen daher über eine Warteschlange. Gestartet wird beim ersten
    /// <see cref="StartAsync"/> (erste Analyse), danach bleibt EPLAN geladen.
    /// </summary>
    internal sealed class EplanHost : IDisposable
    {
        private readonly bool _allowDialogs;
        private readonly ILogger _logger;
        private readonly BlockingCollection<Action> _queue = new BlockingCollection<Action>();
        private readonly TaskCompletionSource<bool> _ready =
            new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly object _sync = new object();
        private Thread _thread;
        private EplanPaths _paths;
        private EplanState _state = EplanState.NotStarted;
        private string _version;
        private bool _stopped;

        /// <param name="allowDialogs">Lizenz-/Login-Dialoge erlauben (nur bei interaktivem Start, nie als Dienst).</param>
        public EplanHost(bool allowDialogs, ILogger logger)
        {
            _allowDialogs = allowDialogs;
            _logger = logger;
        }

        public EplanStatus Status
        {
            get
            {
                lock (_sync)
                {
                    return new EplanStatus(_state, _state == EplanState.Ready ? _version : null, _paths);
                }
            }
        }

        /// <summary>
        /// Startet EPLAN mit <paramref name="paths"/>, falls noch nicht geschehen, und wartet, bis es bereit ist (oder
        /// mit dem Startfehler fehlschlägt). Ein zweiter Start mit anderen Pfaden ist nicht möglich.
        /// </summary>
        public Task StartAsync(EplanPaths paths)
        {
            lock (_sync)
            {
                if (_thread == null)
                {
                    if (_stopped)
                    {
                        throw new WorkerException(ErrorCodes.EplanStartFailed, "Der Worker wird beendet.");
                    }

                    _paths = paths;
                    _state = EplanState.Starting;
                    _thread = new Thread(ThreadMain) { Name = "EPLAN", IsBackground = true };
                    _thread.SetApartmentState(ApartmentState.STA);
                    _thread.Start();
                }
                else if (!_paths.Matches(paths))
                {
                    throw new WorkerException(ErrorCodes.RestartRequired,
                        "EPLAN läuft bereits mit anderen Pfaden (" + _paths + "); der Worker muss neu gestartet werden.");
                }
            }
            return _ready.Task;
        }

        /// <summary>Führt <paramref name="func"/> auf dem EPLAN-Thread aus. EPLAN muss gestartet sein.</summary>
        public async Task<T> InvokeAsync<T>(Func<T> func)
        {
            await _ready.Task.ConfigureAwait(false);

            var result = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            try
            {
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
            }
            catch (InvalidOperationException)
            {
                // CompleteAdding: der Worker wird beendet
                throw new WorkerException(ErrorCodes.ReadFailed, "EPLAN wird beendet.");
            }
            return await result.Task.ConfigureAwait(false);
        }

        /// <summary>
        /// Beendet EPLAN, nachdem laufende Aufträge abgearbeitet sind; wartet höchstens <paramref name="timeout"/>.
        /// <c>false</c>, wenn EPLAN in der Zeit nicht beendet wurde (z. B. hängende Analyse).
        /// </summary>
        public bool Shutdown(TimeSpan timeout)
        {
            Thread thread;
            lock (_sync)
            {
                if (_stopped)
                {
                    return _thread == null || !_thread.IsAlive;
                }
                _stopped = true;
                thread = _thread;
            }

            _queue.CompleteAdding();
            if (thread == null)
            {
                return true;
            }
            bool ended = thread.Join(timeout);
            if (!ended)
            {
                _logger.LogWarning("EPLAN hat sich nicht innerhalb von {Seconds} s beendet", (int)timeout.TotalSeconds);
            }
            return ended;
        }

        public void Dispose()
        {
            Shutdown(TimeSpan.FromSeconds(60));
        }

        private void ThreadMain()
        {
            EplanPaths paths;
            lock (_sync)
            {
                paths = _paths;
            }

            object app;
            try
            {
                _logger.LogInformation("Starte EPLAN ({ProductBin}) ...", paths.ProductBin);

                // Muss vor jedem Zugriff auf andere EPLAN-Typen passieren, damit die DLLs aus dem EPLAN-Bin-Ordner
                // geladen werden. Der Starter selbst kommt aus der EPLAN-Installation (StarterAssembly), daher erst
                // registrieren und dann in einer eigenen Methode auf seine Typen zugreifen.
                StarterAssembly.Register(paths.PlatformBin);
                PinToEplan(paths);

                string version;
                app = InitEplan(paths, out version);
                lock (_sync)
                {
                    _version = version;
                    _state = EplanState.Ready;
                }
                _ready.SetResult(true);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "EPLAN konnte nicht gestartet werden");
                lock (_sync)
                {
                    _state = EplanState.Failed;
                }
                _queue.CompleteAdding();
                _ready.SetException(new WorkerException(ErrorCodes.EplanStartFailed, StartError(ex), ex));
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
                try
                {
                    ExitEplan(app);
                    _logger.LogInformation("EPLAN beendet.");
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Fehler beim Beenden von EPLAN");
                }
            }
        }

        private static string StartError(Exception ex)
        {
#if EPLAN_STUBS
            if (ex is NotImplementedException)
            {
                return "Dieser Worker wurde gegen die Compile-Stubs gebaut und kann EPLAN nicht starten.";
            }
#endif
            return "EPLAN konnte nicht gestartet werden: " + ex.Message;
        }

        // Eigene Methoden ohne Inlining: EPLAN-Typen werden erst geladen, nachdem der AssemblyResolver aktiv ist
        // (bzw. beim Starter: nachdem StarterAssembly registriert ist)
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void PinToEplan(EplanPaths paths)
        {
            var resolver = new AssemblyResolver();
            resolver.SetBinPaths(paths.PlatformBin, paths.ProductBin);
            resolver.PinToEplan();
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private object InitEplan(EplanPaths paths, out string version)
        {
            var app = new EplApplication();
            app.EplanBinFolder = paths.ProductBin;
            if (!_allowDialogs)
            {
                app.QuietMode = EplApplication.QuietModes.ShowNoDialogs;
            }
            app.Init(paths.ApplicationModifier ?? "", _allowDialogs, _allowDialogs);

            version = Convert.ToString(app.Version, CultureInfo.InvariantCulture) ?? "";
            _logger.LogInformation("EPLAN gestartet: {Variant} {Version}", app.Variant, version);
            return app;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ExitEplan(object app)
        {
            ((EplApplication)app).Exit();
        }
    }
}
