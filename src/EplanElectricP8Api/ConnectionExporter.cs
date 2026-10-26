using System;
using System.IO;
using System.Linq;
using System.Text;
using Eplan.EplApi.DataModel;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Schreibt alle Verbindungen eines geöffneten Projekts direkt über das DataModel als CSV (ohne Beschriftungsschema).
    /// Darf nur auf dem EPLAN-Thread mit aktivem LockingStep aufgerufen werden.
    /// </summary>
    internal static class ConnectionExporter
    {
        private static readonly string[] Header =
        {
            "Seite", "Verbindungsbezeichnung", "Quelle", "Ziel", "Farbe/Nummer", "Querschnitt", "Typ", "Länge", "Artikelnummer", "#-Markierung",
        };

        /// <summary>
        /// Gibt die Anzahl der exportierten Verbindungen zurück; markedCount = Verbindungen mit "#",
        /// unmatchedMarks = "#"-Texte, die keiner Verbindung zugeordnet werden konnten.
        /// </summary>
        public static int Export(Project project, string destinationFile, out int markedCount, out int unmatchedMarks)
        {
            Connection[] connections = new DMObjectsFinder(project).GetConnections(null);
            bool[] marked = HashMarkFinder.Find(project, connections, out unmatchedMarks);
            markedCount = marked.Count(m => m);

            var csv = new StringBuilder();
            csv.AppendLine(string.Join(";", Header));
            for (int i = 0; i < connections.Length; i++)
            {
                var connection = connections[i];
                var props = connection.Properties;
                csv.AppendLine(string.Join(";", new[]
                {
                    connection.Page?.Name,
                    Value(props.CONNECTION_DESIGNATION),
                    Endpoint(connection.StartPin),
                    Endpoint(connection.EndPin),
                    Value(props.CONNECTION_WIRENUMBER),
                    Value(props.CONNECTION_WIRECROSSSECTION_WITH_UNIT),
                    Value(props.CONNECTION_WIRETYPE),
                    Value(props.CONNECTION_WIRELENGTH_FULL),
                    PartNumbers(connection),
                    marked[i] ? "ja" : "",
                }.Select(Escape)));
            }

            // UTF-8 mit BOM, damit Excel Umlaute korrekt anzeigt
            File.WriteAllText(destinationFile, csv.ToString(), new UTF8Encoding(true));
            return connections.Length;
        }

        /// <summary>Betriebsmittelkennzeichen und Anschluss, z.B. "=A1+S1-K1:13".</summary>
        private static string Endpoint(Pin pin)
        {
            if (pin == null)
            {
                return "";
            }
            string device = pin.ParentFunction?.Name ?? "";
            return string.IsNullOrEmpty(pin.Designation) ? device : device + ":" + pin.Designation;
        }

        /// <summary>Artikelnummern der Verbindung, mehrere durch Komma getrennt.</summary>
        private static string PartNumbers(Connection connection)
        {
            return string.Join(", ", connection.ArticleReferences
                .Select(reference => reference.PartNr)
                .Where(partNr => !string.IsNullOrEmpty(partNr)));
        }

        private static string Value(PropertyValue value)
        {
            try
            {
                return value.IsEmpty ? "" : value.ToString();
            }
            catch (Exception)
            {
                // Eigenschaft ist für diese Verbindung nicht vorhanden
                return "";
            }
        }

        private static string Escape(string value)
        {
            value = value ?? "";

            // Excel würde Werte wie "=+H.A20-K1" als Formel auswerten; ="..." zeigt den Text unverändert an
            if (value.Length > 0 && "=+-@".IndexOf(value[0]) >= 0)
            {
                value = "=\"" + value.Replace("\"", "\"\"") + "\"";
            }

            return value.IndexOfAny(new[] { ';', '"', '\r', '\n' }) >= 0
                ? "\"" + value.Replace("\"", "\"\"") + "\""
                : value;
        }
    }
}
