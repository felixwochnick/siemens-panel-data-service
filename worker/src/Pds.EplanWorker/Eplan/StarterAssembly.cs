using System;
using System.IO;
using System.Reflection;
using System.Threading;

namespace Pds.EplanWorker.Eplan
{
    /// <summary>
    /// Lädt den EPLAN-Starter (<c>Eplan.EplApi.Starteru</c>) aus dem Platform-Bin-Ordner der EPLAN-Installation.
    /// Das MSI liefert keine EPLAN-DLLs aus (sie gehören zur Installation und zu deren Version); der Starter liegt
    /// deshalb nur im Entwicklungs-Build neben der Exe. Über ihn findet EPLAN danach alle weiteren DLLs selbst.
    /// </summary>
    internal static class StarterAssembly
    {
        private const string Name = "Eplan.EplApi.Starteru";

        private static string _folder;
        private static int _registered;

        /// <summary>Muss vor dem ersten Zugriff auf einen Typ aus dem Starter laufen (eigene Methode ohne Inlining).</summary>
        public static void Register(string platformBin)
        {
            Volatile.Write(ref _folder, platformBin);
            if (Interlocked.Exchange(ref _registered, 1) == 0)
            {
                AppDomain.CurrentDomain.AssemblyResolve += Resolve;
            }
        }

        // Wird nur aufgerufen, wenn die normale Suche (Ordner der Exe) nichts gefunden hat
        private static Assembly Resolve(object sender, ResolveEventArgs args)
        {
            var requested = new AssemblyName(args.Name);
            if (!string.Equals(requested.Name, Name, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            string folder = Volatile.Read(ref _folder);
            if (string.IsNullOrEmpty(folder))
            {
                return null;
            }

            // Auch eine andere Version als zur Build-Zeit ist richtig: maßgeblich ist die installierte EPLAN-Version
            string path = Path.Combine(folder, Name + ".dll");
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        }
    }
}
