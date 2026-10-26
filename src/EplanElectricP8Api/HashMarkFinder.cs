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

        private sealed class MarkBox
        {
            public double MinX, MinY, MaxX, MaxY;
            public bool Matched;
        }

        /// <summary>Gibt pro Verbindung zurück, ob sie markiert ist; unmatched = Anzahl "#" ohne zugeordnete Verbindung.</summary>
        public static bool[] Find(Project project, Connection[] connections, out int unmatched)
        {
            var marksByPage = CollectMarks(project);
            var marked = new bool[connections.Length];

            if (marksByPage.Count > 0)
            {
                for (int i = 0; i < connections.Length; i++)
                {
                    foreach (var segment in Segments(connections[i]))
                    {
                        if (!marksByPage.TryGetValue(segment.Page, out var marks))
                        {
                            continue;
                        }
                        foreach (var mark in marks.Where(m => Intersects(m, segment.A, segment.B)))
                        {
                            mark.Matched = true;
                            marked[i] = true;
                        }
                    }
                }
            }

            unmatched = marksByPage.Values.SelectMany(m => m).Count(m => !m.Matched);
            return marked;
        }

        private static Dictionary<string, List<MarkBox>> CollectMarks(Project project)
        {
            var result = new Dictionary<string, List<MarkBox>>();
            foreach (var page in project.Pages)
            {
                var marks = page.AllPlacements.OfType<Text>()
                    .Where(text => TextContent(text) == Mark)
                    .Select(text => ToBox(text.GetBoundingBox()))
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

        private static MarkBox ToBox(PointD[] corners)
        {
            return new MarkBox
            {
                MinX = corners.Min(p => p.X) - Tolerance,
                MinY = corners.Min(p => p.Y) - Tolerance,
                MaxX = corners.Max(p => p.X) + Tolerance,
                MaxY = corners.Max(p => p.Y) + Tolerance,
            };
        }

        /// <summary>Überschneidet sich der (waagerechte/senkrechte) Leitungsabschnitt mit dem Textrahmen?</summary>
        private static bool Intersects(MarkBox box, PointD a, PointD b)
        {
            return Math.Max(a.X, b.X) >= box.MinX && Math.Min(a.X, b.X) <= box.MaxX
                && Math.Max(a.Y, b.Y) >= box.MinY && Math.Min(a.Y, b.Y) <= box.MaxY;
        }

        private struct Segment
        {
            public string Page;
            public PointD A, B;
        }

        /// <summary>
        /// Leitungsabschnitte einer Verbindung. SymbolReferences liefert den Weg in Reihenfolge:
        /// Gerät, Winkel, Unterbrechungsstelle, ... (über mehrere Seiten). Benachbarte Punkte derselben Seite bilden einen Abschnitt.
        /// </summary>
        private static IEnumerable<Segment> Segments(Connection connection)
        {
            string previousPage = null;
            PointD previous = default;
            bool startUsed = false;

            foreach (var reference in connection.SymbolReferences)
            {
                string page = reference.Page?.Name;
                PointD point = reference.Location;

                // Gerätesymbole liefern ihren Ursprung; die Leitung beginnt aber am Anschluss (relativ zum Symbol)
                if (!startUsed && IsSymbolOf(reference, page, connection.StartSymbolReference))
                {
                    point = Offset(point, connection.StartSymbolConnPoint);
                    startUsed = true;
                }
                else if (IsSymbolOf(reference, page, connection.EndSymbolReference))
                {
                    point = Offset(point, connection.EndSymbolConnPoint);
                }

                if (page != null && page == previousPage)
                {
                    yield return new Segment { Page = page, A = previous, B = point };
                }
                previousPage = page;
                previous = point;
            }
        }

        private static bool IsSymbolOf(SymbolReference reference, string page, SymbolReference endpoint)
        {
            return endpoint != null
                && endpoint.Page?.Name == page
                && Math.Abs(endpoint.Location.X - reference.Location.X) < 0.01
                && Math.Abs(endpoint.Location.Y - reference.Location.Y) < 0.01;
        }

        private static PointD Offset(PointD point, PinBase pin)
        {
            return pin == null ? point : new PointD(point.X + pin.Location.X, point.Y + pin.Location.Y);
        }
    }
}
