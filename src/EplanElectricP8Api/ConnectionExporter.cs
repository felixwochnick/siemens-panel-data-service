using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using Eplan.EplApi.Base;
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

        /// <summary>Verdrillte Verbindungen und Anzahl gezeichneter Verdrillungssymbole.</summary>
        public int Twisted { get; set; }
        public int TwistSymbols { get; set; }
        public int UnmatchedTwistMarks { get; set; }

        /// <summary>Abgeschirmte Verbindungen und Anzahl Schirmsymbole.</summary>
        public int Shielded { get; set; }
        public int Shields { get; set; }

        /// <summary>Anzahl Kabeldefinitionen (Kabel und Schirme) im Blatt "Kabel".</summary>
        public int Cables { get; set; }

        /// <summary>Anzahl freier Texte im Blatt "Texte".</summary>
        public int Texts { get; set; }
    }

    /// <summary>
    /// Schreibt alle Verbindungen und Kabel eines geöffneten Projekts direkt über das DataModel als Excel-Datei
    /// mit den Blättern "Verbindungen", "Kabel", "Schirme" und "Texte" (ohne Beschriftungsschema).
    /// Darf nur auf dem EPLAN-Thread mit aktivem LockingStep aufgerufen werden.
    /// </summary>
    internal static class ConnectionExporter
    {
        /// <summary>Verdrillte Adern haben eine gemeinsame Verbindungsbezeichnung, z.B. VD_X500 oder VD_F500_1.</summary>
        private static readonly Regex TwistDesignation = new Regex(@"^VD_[A-Za-z]\d+(_\d+)?$", RegexOptions.Compiled);

        private static readonly string[] Header =
        {
            "Seite", "Funktionsdefinition", "Verbindungsbezeichnung", "Quelle", "Ziel", "Kabel", "Farbe/Nummer", "Querschnitt", "Typ", "Länge", "Artikelnummer", "#-Markierung", "Verdrillung", "Abgeschirmt",
        };

        public static ConnectionExportResult Export(Project project, string destinationFile)
        {
            // 3D-Verbindungen (Schaltschrankaufbau) sind Doppelungen der Schaltplan-Verbindungen und unterstützen deren Eigenschaften nicht
            Connection[] connections = new DMObjectsFinder(project).GetConnections(null)
                .Where(connection => !(connection is Connection3D))
                .ToArray();
            bool[] marked = HashMarkFinder.Find(project, connections, out int unmatchedMarks);
            var shields = ShieldFinder.Find(project, connections, out bool[] shielded);
            bool[] twistSymbol = TwistFinder.Find(project, connections, out int twistSymbols, out int unmatchedTwistMarks);
            int twistedCount = 0;

            var rows = new List<string[]>();
            for (int i = 0; i < connections.Length; i++)
            {
                var connection = connections[i];
                var props = connection.Properties;
                string designation = Value(() => props.CONNECTION_DESIGNATION);
                bool twisted = twistSymbol[i] || TwistDesignation.IsMatch(designation.Trim());
                if (twisted)
                {
                    twistedCount++;
                }
                rows.Add(new[]
                {
                    connection.Page?.Name ?? "",
                    DefinitionName(connection),
                    designation,
                    Source(connection),
                    Destination(connection),
                    CableName(connection),
                    Value(() => props.CONNECTION_WIRENUMBER),
                    Value(() => props.CONNECTION_WIRECROSSSECTION_WITH_UNIT),
                    Value(() => props.CONNECTION_WIRETYPE),
                    Value(() => props.CONNECTION_WIRELENGTH_FULL),
                    PartNumbers(() => connection.ArticleReferences),
                    marked[i] ? "ja" : "",
                    twisted ? "ja" : "",
                    shielded[i] ? "ja" : "",
                });
            }

            var cables = CableList.Rows(project, out int cableDefinitions);
            var texts = TextList.Rows(project);

            using (var workbook = new XLWorkbook())
            {
                AddSheet(workbook, "Verbindungen", Header, rows);
                AddSheet(workbook, "Kabel", CableList.Header, cables);
                AddShieldSheet(workbook, shields, rows);
                var textSheet = AddSheet(workbook, "Texte", TextList.Header, texts);
                textSheet.Column(2).Width = 100;
                textSheet.Column(2).Style.Alignment.WrapText = true;
                workbook.SaveAs(destinationFile);
            }

            return new ConnectionExportResult
            {
                Count = connections.Length,
                Marked = marked.Count(m => m),
                UnmatchedMarks = unmatchedMarks,
                Twisted = twistedCount,
                TwistSymbols = twistSymbols,
                UnmatchedTwistMarks = unmatchedTwistMarks,
                Shielded = shielded.Count(x => x),
                Shields = shields.Count,
                Texts = texts.Count,
                Cables = cableDefinitions,
            };
        }

        /// <summary>Quelle wie im EPLAN Verbindungsnavigator (Eigenschaft CONNECTION_SOURCE), sonst aus dem Anschluss gebildet.</summary>
        internal static string Source(Connection connection)
        {
            string source = Value(() => connection.Properties.CONNECTION_SOURCE);
            return source.Length > 0 ? source : Endpoint(connection.StartPin);
        }

        /// <summary>Ziel wie im EPLAN Verbindungsnavigator (Eigenschaft CONNECTION_DESTINATION), sonst aus dem Anschluss gebildet.</summary>
        internal static string Destination(Connection connection)
        {
            string destination = Value(() => connection.Properties.CONNECTION_DESTINATION);
            return destination.Length > 0 ? destination : Endpoint(connection.EndPin);
        }

        /// <summary>
        /// Betriebsmittelkennzeichen und Anschluss, z.B. "=A1+S1-K1:13", bei Steckern/Geräteanschlüssen mit
        /// Steckerbezeichnung, z.B. "=+H.A25-A1-B150:X531:1".
        /// </summary>
        internal static string Endpoint(Pin pin)
        {
            var function = pin?.ParentFunction;
            string name = function?.Name ?? "";
            if (name.Length == 0)
            {
                return "";
            }

            // Anschlussbezeichnung wie im EPLAN Verbindungsnavigator (z.B. "3" am Sammelschienenanschluss "-U1:3",
            // "1/L1" am Motorschutzschalter, "B" an der Klemme). pin.Designation ist nur die Nummer des Symbolanschlusses.
            string connectionPoint = PinName(pin);

            // Klemmen, Stecker- und Geräteanschlüsse tragen den Anschluss bereits im Namen ("-A1-B150:1")
            int colon = name.IndexOf(':');
            if (colon < 0)
            {
                if (connectionPoint.Length == 0)
                {
                    connectionPoint = pin.Designation ?? "";
                }
                return connectionPoint.Length == 0 ? name : name + ":" + connectionPoint;
            }

            string plug = PlugDesignation(function);
            if (plug.Length > 0 && name.IndexOf(":" + plug + ":", StringComparison.Ordinal) < 0)
            {
                name = name.Substring(0, colon) + ":" + plug + name.Substring(colon);
            }
            // Geräteanschlüsse heißen wie ihr Anschluss ("-K530:12" mit Anschluss "12"), Klemmen nicht ("-X60:1" mit Anschluss "B")
            bool contained = name.EndsWith(":" + connectionPoint, StringComparison.Ordinal);
            return connectionPoint.Length == 0 || contained ? name : name + ":" + connectionPoint;
        }

        private static string PinName(Pin pin)
        {
            try
            {
                return pin.Name ?? "";
            }
            catch (Exception)
            {
                return "";
            }
        }

        /// <summary>Steckerbezeichnung des Anschlusses (z.B. X531); EPLAN trägt sie oft nur beim ersten Anschluss ein, automatisch aber bei allen.</summary>
        private static string PlugDesignation(Function function)
        {
            string plug = Value(() => function.Properties.FUNC_PLCPLUG_DESIGNATION_AUTOMATIC);
            return plug.Length > 0 ? plug : Value(() => function.Properties.FUNC_PLCPLUG_DESIGNATION_MANUAL);
        }

        /// <summary>Deutscher Text eines mehrsprachigen Werts (z.B. Name der Funktionsdefinition), sonst der sprachneutrale.</summary>
        internal static string Localized(MultiLangString text)
        {
            if (text == null)
            {
                return "";
            }
            string german = text.GetStringToDisplay(ISOCode.Language.L_de_DE);
            return string.IsNullOrEmpty(german) ? text.GetStringToDisplay(ISOCode.Language.L___) ?? "" : german;
        }

        /// <summary>Art der Verbindung, z.B. "Ader / Draht", "Direktverbindung" (Brücke zwischen Klemmen), "Intern".</summary>
        private static string DefinitionName(Connection connection)
        {
            try
            {
                return Localized(connection.FunctionDefinition?.Name);
            }
            catch (Exception)
            {
                return "";
            }
        }

        /// <summary>Kabel, zu dem die Verbindung als Ader gehört.</summary>
        private static string CableName(Connection connection)
        {
            try
            {
                return connection.CableDefinitionLine?.Name ?? "";
            }
            catch (Exception)
            {
                return "";
            }
        }

        /// <summary>Artikelnummern, mehrere durch Komma getrennt.</summary>
        internal static string PartNumbers(Func<ArticleReference[]> references)
        {
            try
            {
                return string.Join(", ", references()
                    .Select(reference => reference.PartNr)
                    .Where(partNr => !string.IsNullOrEmpty(partNr))
                    .Distinct());
            }
            catch (Exception)
            {
                return "";
            }
        }

        internal static string Value(Func<PropertyValue> property)
        {
            try
            {
                var value = property();
                return value.IsEmpty ? "" : value.ToString();
            }
            catch (Exception)
            {
                // Eigenschaft ist für dieses Objekt nicht vorhanden
                return "";
            }
        }

        /// <summary>
        /// Blatt "Schirme": je Schirm Seite, Anzahl Adern und pro Ader ein Link auf ihre Zeile im Blatt "Verbindungen".
        /// </summary>
        private static void AddShieldSheet(XLWorkbook workbook, List<ShieldGroup> shields, List<string[]> connectionRows)
        {
            int maxWires = shields.Count == 0 ? 0 : shields.Max(shield => shield.Wires.Count);
            var header = new List<string> { "Seite", "Schirm", "Typ", "Adern x Querschnitt", "Anzahl Adern" };
            header.AddRange(Enumerable.Range(1, maxWires).Select(n => "Ader " + n));

            var rows = shields.Select(shield =>
            {
                var row = new List<string> { shield.Page, shield.Name, shield.Type, shield.WireCountAndCrossSection, shield.Wires.Count.ToString() };
                row.AddRange(shield.Wires.Select(i => WireLabel(connectionRows[i])));
                row.AddRange(Enumerable.Repeat("", maxWires - shield.Wires.Count));
                return row.ToArray();
            }).ToList();

            var sheet = AddSheet(workbook, "Schirme", header.ToArray(), rows);
            for (int row = 0; row < shields.Count; row++)
            {
                for (int wire = 0; wire < shields[row].Wires.Count; wire++)
                {
                    // Zeile im Blatt "Verbindungen": Kopfzeile + Index; die Links zeigen auf feste Zellen (nicht nach dem Umsortieren)
                    int target = shields[row].Wires[wire] + 2;
                    sheet.Cell(row + 2, header.Count - maxWires + wire + 1)
                        .SetHyperlink(new XLHyperlink("'Verbindungen'!A" + target + ":" + LastColumn + target));
                }
            }
        }

        private static readonly string LastColumn = XLHelper.GetColumnLetterFromNumber(Header.Length);

        /// <summary>Kurzbezeichnung einer Ader für den Link, z.B. "WH: =+H.A25-A1-X24:2:B → =+H.A25-A12:-X3:+".</summary>
        private static string WireLabel(string[] connectionRow)
        {
            string color = connectionRow[Array.IndexOf(Header, "Farbe/Nummer")];
            string route = connectionRow[Array.IndexOf(Header, "Quelle")] + " → " + connectionRow[Array.IndexOf(Header, "Ziel")];
            return color.Length > 0 ? color + ": " + route : route;
        }

        /// <summary>Schreibt die Zeilen als Excel-Tabelle: Kopfzeile mit Filter/Sortierung, fixiert, Spaltenbreiten passend.</summary>
        private static IXLWorksheet AddSheet(XLWorkbook workbook, string name, string[] header, List<string[]> rows)
        {
            var sheet = workbook.Worksheets.Add(name);
            for (int column = 0; column < header.Length; column++)
            {
                sheet.Cell(1, column + 1).Value = header[column];
            }

            // Werte als Text schreiben: "=+H.A20-K1" bleibt ein Kennzeichen und wird nicht als Formel ausgewertet
            for (int row = 0; row < rows.Count; row++)
            {
                for (int column = 0; column < header.Length; column++)
                {
                    sheet.Cell(row + 2, column + 1).Value = rows[row][column];
                }
            }

            var range = sheet.Range(1, 1, rows.Count + 1, header.Length);
            if (rows.Count > 0)
            {
                // Excel-Tabelle: Filter- und Sortierknöpfe in der Kopfzeile, gestreifte Zeilen
                range.CreateTable(name).Theme = XLTableTheme.TableStyleMedium2;
            }
            else
            {
                range.SetAutoFilter();
            }

            sheet.SheetView.FreezeRows(1);
            sheet.Columns().AdjustToContents();
            return sheet;
        }
    }
}
