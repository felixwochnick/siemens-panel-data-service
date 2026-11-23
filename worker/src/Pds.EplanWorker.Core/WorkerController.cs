using System;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Pds.EplanWorker.Protocol;
using Pds.EplanWorker.Raw;

namespace Pds.EplanWorker
{
    /// <summary>
    /// Zustand des Worker-Prozesses über alle Sitzungen hinweg: EPLAN gibt es je Prozess nur einmal, also auch nur eine
    /// Konfiguration und höchstens eine laufende Analyse – auch wenn der Client die Verbindung trennt und neu verbindet.
    /// </summary>
    public sealed class WorkerController
    {
        private readonly IProjectReader _reader;
        private readonly ILogger _logger;
        private readonly object _sync = new object();
        private EplanPaths _configured;
        private EplanPaths _committed;
        private bool _busy;

        public WorkerController(IProjectReader reader, string version, ILogger logger)
        {
            _reader = reader ?? throw new ArgumentNullException(nameof(reader));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            Version = string.IsNullOrEmpty(version) ? "0.0.0" : version;
        }

        /// <summary>Version des Workers (hello, raw.json).</summary>
        public string Version { get; }

        public bool IsBusy
        {
            get
            {
                lock (_sync)
                {
                    return _busy;
                }
            }
        }

        /// <summary>Antwort auf <c>status</c>; blockiert nie (auch nicht während EPLAN startet oder liest).</summary>
        public void WriteStatus(System.Text.Json.Utf8JsonWriter writer)
        {
            EplanStatus eplan = _reader.Eplan ?? EplanStatus.NotStarted;
            bool busy, configured;
            lock (_sync)
            {
                busy = _busy;
                configured = _configured != null;
            }

            writer.WriteString("eplan", EplanStatus.ToProtocol(eplan.State));
            if (eplan.State == EplanState.Ready && !string.IsNullOrEmpty(eplan.Version))
            {
                writer.WriteString("eplanVersion", JsonText.Clean(eplan.Version));
            }
            else
            {
                writer.WriteNull("eplanVersion");
            }
            writer.WriteBoolean("busy", busy);
            writer.WriteBoolean("configured", configured);
        }

        /// <summary>
        /// Übernimmt die Pfade. Ist EPLAN schon mit anderen Pfaden gestartet (oder ein Start damit begonnen), geht das
        /// nicht mehr: EPLAN lässt sich je Prozess nur einmal initialisieren ⇒ <c>restart_required</c>.
        /// </summary>
        public void Configure(EplanPaths paths)
        {
            lock (_sync)
            {
                EplanPaths started = _committed ?? _reader.Eplan?.Paths;
                if (started != null && !started.Matches(paths))
                {
                    throw new WorkerException(ErrorCodes.RestartRequired,
                        "EPLAN läuft bereits mit anderen Pfaden (" + started + "); der Worker muss neu gestartet werden.");
                }
                _configured = paths;
            }
            _logger.LogInformation("Konfiguriert: {Paths}", paths);
        }

        /// <summary>Reserviert den Worker für eine Analyse; <c>not_configured</c> oder <c>busy</c>, wenn das nicht geht.</summary>
        public AnalysisLease BeginAnalysis()
        {
            lock (_sync)
            {
                if (_configured == null)
                {
                    throw new WorkerException(ErrorCodes.NotConfigured, "Vor analyze muss configure aufgerufen werden.");
                }
                if (_busy)
                {
                    throw new WorkerException(ErrorCodes.Busy, "Es läuft bereits eine Analyse.");
                }
                _busy = true;
                return new AnalysisLease(this, _configured);
            }
        }

        /// <summary>
        /// Analyse: Projekt prüfen, Wiederherstellungsordner vorbereiten, mit EPLAN lesen, raw.json schreiben,
        /// Wiederherstellungsordner löschen. Fehler als <see cref="WorkerException"/>.
        /// </summary>
        public async Task<AnalyzeResult> AnalyzeAsync(AnalysisLease lease, AnalyzeRequest request, IAnalysisReporter reporter)
        {
            ProjectSource source = ProjectFiles.Resolve(request);
            if (source.IsArchive)
            {
                ProjectFiles.PrepareRestoreFolder(source.RestoreFolder);
            }

            RawProject raw;
            try
            {
                CommitPaths(lease.Paths);
                raw = await _reader.ReadAsync(lease.Paths, source, reporter).ConfigureAwait(false);
            }
            finally
            {
                if (source.IsArchive && !ProjectFiles.TryDeleteFolder(source.RestoreFolder, out string error))
                {
                    _logger.LogWarning("Wiederherstellungsordner {Folder} nicht gelöscht: {Error}", source.RestoreFolder, error);
                    reporter.Log(LogLevels.Warn, "restore_cleanup_failed", "Ordner nicht gelöscht: " + source.RestoreFolder + " (" + error + ")");
                }
            }

            if (raw == null)
            {
                throw new WorkerException(ErrorCodes.ReadFailed, "Keine Rohdaten gelesen.");
            }
            raw.Worker = Version;

            reporter.Progress(Stages.Writing);
            try
            {
                RawJsonWriter.WriteFile(request.OutputFile, raw);
            }
            catch (Exception ex) when (!(ex is WorkerException))
            {
                throw new WorkerException(ErrorCodes.WriteFailed, "Rohdaten nicht geschrieben: " + request.OutputFile + " (" + ex.Message + ")", ex);
            }

            return new AnalyzeResult(request.OutputFile, raw.Pages.Count, raw.Connections.Count);
        }

        /// <summary>
        /// Merkt sich die Pfade des (ersten) EPLAN-Starts. Wurde zwischen <c>configure</c> und diesem Punkt schon mit
        /// anderen Pfaden gestartet, darf diese Analyse EPLAN nicht verwenden.
        /// </summary>
        private void CommitPaths(EplanPaths paths)
        {
            lock (_sync)
            {
                if (_committed == null)
                {
                    _committed = paths;
                }
                else if (!_committed.Matches(paths))
                {
                    throw new WorkerException(ErrorCodes.RestartRequired,
                        "EPLAN läuft bereits mit anderen Pfaden (" + _committed + "); der Worker muss neu gestartet werden.");
                }
            }
        }

        private void EndAnalysis()
        {
            lock (_sync)
            {
                _busy = false;
            }
        }

        /// <summary>Reservierung einer Analyse; <see cref="Dispose"/> gibt den Worker wieder frei.</summary>
        public sealed class AnalysisLease : IDisposable
        {
            private WorkerController _owner;

            internal AnalysisLease(WorkerController owner, EplanPaths paths)
            {
                _owner = owner;
                Paths = paths;
            }

            /// <summary>Konfiguration zum Zeitpunkt der Anfrage.</summary>
            public EplanPaths Paths { get; }

            public void Dispose()
            {
                System.Threading.Interlocked.Exchange(ref _owner, null)?.EndAnalysis();
            }
        }
    }
}
