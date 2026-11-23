using System;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker
{
    public enum WorkerMode
    {
        /// <summary>Windows-Dienst, lauscht auf der Named Pipe.</summary>
        Service,

        /// <summary>Wie <see cref="Service"/>, aber in der Konsole (Fehlersuche).</summary>
        Run,

        /// <summary>Eine Sitzung über stdin/stdout (Entwicklung: Nuxt startet den Worker).</summary>
        Stdio,
    }

    /// <summary>Kommandozeile von <c>pds-eplan.exe</c>.</summary>
    public sealed class CommandLineOptions
    {
        public const string Usage =
            "Aufruf: pds-eplan <service|run|stdio> [Optionen]\n" +
            "\n" +
            "  service            Windows-Dienst, lauscht auf \\\\.\\pipe\\<name>\n" +
            "  run                dasselbe in der Konsole (Fehlersuche)\n" +
            "  stdio              eine Sitzung über stdin/stdout\n" +
            "\n" +
            "Optionen:\n" +
            "  --pipe <name>      Name der Named Pipe (Standard: " + ProtocolConstants.DefaultPipeName + "; nicht mit stdio)\n" +
            "  --log-dir <ordner> Ordner für eplan-worker-<Datum>.log\n" +
            "                     (Standard: %ProgramData%\\EPLAN Panel Data Service\\logs)\n" +
            "  --dialogs          Dialoge von EPLAN erlauben (Lizenz, Anmeldung; nur run und stdio)\n" +
            "  --help             diese Hilfe\n" +
            "  --version          Version ausgeben\n";

        private const string PipePrefix = @"\\.\pipe\";

        public WorkerMode Mode { get; private set; }

        /// <summary>Pipe-Name ohne <c>\\.\pipe\</c>.</summary>
        public string PipeName { get; private set; } = ProtocolConstants.DefaultPipeName;

        public string LogDirectory { get; private set; }

        public bool AllowDialogs { get; private set; }

        public bool ShowHelp { get; private set; }

        public bool ShowVersion { get; private set; }

        /// <summary>Wirft <see cref="ArgumentException"/> mit verständlicher Meldung bei falschen Argumenten.</summary>
        public static CommandLineOptions Parse(string[] args, string defaultLogDirectory)
        {
            var options = new CommandLineOptions { LogDirectory = defaultLogDirectory };
            string mode = null;
            bool pipeGiven = false;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                string name = arg;
                string inlineValue = null;
                int equals = arg.IndexOf('=');
                if (arg.StartsWith("--", StringComparison.Ordinal) && equals > 0)
                {
                    name = arg.Substring(0, equals);
                    inlineValue = arg.Substring(equals + 1);
                }

                switch (name)
                {
                    case "--help":
                    case "-h":
                    case "/?":
                        options.ShowHelp = true;
                        break;
                    case "--version":
                        options.ShowVersion = true;
                        break;
                    case "--dialogs":
                        options.AllowDialogs = true;
                        break;
                    case "--pipe":
                        options.PipeName = NormalizePipeName(inlineValue ?? Value(args, ref i, name));
                        pipeGiven = true;
                        break;
                    case "--log-dir":
                        options.LogDirectory = inlineValue ?? Value(args, ref i, name);
                        if (options.LogDirectory.Trim().Length == 0)
                        {
                            throw new ArgumentException("--log-dir braucht einen Ordner.");
                        }
                        break;
                    default:
                        if (arg.StartsWith("-", StringComparison.Ordinal))
                        {
                            throw new ArgumentException("Unbekannte Option: " + arg);
                        }
                        if (mode != null)
                        {
                            throw new ArgumentException("Nur eine Betriebsart angeben (zusätzlich: " + arg + ").");
                        }
                        mode = arg;
                        break;
                }
            }

            if (options.ShowHelp || options.ShowVersion)
            {
                return options;
            }

            switch (mode)
            {
                case "service":
                    options.Mode = WorkerMode.Service;
                    break;
                case "run":
                    options.Mode = WorkerMode.Run;
                    break;
                case "stdio":
                    options.Mode = WorkerMode.Stdio;
                    break;
                case null:
                    throw new ArgumentException("Betriebsart fehlt (service, run oder stdio).");
                default:
                    throw new ArgumentException("Unbekannte Betriebsart: " + mode);
            }

            if (options.AllowDialogs && options.Mode == WorkerMode.Service)
            {
                // Ein Dienst hat keinen Desktop; ein Dialog würde EPLAN unsichtbar blockieren
                throw new ArgumentException("--dialogs geht nur mit run oder stdio.");
            }
            if (pipeGiven && options.Mode == WorkerMode.Stdio)
            {
                throw new ArgumentException("--pipe geht nicht mit stdio.");
            }
            return options;
        }

        private static string Value(string[] args, ref int i, string name)
        {
            if (i + 1 >= args.Length || args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException(name + " braucht einen Wert.");
            }
            return args[++i];
        }

        /// <summary>Erlaubt auch <c>\\.\pipe\name</c>; Ergebnis ist nur der Name.</summary>
        private static string NormalizePipeName(string value)
        {
            string name = value.Trim();
            if (name.StartsWith(PipePrefix, StringComparison.OrdinalIgnoreCase))
            {
                name = name.Substring(PipePrefix.Length);
            }
            if (name.Length == 0 || name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0)
            {
                throw new ArgumentException("Ungültiger Pipe-Name: " + value);
            }
            return name;
        }
    }
}
