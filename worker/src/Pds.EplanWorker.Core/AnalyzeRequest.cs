using System;
using System.Text.Json;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker
{
    /// <summary>Parameter von <c>analyze</c>.</summary>
    public sealed class AnalyzeRequest
    {
        /// <summary>Erlaubte Werte für <c>openMode</c> (Namen von <c>ProjectManager.OpenMode</c>).</summary>
        public static readonly string[] OpenModes = { "ReadOnly", "Standard", "Exclusive" };

        public AnalyzeRequest(string projectPath, string workFolder, string outputFile, string openMode)
        {
            ProjectPath = projectPath;
            WorkFolder = workFolder;
            OutputFile = outputFile;
            OpenMode = openMode;
        }

        /// <summary>Projekt (<c>.elk</c>) oder Archiv (<c>.zw1</c>).</summary>
        public string ProjectPath { get; }

        /// <summary>Arbeitsordner; ein Archiv wird nach <c>&lt;workFolder&gt;\restore</c> wiederhergestellt.</summary>
        public string WorkFolder { get; }

        /// <summary>Ziel der Rohdaten (<c>raw.json</c>).</summary>
        public string OutputFile { get; }

        /// <summary>ReadOnly (Standard), Standard oder Exclusive.</summary>
        public string OpenMode { get; }

        public static AnalyzeRequest FromParams(JsonElement parameters)
        {
            string openMode = ParamReader.OptionalString(parameters, "openMode", "ReadOnly");
            string canonical = Array.Find(OpenModes, mode => string.Equals(mode, openMode, StringComparison.OrdinalIgnoreCase));
            if (canonical == null)
            {
                throw ParamReader.Invalid("Parameter \"openMode\" muss ReadOnly, Standard oder Exclusive sein.");
            }

            return new AnalyzeRequest(
                ParamReader.RequiredString(parameters, "projectPath"),
                ParamReader.RequiredString(parameters, "workFolder"),
                ParamReader.RequiredString(parameters, "outputFile"),
                canonical);
        }
    }

    /// <summary>Was der <see cref="IProjectReader"/> öffnen soll, nach den Prüfungen von <see cref="ProjectFiles"/>.</summary>
    public sealed class ProjectSource
    {
        public ProjectSource(string projectPath, bool isArchive, string restoreFolder, string openMode)
        {
            ProjectPath = projectPath;
            IsArchive = isArchive;
            RestoreFolder = restoreFolder;
            OpenMode = openMode;
        }

        /// <summary>Vollständiger Pfad der <c>.elk</c> bzw. <c>.zw1</c>.</summary>
        public string ProjectPath { get; }

        public bool IsArchive { get; }

        /// <summary>Leerer Ordner für die Wiederherstellung (nur bei Archiven, sonst <c>null</c>).</summary>
        public string RestoreFolder { get; }

        public string OpenMode { get; }
    }

    /// <summary>Ergebnis von <c>analyze</c>.</summary>
    public sealed class AnalyzeResult
    {
        public AnalyzeResult(string outputFile, int pages, int connections)
        {
            OutputFile = outputFile;
            Pages = pages;
            Connections = connections;
        }

        public string OutputFile { get; }

        public int Pages { get; }

        /// <summary>Alle Verbindungen der Rohdaten (auch 3D).</summary>
        public int Connections { get; }

        internal void Write(Utf8JsonWriter writer)
        {
            writer.WriteString("outputFile", JsonText.Clean(OutputFile));
            writer.WriteNumber("pages", Pages);
            writer.WriteNumber("connections", Connections);
        }
    }
}
