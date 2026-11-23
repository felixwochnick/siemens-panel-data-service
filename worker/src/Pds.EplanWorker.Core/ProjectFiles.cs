using System;
using System.IO;
using System.Linq;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker
{
    /// <summary>
    /// Dateien eines EPLAN-Projekts: <c>.elk</c> (nur ein Verweis) mit gleichnamigem <c>.edb</c>-Ordner (Projektdaten)
    /// oder ein Archiv <c>.zw1</c>, das vor dem Öffnen nach <c>&lt;workFolder&gt;\restore</c> wiederhergestellt wird.
    /// </summary>
    public static class ProjectFiles
    {
        public const string RestoreFolderName = "restore";

        /// <summary>Prüft das Projekt vor dem (minutenlangen) Start von EPLAN.</summary>
        public static ProjectSource Resolve(AnalyzeRequest request)
        {
            string projectPath = Path.GetFullPath(request.ProjectPath);
            if (HasExtension(projectPath, ".zw1"))
            {
                if (!File.Exists(projectPath))
                {
                    throw new WorkerException(ErrorCodes.ProjectNotFound, "Archiv nicht gefunden: " + projectPath);
                }
                string restoreFolder = Path.Combine(Path.GetFullPath(request.WorkFolder), RestoreFolderName);
                return new ProjectSource(projectPath, true, restoreFolder, request.OpenMode);
            }

            if (HasExtension(projectPath, ".elk"))
            {
                if (!File.Exists(projectPath))
                {
                    throw new WorkerException(ErrorCodes.ProjectNotFound, "Projekt nicht gefunden: " + projectPath);
                }
                string dataFolder = Path.ChangeExtension(projectPath, ".edb");
                if (!Directory.Exists(dataFolder))
                {
                    throw new WorkerException(ErrorCodes.ProjectNotFound, "Projektordner fehlt: " + dataFolder);
                }
                return new ProjectSource(projectPath, false, null, request.OpenMode);
            }

            throw new WorkerException(ErrorCodes.InvalidRequest, "Projekt muss eine .elk- oder .zw1-Datei sein: " + projectPath);
        }

        /// <summary>Leert den Wiederherstellungsordner (Reste eines abgebrochenen Laufs) und legt ihn an.</summary>
        public static void PrepareRestoreFolder(string restoreFolder)
        {
            try
            {
                if (Directory.Exists(restoreFolder))
                {
                    Directory.Delete(restoreFolder, true);
                }
                Directory.CreateDirectory(restoreFolder);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                throw new WorkerException(ErrorCodes.RestoreFailed, "Ordner für die Wiederherstellung nicht nutzbar: " + restoreFolder + " (" + ex.Message + ")", ex);
            }
        }

        /// <summary>Die <c>.elk</c> eines wiederhergestellten Archivs (oberste Ebene des Ordners).</summary>
        public static string FindRestoredProject(string restoreFolder)
        {
            string[] projects = Directory.Exists(restoreFolder)
                ? Directory.GetFiles(restoreFolder, "*.elk", SearchOption.TopDirectoryOnly)
                    .Where(file => HasExtension(file, ".elk"))
                    .OrderBy(file => file, StringComparer.OrdinalIgnoreCase)
                    .ToArray()
                : new string[0];
            if (projects.Length == 0)
            {
                throw new WorkerException(ErrorCodes.ArchiveWithoutProject, "Archiv enthält kein Projekt (.elk).");
            }
            return projects[0];
        }

        /// <summary>Löscht einen Ordner samt Inhalt; <c>false</c> mit Fehlertext, wenn das nicht geht.</summary>
        public static bool TryDeleteFolder(string folder, out string error)
        {
            error = null;
            try
            {
                if (Directory.Exists(folder))
                {
                    Directory.Delete(folder, true);
                }
                return true;
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                error = ex.Message;
                return false;
            }
        }

        private static bool HasExtension(string path, string extension)
        {
            return string.Equals(Path.GetExtension(path), extension, StringComparison.OrdinalIgnoreCase);
        }
    }
}
