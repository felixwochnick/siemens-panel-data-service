using System;
using System.Text.Json;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker
{
    /// <summary>Pfade, mit denen EPLAN gestartet wird (Parameter von <c>configure</c>).</summary>
    public sealed class EplanPaths
    {
        public EplanPaths(string platformBin, string productBin, string applicationModifier)
        {
            PlatformBin = platformBin ?? "";
            ProductBin = productBin ?? "";
            ApplicationModifier = applicationModifier ?? "";
        }

        /// <summary>Bin-Ordner der EPLAN Platform (enthält die Eplan.EplApi.*.dll).</summary>
        public string PlatformBin { get; }

        /// <summary>Bin-Ordner der Produktvariante (enthält die W3u.exe).</summary>
        public string ProductBin { get; }

        /// <summary>Leer = Variante aus der install.xml verwenden.</summary>
        public string ApplicationModifier { get; }

        public static EplanPaths FromParams(JsonElement parameters)
        {
            return new EplanPaths(
                ParamReader.RequiredString(parameters, "platformBin"),
                ParamReader.RequiredString(parameters, "productBin"),
                ParamReader.OptionalString(parameters, "applicationModifier", ""));
        }

        /// <summary>
        /// Gleiche Pfade wie bei Windows üblich: ohne Groß-/Kleinschreibung und abschließenden Trenner, damit
        /// „…\Bin“ und „…\bin\“ kein <c>restart_required</c> auslösen.
        /// </summary>
        public bool Matches(EplanPaths other)
        {
            return other != null
                && SamePath(PlatformBin, other.PlatformBin)
                && SamePath(ProductBin, other.ProductBin)
                && string.Equals(ApplicationModifier.Trim(), other.ApplicationModifier.Trim(), StringComparison.OrdinalIgnoreCase);
        }

        public override string ToString()
        {
            return "platformBin=" + PlatformBin + ", productBin=" + ProductBin + ", applicationModifier=" + ApplicationModifier;
        }

        private static bool SamePath(string a, string b)
        {
            return string.Equals(Normalize(a), Normalize(b), StringComparison.OrdinalIgnoreCase);
        }

        private static string Normalize(string path)
        {
            return path.Trim().TrimEnd('\\', '/');
        }
    }

    /// <summary>Zustand von EPLAN im Worker-Prozess (<c>status.eplan</c>).</summary>
    public enum EplanState
    {
        NotStarted,
        Starting,
        Ready,
        Failed,
    }

    /// <summary>Momentaufnahme: Zustand, Version (sobald bereit) und die Pfade, mit denen EPLAN gestartet wurde.</summary>
    public sealed class EplanStatus
    {
        public static readonly EplanStatus NotStarted = new EplanStatus(EplanState.NotStarted, null, null);

        public EplanStatus(EplanState state, string version, EplanPaths paths)
        {
            State = state;
            Version = version;
            Paths = paths;
        }

        public EplanState State { get; }

        /// <summary>z. B. „2025.0.3“; <c>null</c>, solange EPLAN nicht bereit ist.</summary>
        public string Version { get; }

        /// <summary><c>null</c>, solange EPLAN nicht gestartet wurde.</summary>
        public EplanPaths Paths { get; }

        /// <summary>Wert für <c>status.eplan</c>.</summary>
        public static string ToProtocol(EplanState state)
        {
            switch (state)
            {
                case EplanState.Starting: return "starting";
                case EplanState.Ready: return "ready";
                case EplanState.Failed: return "failed";
                default: return "not_started";
            }
        }
    }
}
