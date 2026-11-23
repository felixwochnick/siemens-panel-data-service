using System;
using System.IO;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Ein EPLAN Projekt besteht aus der .elk Datei (nur ein Verweis) und dem gleichnamigen .edb Ordner mit den Projektdaten.
    /// Alternativ kann ein Projekt als Archiv (.zw1) vorliegen, das vor dem Export wiederhergestellt wird.
    /// </summary>
    internal static class ProjectFiles
    {
        /// <summary>Erlaubt statt der .elk Datei auch den .edb Ordner anzugeben.</summary>
        public static string ResolveProjectFile(string path)
        {
            string fullPath = Path.GetFullPath(path.TrimEnd('\\', '/'));
            if (Directory.Exists(fullPath) && HasExtension(fullPath, ".edb"))
            {
                return Path.ChangeExtension(fullPath, ".elk");
            }
            return fullPath;
        }

        public static bool IsArchive(string path)
        {
            return HasExtension(path, ".zw1");
        }

        /// <summary>Prüft, ob das Projekt exportiert werden kann: Archiv oder .elk mit .edb Ordner.</summary>
        public static bool HasProjectData(string path)
        {
            return IsArchive(path) || Directory.Exists(DataFolder(path));
        }

        public static string DataFolder(string projectPath)
        {
            return Path.ChangeExtension(Path.GetFullPath(projectPath), ".edb");
        }

        /// <summary>Temporärer Ordner für ein wiederhergestelltes Archiv: %TEMP%\EplanElectricP8Api\&lt;Dateiname&gt;.</summary>
        public static string RestoreFolder(string archivePath)
        {
            return Path.Combine(Path.GetTempPath(), "EplanElectricP8Api", Path.GetFileNameWithoutExtension(archivePath));
        }

        private static bool HasExtension(string path, string extension)
        {
            return string.Equals(Path.GetExtension(path), extension, StringComparison.OrdinalIgnoreCase);
        }
    }
}
