using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.EObjects;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Findet abgeschirmte Verbindungen. EPLAN verknüpft die Adern nicht immer mit dem Schirm (Connection.Shieldings);
    /// zusätzlich werden daher die Adern ausgewertet, die die gezeichnete Schirmlinie kreuzen.
    /// </summary>
    internal static class ShieldFinder
    {
        /// <summary>Gibt pro Verbindung zurück, ob sie abgeschirmt ist; shieldCount = Anzahl Schirmsymbole.</summary>
        public static bool[] Find(Project project, Connection[] connections, out int shieldCount)
        {
            var shielded = new bool[connections.Length];

            // 1. Logisch: Schirm ist der Verbindung zugeordnet
            for (int i = 0; i < connections.Length; i++)
            {
                shielded[i] = Shieldings(connections[i]).Length > 0;
            }

            // 2. Geometrisch: Adern, die die Schirmlinie kreuzen
            var shieldsByPage = new Dictionary<string, List<PageBox>>();
            shieldCount = 0;
            foreach (var page in project.Pages)
            {
                var boxes = page.AllPlacements.OfType<Shield>().Select(ShieldArea).Where(box => box != null).ToList();
                shieldCount += boxes.Count;
                if (boxes.Count > 0)
                {
                    shieldsByPage[page.Name] = boxes;
                }
            }
            ConnectionGeometry.MarkIntersecting(connections, shieldsByPage, shielded);

            // Schirmanschlüsse (Leitung vom Schirm zur Erdung/Schirmklemme) sind selbst nicht abgeschirmt
            for (int i = 0; i < connections.Length; i++)
            {
                if (IsShieldConnection(connections[i]))
                {
                    shielded[i] = false;
                }
            }

            return shielded;
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
