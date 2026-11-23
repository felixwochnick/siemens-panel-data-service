using System;
using System.Collections.Specialized;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.HEServices;
using Microsoft.Extensions.Logging;
using Pds.EplanWorker.Protocol;
using Pds.EplanWorker.Raw;

namespace Pds.EplanWorker.Eplan
{
    /// <summary>
    /// Liest ein Projekt mit EPLAN: EPLAN bei Bedarf starten, Archiv wiederherstellen, öffnen, Rohdaten lesen,
    /// schließen. Alle EPLAN-Zugriffe laufen auf dem EPLAN-Thread (<see cref="EplanHost"/>).
    /// </summary>
    internal sealed class ProjectReader : IProjectReader
    {
        private readonly EplanHost _host;
        private readonly ILogger _logger;

        public ProjectReader(EplanHost host, ILogger logger)
        {
            _host = host;
            _logger = logger;
        }

        public EplanStatus Eplan => _host.Status;

        public async Task<RawProject> ReadAsync(EplanPaths eplan, ProjectSource source, IAnalysisReporter reporter)
        {
            if (_host.Status.State != EplanState.Ready)
            {
                reporter.Progress(Stages.StartingEplan);
            }
            try
            {
                await _host.StartAsync(eplan).ConfigureAwait(false);
            }
            catch (WorkerException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new WorkerException(ErrorCodes.EplanStartFailed, "EPLAN konnte nicht gestartet werden: " + ex.Message, ex);
            }

            string eplanVersion = _host.Status.Version ?? "";
            // Kein EPLAN-Typ in dieser Methode: sie wird kompiliert, bevor der AssemblyResolver aktiv ist
            return await _host.InvokeAsync(() => ReadOnEplanThread(source, eplanVersion, reporter, _logger)).ConfigureAwait(false);
        }

        /// <summary>Läuft auf dem EPLAN-Thread.</summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static RawProject ReadOnEplanThread(ProjectSource source, string eplanVersion, IAnalysisReporter reporter, ILogger logger)
        {
            string projectFile = source.ProjectPath;
            if (source.IsArchive)
            {
                reporter.Progress(Stages.Restoring);
                RestoreArchive(source.ProjectPath, source.RestoreFolder, logger);
                projectFile = ProjectFiles.FindRestoredProject(source.RestoreFolder);
            }

            reporter.Progress(Stages.Opening);
            // Zugriffe auf Projektdaten brauchen einen aktiven LockingStep; er gibt beim Dispose alle Sperren wieder frei
            using (new LockingStep())
            {
                Project project = OpenProject(projectFile, source.OpenMode, logger);
                try
                {
                    reporter.Progress(Stages.Reading);
                    RawProject raw;
                    try
                    {
                        raw = new RawExtractor(reporter).Extract(project, eplanVersion);
                    }
                    catch (Exception ex) when (!(ex is WorkerException))
                    {
                        logger.LogError(ex, "Lesen von {Project} fehlgeschlagen", projectFile);
                        throw new WorkerException(ErrorCodes.ReadFailed, "Projekt nicht lesbar: " + ex.Message, ex);
                    }
                    logger.LogInformation("{Project}: {Pages} Seiten, {Connections} Verbindungen, {Texts} Texte, {Lines} Linien gelesen",
                        projectFile, raw.Pages.Count, raw.Connections.Count, raw.Texts.Count, raw.Lines.Count);
                    return raw;
                }
                finally
                {
                    CloseProject(project, logger);
                }
            }
        }

        /// <summary>Stellt ein .zw1-Archiv in den (leeren) Ordner wieder her.</summary>
        private static void RestoreArchive(string archivePath, string restoreFolder, ILogger logger)
        {
            string projectName = Path.GetFileNameWithoutExtension(archivePath);
            logger.LogInformation("Stelle Archiv {Archive} nach {Folder} wieder her", archivePath, restoreFolder);
            try
            {
                using (new LockingStep())
                using (var restore = new Restore())
                {
                    var archives = new StringCollection { archivePath };
                    restore.Project(archives, restoreFolder, projectName, false, true);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Wiederherstellen von {Archive} fehlgeschlagen", archivePath);
                throw new WorkerException(ErrorCodes.RestoreFailed, "Archiv nicht wiederhergestellt: " + ex.Message, ex);
            }
        }

        private static Project OpenProject(string projectFile, string openMode, ILogger logger)
        {
            logger.LogInformation("Öffne Projekt {Project} ({OpenMode})", projectFile, openMode);
            Project project;
            try
            {
                project = new ProjectManager().OpenProject(projectFile, ParseOpenMode(openMode));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Öffnen von {Project} fehlgeschlagen", projectFile);
                throw new WorkerException(ErrorCodes.OpenFailed, "Projekt nicht geöffnet: " + ex.Message, ex);
            }
            if (project == null)
            {
                throw new WorkerException(ErrorCodes.OpenFailed, "Projekt nicht geöffnet: " + projectFile);
            }
            return project;
        }

        private static void CloseProject(Project project, ILogger logger)
        {
            try
            {
                project.Close();
            }
            catch (Exception ex)
            {
                logger.LogWarning("Projekt nicht sauber geschlossen: {Error}", ex.Message);
            }
        }

        private static ProjectManager.OpenMode ParseOpenMode(string openMode)
        {
            // AnalyzeRequest lässt nur ReadOnly, Standard und Exclusive zu
            return Enum.TryParse(openMode, true, out ProjectManager.OpenMode mode) ? mode : ProjectManager.OpenMode.ReadOnly;
        }
    }
}
