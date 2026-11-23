namespace Pds.EplanWorker.Protocol
{
    /// <summary>Feste Werte des Worker-Protokolls (siehe Spec, Abschnitt „Protokoll“).</summary>
    public static class ProtocolConstants
    {
        /// <summary>Protokollversion in <c>hello</c>; ändert sich nur bei inkompatiblen Änderungen.</summary>
        public const int ProtocolVersion = 1;

        /// <summary>Format der Rohdaten (<c>raw.json</c>, Feld <c>format</c>).</summary>
        public const int RawFormat = 1;

        /// <summary>Name der Named Pipe ohne <c>\\.\pipe\</c>.</summary>
        public const string DefaultPipeName = "pds-eplan";

        /// <summary>Name des Windows-Dienstes des Workers.</summary>
        public const string ServiceName = "pds-eplan";

        /// <summary>Dienst der Web-App; sein virtuelles Konto <c>NT SERVICE\pds</c> darf die Pipe benutzen.</summary>
        public const string WebServiceName = "pds";
    }

    /// <summary>Methoden einer Anfrage.</summary>
    public static class Methods
    {
        public const string Configure = "configure";
        public const string Status = "status";
        public const string Analyze = "analyze";
        public const string Exit = "exit";
    }

    /// <summary>Stufen einer Analyse (<c>progress.stage</c>), in dieser Reihenfolge.</summary>
    public static class Stages
    {
        public const string StartingEplan = "starting_eplan";
        public const string Restoring = "restoring";
        public const string Opening = "opening";
        public const string Reading = "reading";
        public const string Writing = "writing";
    }

    /// <summary>Stufen einer <c>log</c>-Nachricht.</summary>
    public static class LogLevels
    {
        public const string Info = "info";
        public const string Warn = "warn";
        public const string Error = "error";
    }

    /// <summary>Fehlercodes in <c>response.error.code</c> (snake_case, Übersetzung in der App).</summary>
    public static class ErrorCodes
    {
        public const string NotConfigured = "not_configured";
        public const string EplanStartFailed = "eplan_start_failed";
        public const string ProjectNotFound = "project_not_found";
        public const string RestoreFailed = "restore_failed";
        public const string ArchiveWithoutProject = "archive_without_project";
        public const string OpenFailed = "open_failed";
        public const string ReadFailed = "read_failed";
        public const string WriteFailed = "write_failed";
        public const string Busy = "busy";
        public const string InvalidRequest = "invalid_request";
        public const string RestartRequired = "restart_required";
    }
}
