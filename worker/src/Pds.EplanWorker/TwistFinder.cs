using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Findet verdrillte Verbindungen am gezeichneten Verdrillungssymbol. Das Symbol ist keine EPLAN-Funktion, sondern
    /// besteht aus einzelnen Linien: ein Querbalken mit kurzem Haken an beiden Enden und einem Schrägstrich je Ader.
    /// Die Zuordnung erfolgt geometrisch: verdrillt sind die Verbindungen, die einen Schrägstrich kreuzen.
    /// </summary>
    internal static class TwistFinder
    {
        /// <summary>Maximale Länge (mm) von Haken und Schrägstrich (je Achse).</summary>
        private const double MarkLength = 3.0;

        /// <summary>Maximaler Abstand in mm zwischen Schrägstrich-Mitte und Leitung.</summary>
        private const double Tolerance = 1.0;

        private const double Epsilon = 0.01;

        /// <summary>
        /// Gibt pro Verbindung zurück, ob sie am Symbol verdrillt ist; symbolCount = Anzahl Verdrillungssymbole,
        /// unmatchedTicks = Schrägstriche ohne zugeordnete Verbindung.
        /// </summary>
        public static bool[] Find(Project project, Connection[] connections, out int symbolCount, out int unmatchedTicks)
        {
            var marksByPage = new Dictionary<string, List<PageBox>>();
            symbolCount = 0;

            foreach (var page in project.Pages)
            {
                var lines = page.AllPlacements.OfType<Line>().Select(line => new LineSegment(line.StartPoint, line.EndPoint)).ToList();
                var marks = new List<PageBox>();

                foreach (var bar in lines.Where(line => line.IsAxisAligned && line.Length > 2 * MarkLength))
                {
                    var ticks = lines.Where(line => line.IsDiagonal && line.Length <= MarkLength && bar.Contains(line.Middle)).ToList();
                    if (ticks.Count < 2 || !HasHook(lines, bar, bar.A) || !HasHook(lines, bar, bar.B))
                    {
                        continue;
                    }

                    symbolCount++;
                    marks.AddRange(ticks.Select(tick => PageBox.FromCorners(new[] { tick.Middle }, Tolerance)));
                }

                if (marks.Count > 0)
                {
                    marksByPage[page.Name] = marks;
                }
            }

            var twisted = new bool[connections.Length];
            ConnectionGeometry.MarkIntersecting(connections, marksByPage, twisted);
            unmatchedTicks = marksByPage.Values.SelectMany(m => m).Count(m => !m.Matched);
            return twisted;
        }

        /// <summary>Kurze, zum Balken senkrechte Linie, die am Balkenende beginnt.</summary>
        private static bool HasHook(List<LineSegment> lines, LineSegment bar, PointD end)
        {
            return lines.Any(line => line.IsAxisAligned
                && line.IsHorizontal != bar.IsHorizontal
                && line.Length <= MarkLength
                && (ConnectionGeometry.SameLocation(line.A, end) || ConnectionGeometry.SameLocation(line.B, end)));
        }

        private struct LineSegment
        {
            public readonly PointD A, B;

            public LineSegment(PointD a, PointD b)
            {
                A = a;
                B = b;
            }

            private double Dx => Math.Abs(B.X - A.X);
            private double Dy => Math.Abs(B.Y - A.Y);

            public bool IsHorizontal => Dy < Epsilon && Dx >= Epsilon;
            public bool IsAxisAligned => IsHorizontal || (Dx < Epsilon && Dy >= Epsilon);
            public bool IsDiagonal => Dx >= Epsilon && Math.Abs(Dx - Dy) < Epsilon;
            public double Length => Math.Max(Dx, Dy);
            public PointD Middle => new PointD((A.X + B.X) / 2, (A.Y + B.Y) / 2);

            /// <summary>Liegt der Punkt auf dieser (waagerechten/senkrechten) Linie?</summary>
            public bool Contains(PointD p)
            {
                return p.X >= Math.Min(A.X, B.X) - Epsilon && p.X <= Math.Max(A.X, B.X) + Epsilon
                    && p.Y >= Math.Min(A.Y, B.Y) - Epsilon && p.Y <= Math.Max(A.Y, B.Y) + Epsilon;
            }
        }
    }
}
