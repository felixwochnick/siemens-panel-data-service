using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.EObjects;

namespace EplanElectricP8Api
{
    /// <summary>Ein Schirm mit den Adern, die er abschirmt (Indizes in das Verbindungs-Array).</summary>
    internal sealed class ShieldGroup
    {
        public string Page { get; set; }
        public string Name { get; set; }
        public string Type { get; set; }
        public string WireCountAndCrossSection { get; set; }
        public List<int> Wires { get; } = new List<int>();
    }

    /// <summary>
    /// Findet abgeschirmte Verbindungen und ordnet sie ihren Schirmen zu:
    /// <list type="bullet">
    /// <item>Schirmsymbole ("Abschirmung, Kabeldefinition"): logisch über Connection.Shieldings, sonst über die Adern,
    /// die die gezeichnete Schirmlinie kreuzen (EPLAN verknüpft die Adern nicht immer mit dem Schirm).</item>
    /// <item>Geschirmte Kabel: Kabeldefinitionen, deren Typ mit "GSC" beginnt (z.B. GSC-01), mit ihren Adern.</item>
    /// </list>
    /// </summary>
    internal static class ShieldFinder
    {
        private const string ShieldedCableTypePrefix = "GSC";

        /// <summary>Gibt die Schirme zurück; shielded = pro Verbindung, ob sie abgeschirmt ist.</summary>
        public static List<ShieldGroup> Find(Project project, Connection[] connections, out bool[] shielded)
        {
            var groups = new Dictionary<string, ShieldGroup>();

            // 1. Schirmsymbole: logisch zugeordnete Adern
            for (int i = 0; i < connections.Length; i++)
            {
                foreach (var shield in Shieldings(connections[i]))
                {
                    Group(groups, shield).Wires.Add(i);
                }
            }

            // 2. Schirmsymbole: Adern, die die Schirmlinie kreuzen
            foreach (var page in project.Pages)
            {
                foreach (var shield in page.AllPlacements.OfType<Shield>())
                {
                    var group = Group(groups, shield);
                    var area = ShieldArea(shield);
                    if (area == null)
                    {
                        continue;
                    }
                    var boxes = new Dictionary<string, List<PageBox>> { { page.Name, new List<PageBox> { area } } };
                    var crossing = new bool[connections.Length];
                    ConnectionGeometry.MarkIntersecting(connections, boxes, crossing);
                    group.Wires.AddRange(Enumerable.Range(0, connections.Length).Where(i => crossing[i]));
                }
            }

            // 3. Geschirmte Kabel (GSC...) mit ihren Adern
            for (int i = 0; i < connections.Length; i++)
            {
                var cable = CableOf(connections[i]);
                string type = cable == null ? "" : ConnectionExporter.Value(() => cable.Properties.FUNC_CABLETYPE);
                if (type.StartsWith(ShieldedCableTypePrefix, StringComparison.OrdinalIgnoreCase))
                {
                    string key = "Kabel|" + cable.Name;
                    if (!groups.TryGetValue(key, out var group))
                    {
                        groups[key] = group = new ShieldGroup
                        {
                            Page = connections[i].Page?.Name ?? "",
                            Name = cable.Name ?? "",
                            Type = type,
                            WireCountAndCrossSection = ConnectionExporter.Value(() => cable.Properties.FUNC_CABLEWIRECOUNTANDCROSSSECTION),
                        };
                    }
                    group.Wires.Add(i);
                }
            }

            // Schirmanschlüsse (Leitung vom Schirm zur Erdung/Schirmklemme) sind selbst nicht abgeschirmt
            shielded = new bool[connections.Length];
            foreach (var group in groups.Values)
            {
                group.Wires.RemoveAll(i => IsShieldConnection(connections[i]));
                var distinct = group.Wires.Distinct().OrderBy(i => i).ToList();
                group.Wires.Clear();
                group.Wires.AddRange(distinct);
                foreach (int i in distinct)
                {
                    shielded[i] = true;
                }
            }

            return groups.Values.OrderBy(g => g.Page, StringComparer.Ordinal).ToList();
        }

        /// <summary>Gruppe eines Schirmsymbols; Seite und Position identifizieren es (die API liefert je Zugriff neue Objekte).</summary>
        private static ShieldGroup Group(Dictionary<string, ShieldGroup> groups, Function shield)
        {
            string page = shield.Page?.Name ?? "";
            var location = shield.Location;
            string key = "Schirm|" + page + "|" + Math.Round(location.X, 2) + "|" + Math.Round(location.Y, 2);
            if (!groups.TryGetValue(key, out var group))
            {
                groups[key] = group = new ShieldGroup
                {
                    Page = page,
                    Name = string.IsNullOrEmpty(shield.Name) ? "Abschirmung" : shield.Name,
                    Type = "",
                    WireCountAndCrossSection = "",
                };
            }
            return group;
        }

        private static Cable CableOf(Connection connection)
        {
            try
            {
                return connection.CableDefinitionLine;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Fläche der Schirmlinie. Die Ausdehnung steht in RECTANGLE_WIDTH/HEIGHT (in Seitenrichtung), die Richtung vom
        /// Symbolpunkt aus ergibt sich aus der Symbolvariante: 0 = rechts, 1 = oben, 2 = links, 3 = unten.
        /// </summary>
        private static PageBox ShieldArea(Shield shield)
        {
            try
            {
                double width = shield.Properties.RECTANGLE_WIDTH.ToDouble();
                double height = shield.Properties.RECTANGLE_HEIGHT.ToDouble();
                var p = shield.Location;

                switch (shield.SymbolVariant.VariantNr)
                {
                    case 0: return new PageBox { MinX = p.X, MaxX = p.X + width, MinY = p.Y - height, MaxY = p.Y + height };
                    case 1: return new PageBox { MinX = p.X - width, MaxX = p.X + width, MinY = p.Y, MaxY = p.Y + height };
                    case 2: return new PageBox { MinX = p.X - width, MaxX = p.X, MinY = p.Y - height, MaxY = p.Y + height };
                    case 3: return new PageBox { MinX = p.X - width, MaxX = p.X + width, MinY = p.Y - height, MaxY = p.Y };
                    // Gespiegelte Varianten: Richtung unbekannt, beide Seiten berücksichtigen
                    default: return new PageBox { MinX = p.X - width, MaxX = p.X + width, MinY = p.Y - height, MaxY = p.Y + height };
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Schirmanschluss oder interner Schirm-Eintrag ohne Anschlüsse (keine Ader).</summary>
        private static bool IsShieldConnection(Connection connection)
        {
            var start = connection.StartPin;
            var end = connection.EndPin;
            return (start == null && end == null) || start?.ParentFunction is Shield || end?.ParentFunction is Shield;
        }

        private static Function[] Shieldings(Connection connection)
        {
            try
            {
                return connection.Shieldings ?? new Function[0];
            }
            catch (Exception)
            {
                return new Function[0];
            }
        }
    }
}
