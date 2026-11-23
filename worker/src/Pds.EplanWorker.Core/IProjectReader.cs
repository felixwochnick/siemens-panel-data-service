using System;
using System.Threading.Tasks;
using Pds.EplanWorker.Raw;

namespace Pds.EplanWorker
{
    /// <summary>
    /// Der Teil des Workers, der EPLAN braucht: EPLAN starten, Archiv wiederherstellen, Projekt öffnen, Rohdaten lesen.
    /// Die Umsetzung mit EPLAN liegt im Worker (nur Windows); die Tests verwenden einen Ersatz.
    /// </summary>
    public interface IProjectReader
    {
        /// <summary>Zustand von EPLAN; jederzeit abrufbar, auch während einer Analyse.</summary>
        EplanStatus Eplan { get; }

        /// <summary>
        /// Startet EPLAN bei Bedarf mit <paramref name="eplan"/> und liest das Projekt. Meldet die Stufen
        /// <c>starting_eplan</c> (nur wenn EPLAN noch nicht bereit ist), <c>restoring</c> (Archiv), <c>opening</c>,
        /// <c>reading</c>. Fehler als <see cref="WorkerException"/> mit Code. Bei Archiven ist
        /// <see cref="ProjectSource.RestoreFolder"/> leer vorbereitet; aufräumen macht der Aufrufer.
        /// </summary>
        Task<RawProject> ReadAsync(EplanPaths eplan, ProjectSource source, IAnalysisReporter reporter);
    }

    /// <summary>Rückmeldungen während einer Analyse; darf von jedem Thread aus aufgerufen werden.</summary>
    public interface IAnalysisReporter
    {
        /// <summary>Neue Stufe (<see cref="Protocol.Stages"/>).</summary>
        void Progress(string stage);

        /// <summary>Einzelne <c>log</c>-Nachricht an den Client.</summary>
        void Log(string level, string code, string message);

        /// <summary>
        /// Ein Objekt war nicht (vollständig) lesbar; das Feld hat den Leerwert bekommen. Wird je Code gezählt und nach dem
        /// Lesen einmal je Code mit Anzahl gemeldet.
        /// </summary>
        void Issue(string code, Exception exception);
    }
}
