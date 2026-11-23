using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using Eplan.EplApi.ApplicationFramework;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.HEServices;
using Microsoft.Extensions.Logging;

namespace EplanElectricP8Api
{
    /// <summary>Ergebnis des Exports eines Projekts.</summary>
    internal sealed class ExportResult
    {
        public List<string> Files { get; } = new List<string>();
        public List<string> Errors { get; } = new List<string>();
        public bool Success => Errors.Count == 0;
    }

    /// <summary>
    /// Öffnet ein EPLAN Projekt und führt die konfigurierten Beschriftungs-Exporte (Action "label") aus.
    /// Darf nur auf dem EPLAN-Thread aufgerufen werden (siehe <see cref="EplanWorker"/>).
    /// </summary>
    internal sealed class ProjectExporter
    {
        private readonly ExportConfig _config;
        private readonly ILogger<ProjectExporter> _logger;

        public ProjectExporter(ExportConfig config, ILogger<ProjectExporter> logger)
        {
            _config = config;
            _logger = logger;
        }

        /// <summary>
        /// Exportiert ein Projekt (.elk) oder Projektarchiv (.zw1) nach &lt;outputFolder&gt;\&lt;Projektname&gt;.
        /// </summary>
        public ExportResult Export(string projectPath, string outputFolder)
        {
            if (!ProjectFiles.IsArchive(projectPath))
            {
                return ExportLocked(projectPath, outputFolder);
            }

            string restoreFolder = ProjectFiles.RestoreFolder(projectPath);
            try
            {
                string restoredProject = RestoreArchive(projectPath, restoreFolder);
                return ExportLocked(restoredProject, outputFolder);
            }
            finally
            {
                DeleteRestoreFolder(restoreFolder);
            }
        }

        private ExportResult ExportLocked(string projectPath, string outputFolder)
        {
            // Zugriffe auf Projektdaten brauchen einen aktiven LockingStep; er gibt beim Dispose alle Sperren wieder frei
            using (new LockingStep())
            {
                return ExportProject(projectPath, outputFolder);
            }
        }

        /// <summary>Stellt ein .zw1 Archiv wieder her und gibt den Pfad der entpackten .elk Datei zurück.</summary>
        private string RestoreArchive(string archivePath, string restoreFolder)
        {
            // Reste eines abgebrochenen Laufs entfernen
            DeleteRestoreFolder(restoreFolder);
            Directory.CreateDirectory(restoreFolder);

            string projectName = Path.GetFileNameWithoutExtension(archivePath);
            _logger.LogInformation("Stelle Archiv {Archive} nach {Folder} wieder her", archivePath, restoreFolder);

            using (new LockingStep())
            using (var restore = new Restore())
            {
                var archives = new StringCollection { archivePath };
                restore.Project(archives, restoreFolder, projectName, false, true);
            }

            string[] projects = Directory.GetFiles(restoreFolder, "*.elk");
            if (projects.Length == 0)
            {
                throw new InvalidOperationException("Archiv enthält kein Projekt (.elk): " + archivePath);
            }
            return projects[0];
        }

        private void DeleteRestoreFolder(string restoreFolder)
        {
            if (!Directory.Exists(restoreFolder))
            {
                return;
            }

            try
            {
                Directory.Delete(restoreFolder, true);
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Temporärer Ordner konnte nicht gelöscht werden: {Folder} ({Error})", restoreFolder, ex.Message);
            }
        }

        private ExportResult ExportProject(string projectPath, string outputFolder)
        {
            var result = new ExportResult();
            string projectName = Path.GetFileNameWithoutExtension(projectPath);
            string projectOutput = Path.Combine(outputFolder, projectName);
            Directory.CreateDirectory(projectOutput);

            _logger.LogInformation("Öffne Projekt {Project}", projectPath);
            Project project = new ProjectManager().OpenProject(projectPath, ParseOpenMode(_config.OpenMode));
            if (project == null)
            {
                result.Errors.Add("Projekt konnte nicht geöffnet werden.");
                return result;
            }

            try
            {
                _logger.LogInformation("Projekt {Name} geöffnet ({Pages} Seiten)", project.ProjectName, project.Pages.Length);

                ExportConnections(project, projectName, projectOutput, result);

                var cli = new CommandLineInterpreter();
                foreach (var label in _config.Labels)
                {
                    string destinationFile = Path.Combine(projectOutput, label.FileName.Replace("{project}", projectName));
                    string error = ExportLabel(cli, projectPath, label, destinationFile);
                    if (error == null)
                    {
                        _logger.LogInformation("  {Name}: OK -> {File}", label.Name, destinationFile);
                        result.Files.Add(destinationFile);
                    }
                    else
                    {
                        _logger.LogError("  {Name}: {Error}", label.Name, error);
                        result.Errors.Add(label.Name + ": " + error);
                    }
                }
            }
            finally
            {
                project.Close();
            }

            return result;
        }

        private void ExportConnections(Project project, string projectName, string projectOutput, ExportResult result)
        {
            string destinationFile = Path.Combine(projectOutput, projectName + "_Verbindungen.xlsx");
            try
            {
                var export = ConnectionExporter.Export(project, destinationFile);
                _logger.LogInformation("  Verbindungen: OK ({Count}, davon {Marked} mit #, {Twisted} verdrillt ({TwistSymbols} Verdrillungssymbol(e)), {Shielded} abgeschirmt an {Shields} Schirm(en)), {Cables} Kabeldefinition(en), {Texts} Text(e) -> {File}",
                    export.Count, export.Marked, export.Twisted, export.TwistSymbols, export.Shielded, export.Shields, export.Cables, export.Texts, destinationFile);
                if (export.UnmatchedMarks > 0)
                {
                    _logger.LogWarning("  Verbindungen: {Unmatched} #-Markierung(en) konnten keiner Verbindung zugeordnet werden", export.UnmatchedMarks);
                }
                if (export.UnmatchedTwistMarks > 0)
                {
                    _logger.LogWarning("  Verbindungen: {Unmatched} Ader(n) an Verdrillungssymbolen konnten keiner Verbindung zugeordnet werden", export.UnmatchedTwistMarks);
                }
                result.Files.Add(destinationFile);
            }
            catch (Exception ex)
            {
                _logger.LogError("  Verbindungen: {Error}", ex.Message);
                result.Errors.Add("Verbindungen: " + ex.Message);
            }
        }

        /// <summary>Gibt null bei Erfolg zurück, sonst eine Fehlermeldung.</summary>
        private string ExportLabel(CommandLineInterpreter cli, string projectPath, LabelExportConfig label, string destinationFile)
        {
            // Alte Datei entfernen, damit eine nicht erzeugte Datei als Fehler erkannt wird
            if (File.Exists(destinationFile))
            {
                File.Delete(destinationFile);
            }

            var context = new ActionCallingContext();
            context.AddParameter("Project", projectPath);
            context.AddParameter("ConfigScheme", label.ConfigScheme);
            context.AddParameter("DestinationFile", destinationFile);
            context.AddParameter("Language", _config.Language);

            try
            {
                // Execute meldet über den Rückgabewert, ob die Action erfolgreich war
                if (!cli.Execute("label", context))
                {
                    return "Action 'label' mit Schema '" + label.ConfigScheme + "' fehlgeschlagen.";
                }
            }
            catch (Exception ex)
            {
                return ex.Message;
            }

            return File.Exists(destinationFile) ? null : "Datei wurde nicht erzeugt.";
        }

        private static ProjectManager.OpenMode ParseOpenMode(string openMode)
        {
            return Enum.TryParse(openMode, true, out ProjectManager.OpenMode mode) ? mode : ProjectManager.OpenMode.ReadOnly;
        }
    }
}
