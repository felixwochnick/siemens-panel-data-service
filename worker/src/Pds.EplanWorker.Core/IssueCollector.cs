using System;
using System.Collections.Generic;

namespace Pds.EplanWorker
{
    /// <summary>Codes für Objekte, die beim Lesen eine Ausnahme warfen (Feld bekam den Leerwert).</summary>
    public static class IssueCodes
    {
        public const string ProjectUnreadable = "project_unreadable";
        public const string PageUnreadable = "page_unreadable";
        public const string ConnectionUnreadable = "connection_unreadable";
        public const string TextUnreadable = "text_unreadable";
        public const string LineUnreadable = "line_unreadable";
        public const string ShieldUnreadable = "shield_unreadable";
        public const string CableUnreadable = "cable_unreadable";

        /// <summary>Kurzbeschreibung für die Meldung (Rohtext; die App übersetzt über den Code).</summary>
        public static string Describe(string code)
        {
            switch (code)
            {
                case ProjectUnreadable: return "Projekteigenschaft nicht lesbar";
                case PageUnreadable: return "Seite nicht vollständig lesbar";
                case ConnectionUnreadable: return "Verbindung nicht vollständig lesbar";
                case TextUnreadable: return "Text nicht vollständig lesbar";
                case LineUnreadable: return "Linie nicht lesbar";
                case ShieldUnreadable: return "Schirmsymbol nicht vollständig lesbar";
                case CableUnreadable: return "Kabel- bzw. Schirmdefinition nicht vollständig lesbar";
                default: return "Objekt nicht vollständig lesbar";
            }
        }
    }

    /// <summary>
    /// Zählt Lesefehler je Code, damit eine kaputte Eigenschaft in einem großen Projekt nicht tausend Log-Zeilen
    /// erzeugt: nach dem Lesen eine Zeile je Code mit Anzahl und der ersten Ausnahme. Thread-sicher.
    /// </summary>
    public sealed class IssueCollector
    {
        private readonly object _sync = new object();
        private readonly List<string> _order = new List<string>();
        private readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);

        public void Add(string code, Exception exception)
        {
            string detail = exception == null ? "" : exception.GetType().Name + ": " + exception.Message;
            lock (_sync)
            {
                if (!_entries.TryGetValue(code, out var entry))
                {
                    _entries[code] = entry = new Entry { FirstDetail = detail };
                    _order.Add(code);
                }
                entry.Count++;
            }
        }

        /// <summary>Gibt die Zusammenfassungen in der Reihenfolge des ersten Auftretens zurück und leert die Zähler.</summary>
        public IReadOnlyList<IssueSummary> Drain()
        {
            lock (_sync)
            {
                var result = new List<IssueSummary>(_order.Count);
                foreach (var code in _order)
                {
                    var entry = _entries[code];
                    result.Add(new IssueSummary(code, entry.Count, entry.FirstDetail));
                }
                _order.Clear();
                _entries.Clear();
                return result;
            }
        }

        private sealed class Entry
        {
            public int Count;
            public string FirstDetail;
        }
    }

    public sealed class IssueSummary
    {
        public IssueSummary(string code, int count, string firstDetail)
        {
            Code = code;
            Count = count;
            FirstDetail = firstDetail ?? "";
        }

        public string Code { get; }

        public int Count { get; }

        public string FirstDetail { get; }

        /// <summary>z. B. „Text nicht vollständig lesbar: 3× (erste Ausnahme: InvalidOperationException: …)“.</summary>
        public string Message
        {
            get
            {
                string message = IssueCodes.Describe(Code) + ": " + Count + "×";
                return FirstDetail.Length == 0 ? message : message + " (erste Ausnahme: " + FirstDetail + ")";
            }
        }
    }
}
