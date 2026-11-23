using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;

namespace EplanElectricP8Api
{
    /// <summary>Rechteck auf einer Seite (mm), z.B. Rahmen eines Textes oder Symbols.</summary>
    internal sealed class PageBox
    {
        public double MinX, MinY, MaxX, MaxY;
        public bool Matched;

        public static PageBox FromCorners(PointD[] corners, double margin)
        {
            return new PageBox
            {
                MinX = corners.Min(p => p.X) - margin,
                MinY = corners.Min(p => p.Y) - margin,
                MaxX = corners.Max(p => p.X) + margin,
                MaxY = corners.Max(p => p.Y) + margin,
            };
        }

        /// <summary>Überschneidet sich der (waagerechte/senkrechte) Leitungsabschnitt mit dem Rechteck?</summary>
        public bool Intersects(ConnectionSegment segment)
        {
            PointD a = segment.A, b = segment.B;
            return Math.Max(a.X, b.X) >= MinX && Math.Min(a.X, b.X) <= MaxX
                && Math.Max(a.Y, b.Y) >= MinY && Math.Min(a.Y, b.Y) <= MaxY;
        }
    }

    internal struct ConnectionSegment
    {
        public string Page;
        public PointD A, B;
    }

    /// <summary>
    /// Leitungsweg einer Verbindung im Schaltplan. Die EPLAN API stellt die gezeichneten Linien nicht bereit,
    /// der Weg wird daher aus den Symbolen der Verbindung gebildet.
    /// </summary>
    internal static class ConnectionGeometry
    {
        /// <summary>
        /// Leitungsabschnitte einer Verbindung. SymbolReferences liefert den Weg in Reihenfolge:
        /// Gerät, Winkel, Unterbrechungsstelle, ... (über mehrere Seiten). Benachbarte Punkte derselben Seite bilden einen Abschnitt.
        /// </summary>
        public static IEnumerable<ConnectionSegment> Segments(Connection connection)
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
                    yield return new ConnectionSegment { Page = page, A = previous, B = point };
                }
                previousPage = page;
                previous = point;
            }
        }

        /// <summary>Markiert alle Verbindungen, deren Leitungsweg eines der Rechtecke (nach Seitenname) schneidet.</summary>
        public static void MarkIntersecting(Connection[] connections, Dictionary<string, List<PageBox>> boxesByPage, bool[] marked)
        {
            if (boxesByPage.Count == 0)
            {
                return;
            }

            for (int i = 0; i < connections.Length; i++)
            {
                foreach (var segment in Segments(connections[i]))
                {
                    if (!boxesByPage.TryGetValue(segment.Page, out var boxes))
                    {
                        continue;
                    }
                    foreach (var box in boxes.Where(b => b.Intersects(segment)))
                    {
                        box.Matched = true;
                        marked[i] = true;
                    }
                }
            }
        }

        public static bool SameLocation(PointD a, PointD b)
        {
            return Math.Abs(a.X - b.X) < 0.01 && Math.Abs(a.Y - b.Y) < 0.01;
        }

        private static bool IsSymbolOf(SymbolReference reference, string page, SymbolReference endpoint)
        {
            return endpoint != null
                && endpoint.Page?.Name == page
                && SameLocation(endpoint.Location, reference.Location);
        }

        private static PointD Offset(PointD point, PinBase pin)
        {
            return pin == null ? point : new PointD(point.X + pin.Location.X, point.Y + pin.Location.Y);
        }
    }
}
