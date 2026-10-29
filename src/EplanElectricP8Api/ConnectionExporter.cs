using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.E3D;

namespace EplanElectricP8Api
{
    internal sealed class ConnectionExportResult
    {
        public int Count { get; set; }

        /// <summary>Verbindungen mit "#" bzw. "#"-Texte ohne zugeordnete Verbindung.</summary>
        public int Marked { get; set; }
        public int UnmatchedMarks { get; set; }

        /// <summary>Verdrillte Verbindungen.</summary>
        public int Twisted { get; set; }

        /// <summary>Abgeschirmte Verbindungen und Anzahl Schirmsymbole.</summary>
        public int Shielded { get; set; }
        public int Shields { get; set; }
    }

    /// <summary>
    /// Schreibt alle Verbindungen eines geöffneten Projekts direkt über das DataModel als Excel-Datei (ohne Beschriftungsschema).
    /// Darf nur auf dem EPLAN-Thread mit aktivem LockingStep aufgerufen werden.
    /// </summary>
    internal static class ConnectionExporter
    {
        /// <summary>Verdrillte Adern haben eine gemeinsame Verbindungsbezeichnung, z.B. VD_X500 oder VD_F500_1.</summary>
        private static readonly Regex TwistDesignation = new Regex(@"^VD_[A-Za-z]\d+(_\d+)?$", RegexOptions.Compiled);

        private static readonly string[] Header =
        {
            "Seite", "Verbindungsbezeichnung", "Quelle", "Ziel", "Farbe/Nummer", "Querschnitt", "Typ", "Länge", "Artikelnummer", "#-Markierung", "Verdrillung", "Abgeschirmt",
        };

        public static ConnectionExportResult Export(Project project, string destinationFile)
        {
            // 3D-Verbindungen (Schaltschrankaufbau) sind Doppelungen der Schaltplan-Verbindungen und unterstützen deren Eigenschaften nicht
            Connection[] connections = new DMObjectsFinder(project).GetConnections(null)
                .Where(connection => !(connection is Connection3D))
                .ToArray();
            bool[] marked = HashMarkFinder.Find(project, connections, out int unmatchedMarks);
            bool[] shielded = ShieldFinder.Find(project, connections, out int shields);
            int twistedCount = 0;

            var rows = new List<string[]>();
            for (int i = 0; i < connections.Length; i++)
            {
                var connection = connections[i];
                var props = connection.Properties;
                string designation = Value(props.CONNECTION_DESIGNATION);
                bool twisted = TwistDesignation.IsMatch(designation.Trim());
                if (twisted)
                {
                    twistedCount++;
                }
                rows.Add(new[]
                {
                    connection.Page?.Name ?? "",
                    designation,
                    Endpoint(connection.StartPin),
                    Endpoint(connection.EndPin),
                    Value(props.CONNECTION_WIRENUMBER),
                    Value(props.CONNECTION_WIRECROSSSECTION_WITH_UNIT),
                    Value(props.CONNECTION_WIRETYPE),
                    Value(props.CONNECTION_WIRELENGTH_FULL),
                    PartNumbers(connection),
                    marked[i] ? "ja" : "",
                    twisted ? "ja" : "",
                    shielded[i] ? "ja" : "",
                });
            }

            WriteWorkbook(rows, destinationFile);
            return new ConnectionExportResult
            {
                Count = connections.Length,
                Marked = marked.Count(m => m),
                UnmatchedMarks = unmatchedMarks,
                Twisted = twistedCount,
                Shielded = shielded.Count(x => x),
                Shields = shields,
            };
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

        /// <summary>Schreibt die Zeilen als Excel-Tabelle: Kopfzeile mit Filter/Sortierung, fixiert, Spaltenbreiten passend.</summary>
        private static void WriteWorkbook(List<string[]> rows, string destinationFile)
        {
            using (var workbook = new XLWorkbook())
            {
                var sheet = workbook.Worksheets.Add("Verbindungen");
                for (int column = 0; column < Header.Length; column++)
                {
                    sheet.Cell(1, column + 1).Value = Header[column];
                }

                // Werte als Text schreiben: "=+H.A20-K1" bleibt ein Kennzeichen und wird nicht als Formel ausgewertet
                for (int row = 0; row < rows.Count; row++)
                {
                    for (int column = 0; column < Header.Length; column++)
                    {
                        sheet.Cell(row + 2, column + 1).Value = rows[row][column];
                    }
                }

                var range = sheet.Range(1, 1, rows.Count + 1, Header.Length);
                if (rows.Count > 0)
                {
                    // Excel-Tabelle: Filter- und Sortierknöpfe in der Kopfzeile, gestreifte Zeilen
                    range.CreateTable("Verbindungen").Theme = XLTableTheme.TableStyleMedium2;
                }
                else
                {
                    range.SetAutoFilter();
                }

                sheet.SheetView.FreezeRows(1);
                sheet.Columns().AdjustToContents();
                workbook.SaveAs(destinationFile);
            }
        }
    }
}
