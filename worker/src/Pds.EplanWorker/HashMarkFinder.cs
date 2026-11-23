using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Findet Verbindungen, auf deren Leitung ein freier Text "#" platziert ist (z.B. Kennzeichnung "kurzschlusssichere Verlegung").
    /// Das "#" ist keine Eigenschaft der Verbindung, daher erfolgt die Zuordnung geometrisch über den Leitungsweg.
    /// </summary>
    internal static class HashMarkFinder
    {
        private const string Mark = "#";

        /// <summary>Maximaler Abstand in mm zwischen Text und Leitung.</summary>
        private const double Tolerance = 2.0;

        /// <summary>Gibt pro Verbindung zurück, ob sie markiert ist; unmatched = Anzahl "#" ohne zugeordnete Verbindung.</summary>
        public static bool[] Find(Project project, Connection[] connections, out int unmatched)
        {
            var marksByPage = CollectMarks(project);
            var marked = new bool[connections.Length];
            ConnectionGeometry.MarkIntersecting(connections, marksByPage, marked);

            unmatched = marksByPage.Values.SelectMany(m => m).Count(m => !m.Matched);
            return marked;
        }

        private static Dictionary<string, List<PageBox>> CollectMarks(Project project)
        {
            var result = new Dictionary<string, List<PageBox>>();
            foreach (var page in project.Pages)
            {
                var marks = page.AllPlacements.OfType<Text>()
                    .Where(text => TextContent(text) == Mark)
                    .Select(text => PageBox.FromCorners(text.GetBoundingBox(), Tolerance))
                    .ToList();
                if (marks.Count > 0)
                {
                    result[page.Name] = marks;
                }
            }
            return result;
        }

        private static string TextContent(Text text)
        {
            try
            {
                string content = text.Contents.GetStringToDisplay(ISOCode.Language.L_de_DE);
                if (string.IsNullOrEmpty(content))
                {
                    content = text.Contents.GetStringToDisplay(ISOCode.Language.L___);
                }
                return (content ?? "").Trim();
            }
            catch (Exception)
            {
                return "";
            }
        }
    }
}
