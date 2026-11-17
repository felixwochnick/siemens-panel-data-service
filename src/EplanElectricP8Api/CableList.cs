using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.EObjects;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Liest die Kabeldefinitionen eines Projekts für das Blatt "Kabel", aufgebaut wie der EPLAN Kabelnavigator:
    /// je Kabel bzw. Schirm ("Abschirmung, Kabeldefinition") eine Zeile, darunter seine Adern.
    /// </summary>
    internal static class CableList
    {
        public static readonly string[] Header =
        {
            "Kabel", "Funktionsdefinition", "Seite", "Quelle", "Ziel", "Typ", "Adern x Querschnitt", "Länge", "Farbe/Nummer", "Querschnitt", "Artikelnummer",
        };

        /// <summary>Zeilen des Blatts; definitions = Anzahl Kabel und Schirme.</summary>
        public static List<string[]> Rows(Project project, out int definitions)
        {
            var rows = new List<string[]>();
            var seen = new HashSet<string>();
            definitions = 0;

            foreach (var page in project.Pages)
            {
                foreach (var function in page.AllPlacements.OfType<Function>().Where(f => f is Cable || f is Shield))
                {
                    // Ein Kabel kann mehrfach platziert sein (z.B. auf mehreren Seiten); nur einmal ausgeben
                    string key = string.IsNullOrEmpty(function.Name)
                        ? page.Name + "|" + function.Location.X + "|" + function.Location.Y
                        : function.Name;
                    if (!seen.Add(key))
                    {
                        continue;
                    }

                    definitions++;
                    var props = function.Properties;
                    rows.Add(new[]
                    {
                        function.Name ?? "",
                        DefinitionName(() => function.FunctionDefinition),
                        page.Name,
                        ConnectionExporter.Value(() => props.FUNC_CABLE_SOURCE),
                        ConnectionExporter.Value(() => props.FUNC_CABLE_DESTINATION),
                        ConnectionExporter.Value(() => props.FUNC_CABLETYPE),
                        ConnectionExporter.Value(() => props.FUNC_CABLEWIRECOUNTANDCROSSSECTION),
                        ConnectionExporter.Value(() => props.FUNC_CABLELENGTH_FULL),
                        "",
                        "",
                        ConnectionExporter.PartNumbers(() => function.ArticleReferences),
                    });

                    foreach (var wire in Wires(function))
                    {
                        rows.Add(WireRow(function.Name ?? "", wire));
                    }
                }
            }

            return rows;
        }

        /// <summary>Adern des Kabels bzw. Anschlussleitungen des Schirms (Schirm -> Schirmklemme/Erdung).</summary>
        private static IEnumerable<Connection> Wires(Function function)
        {
            try
            {
                if (function is Cable cable)
                {
                    return cable.CableConnections;
                }
                return function.Pins.SelectMany(pin => pin.Connections).Distinct().ToArray();
            }
            catch (Exception)
            {
                return new Connection[0];
            }
        }

        private static string[] WireRow(string cableName, Connection wire)
        {
            var props = wire.Properties;
            return new[]
            {
                cableName,
                DefinitionName(() => wire.FunctionDefinition),
                wire.Page?.Name ?? "",
                ConnectionExporter.Source(wire),
                ConnectionExporter.Destination(wire),
                "",
                "",
                ConnectionExporter.Value(() => props.CONNECTION_WIRELENGTH_FULL),
                ConnectionExporter.Value(() => props.CONNECTION_WIRENUMBER),
                ConnectionExporter.Value(() => props.CONNECTION_WIRECROSSSECTION_WITH_UNIT),
                ConnectionExporter.PartNumbers(() => wire.ArticleReferences),
            };
        }

        /// <summary>Name der Funktionsdefinition, z.B. "Kabeldefinition", "Abschirmung, Kabeldefinition", "Ader / Draht".</summary>
        private static string DefinitionName(Func<FunctionDefinition> definition)
        {
            try
            {
                return ConnectionExporter.Localized(definition()?.Name);
            }
            catch (Exception)
            {
                return "";
            }
        }
    }
}
