using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.E3D;
using Eplan.EplApi.DataModel.EObjects;
using Eplan.EplApi.DataModel.Graphics;
using Pds.EplanWorker.Raw;

namespace Pds.EplanWorker.Eplan
{
    /// <summary>
    /// Liest die Rohdaten eines geöffneten Projekts (Spec „Rohdaten“, packages/analyzer/src/types.ts). Entscheidet
    /// nichts: keine Zuordnung, kein Filtern, keine Sortierung – das macht packages/analyzer.
    /// Darf nur auf dem EPLAN-Thread mit aktivem LockingStep laufen.
    /// </summary>
    /// <remarks>
    /// Fehlerbehandlung je Feld:
    /// <list type="bullet">
    /// <item>Eigenschaften (PropertyValue), Funktionsdefinition, Pin.Name, Artikelnummern, Kabel und Schirme einer
    /// Verbindung: Ausnahme ⇒ Leerwert ohne Meldung, wie im bisherigen ConnectionExporter (die Eigenschaft gibt es an
    /// diesem Objekt dann einfach nicht).</item>
    /// <item>Alles andere (Seite, Lage, Anschlüsse, Symbole, Texte, Linien, Schirmsymbole, Adern): Ausnahme ⇒
    /// Leerwert und Zähler je Code (<see cref="IssueCodes"/>), gemeldet einmal je Code mit Anzahl.</item>
    /// <item>3D-Verbindungen unterstützen viele Eigenschaften nicht; ihre Lesefehler werden nicht gezählt.</item>
    /// </list>
    /// Zugriffe auf die EPLAN-API wie im bisherigen Stand (ConnectionExporter, CableList, TextList, …), damit die
    /// Signaturen zu den echten DLLs passen; Koordinaten werden nur über .X/.Y gelesen.
    /// </remarks>
    internal sealed class RawExtractor
    {
        private readonly IAnalysisReporter _reporter;

        public RawExtractor(IAnalysisReporter reporter)
        {
            _reporter = reporter;
        }

        public RawProject Extract(Project project, string eplanVersion)
        {
            var raw = new RawProject { EplanVersion = eplanVersion ?? "" };
            raw.Project.Name = Read(IssueCodes.ProjectUnreadable, () => project.ProjectName ?? "", "");

            // Ohne Seiten bzw. Verbindungen ist die Analyse wertlos: Ausnahme ⇒ read_failed
            Page[] pages = project.Pages ?? new Page[0];
            raw.Project.PageCount = pages.Length;
            foreach (var page in pages)
            {
                ReadPage(raw, page);
            }

            foreach (var connection in new DMObjectsFinder(project).GetConnections(null) ?? new Connection[0])
            {
                raw.Connections.Add(ReadConnection(connection));
            }
            return raw;
        }

        // ── Seiten ───────────────────────────────────────────────────────────────

        private void ReadPage(RawProject raw, Page page)
        {
            string name = Read(IssueCodes.PageUnreadable, () => page.Name ?? "", "");
            raw.Pages.Add(new RawPage
            {
                Name = name,
                // Wie bisher TextList.IsReport: Ausnahme ⇒ keine Auswertungsseite
                IsReport = Silent(() => page.ReportBlock != null, false),
            });

            var placements = Read(IssueCodes.PageUnreadable, () => page.AllPlacements, null);
            if (placements == null)
            {
                return;
            }

            foreach (var text in placements.OfType<Text>())
            {
                raw.Texts.Add(ReadText(name, text));
            }
            foreach (var line in placements.OfType<Line>())
            {
                raw.Lines.Add(ReadLine(name, line));
            }
            foreach (var shield in placements.OfType<Shield>())
            {
                raw.Shields.Add(ReadShield(name, shield));
            }
            // Wie bisher CableList: Kabel und Schirme in Seitenreihenfolge, nicht entdoppelt
            foreach (var function in placements.OfType<Function>().Where(f => f is Cable || f is Shield))
            {
                raw.CableDefinitions.Add(ReadCableDefinition(name, function));
            }
        }

        private RawText ReadText(string page, Text text)
        {
            const string code = IssueCodes.TextUnreadable;
            var location = ReadPoint(code, () => { var p = text.Location; return new RawPoint(p.X, p.Y); });
            return new RawText
            {
                Page = page,
                // Wie bisher TextList.Content (Contents direkt, nicht über eine Variable vom Typ MultiLangString)
                Content = Read(code, () => Localization.Choose(
                    () => text.Contents.GetStringToDisplay(ISOCode.Language.L_de_DE),
                    () => text.Contents.GetStringToDisplay(ISOCode.Language.L___),
                    () => text.Contents.GetStringToDisplay(ISOCode.Language.L_en_US)), ""),
                X = location.X,
                Y = location.Y,
                Box = Read(code, () => text.GetBoundingBox().Select(corner => new RawPoint(corner.X, corner.Y)).ToList(), new List<RawPoint>()),
                // Texte in Gruppen gehören zu Symbolen, Gerätegrafiken oder Makros
                Free = Read(code, () => text.Group == null, false),
            };
        }

        private RawLine ReadLine(string page, Line line)
        {
            const string code = IssueCodes.LineUnreadable;
            var start = ReadPoint(code, () => { var p = line.StartPoint; return new RawPoint(p.X, p.Y); });
            var end = ReadPoint(code, () => { var p = line.EndPoint; return new RawPoint(p.X, p.Y); });
            return new RawLine { Page = page, X1 = start.X, Y1 = start.Y, X2 = end.X, Y2 = end.Y };
        }

        private RawShield ReadShield(string page, Shield shield)
        {
            const string code = IssueCodes.ShieldUnreadable;
            var location = ReadPoint(code, () => { var p = shield.Location; return new RawPoint(p.X, p.Y); });
            return new RawShield
            {
                Page = page,
                Name = Read(code, () => shield.Name ?? "", ""),
                X = location.X,
                Y = location.Y,
                Variant = Read(code, () => Convert.ToInt32(shield.SymbolVariant.VariantNr), -1),
                Width = Read(code, () => (double?)shield.Properties.RECTANGLE_WIDTH.ToDouble(), null),
                Height = Read(code, () => (double?)shield.Properties.RECTANGLE_HEIGHT.ToDouble(), null),
            };
        }

        private RawCableDefinition ReadCableDefinition(string page, Function function)
        {
            const string code = IssueCodes.CableUnreadable;
            var location = ReadPoint(code, () => { var p = function.Location; return new RawPoint(p.X, p.Y); });
            var cable = new RawCableDefinition
            {
                Page = page,
                Kind = function is Cable ? RawCableDefinition.KindCable : RawCableDefinition.KindShield,
                Name = Read(code, () => function.Name ?? "", ""),
                X = location.X,
                Y = location.Y,
                Definition = Silent(() => Localized(function.FunctionDefinition?.Name), ""),
                SourceProperty = Value(() => function.Properties.FUNC_CABLE_SOURCE),
                DestinationProperty = Value(() => function.Properties.FUNC_CABLE_DESTINATION),
                Type = Value(() => function.Properties.FUNC_CABLETYPE),
                WireCountAndCrossSection = Value(() => function.Properties.FUNC_CABLEWIRECOUNTANDCROSSSECTION),
                Length = Value(() => function.Properties.FUNC_CABLELENGTH_FULL),
                PartNumbers = PartNumbers(() => function.ArticleReferences),
            };

            // Kabel: Adern; Schirm: Anschlussleitungen (Schirm → Schirmklemme/Erdung)
            IEnumerable<Connection> wires;
            if (function is Cable cableFunction)
            {
                wires = Read(code, () => cableFunction.CableConnections, null);
            }
            else
            {
                wires = Read(code, () => function.Pins.SelectMany(pin => pin.Connections).ToArray(), null);
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var wire in wires ?? Enumerable.Empty<Connection>())
            {
                string id = Read(code, () => wire.ToStringIdentifier() ?? "", "");
                if (id.Length > 0 && seen.Add(id))
                {
                    cable.Wires.Add(id);
                }
            }
            return cable;
        }

        // ── Verbindungen ─────────────────────────────────────────────────────────

        private RawConnection ReadConnection(Connection connection)
        {
            bool is3d = connection is Connection3D;
            // 3D-Verbindungen (Schaltschrankaufbau) unterstützen viele Eigenschaften nicht: Fehler dort nicht melden
            string code = is3d ? null : IssueCodes.ConnectionUnreadable;

            var raw = new RawConnection
            {
                Id = Read(code, () => connection.ToStringIdentifier() ?? "", ""),
                Is3d = is3d,
                Page = Read(code, () => connection.Page?.Name ?? "", ""),
                Definition = Silent(() => Localized(connection.FunctionDefinition?.Name), ""),
                Designation = Value(() => connection.Properties.CONNECTION_DESIGNATION),
                SourceProperty = Value(() => connection.Properties.CONNECTION_SOURCE),
                DestinationProperty = Value(() => connection.Properties.CONNECTION_DESTINATION),
                WireNumber = Value(() => connection.Properties.CONNECTION_WIRENUMBER),
                CrossSection = Value(() => connection.Properties.CONNECTION_WIRECROSSSECTION_WITH_UNIT),
                WireType = Value(() => connection.Properties.CONNECTION_WIRETYPE),
                Length = Value(() => connection.Properties.CONNECTION_WIRELENGTH_FULL),
                PartNumbers = PartNumbers(() => connection.ArticleReferences),
                Cable = ReadCableRef(connection),
                Start = ReadPin(code, () => connection.StartPin),
                End = ReadPin(code, () => connection.EndPin),
                StartSymbol = ReadSymbolEnd(code, () => connection.StartSymbolReference, () => connection.StartSymbolConnPoint),
                EndSymbol = ReadSymbolEnd(code, () => connection.EndSymbolReference, () => connection.EndSymbolConnPoint),
            };

            // Wie bisher ShieldFinder.Shieldings: Ausnahme ⇒ keine Schirme, ohne Meldung
            foreach (var shield in Silent(() => connection.Shieldings ?? new Function[0], new Function[0]))
            {
                var location = ReadPoint(code, () => { var p = shield.Location; return new RawPoint(p.X, p.Y); });
                raw.Shieldings.Add(new RawShieldRef
                {
                    Page = Read(code, () => shield.Page?.Name ?? "", ""),
                    X = location.X,
                    Y = location.Y,
                    Name = Read(code, () => shield.Name ?? "", ""),
                });
            }

            // Leitungsweg: Gerät, Winkel, Unterbrechungsstelle, … in API-Reihenfolge
            var symbols = Read(code, () => connection.SymbolReferences.ToArray(), null);
            foreach (var reference in symbols ?? new SymbolReference[0])
            {
                var location = ReadPoint(code, () => { var p = reference.Location; return new RawPoint(p.X, p.Y); });
                raw.Symbols.Add(new RawPagePoint
                {
                    Page = Read(code, () => reference.Page?.Name ?? "", ""),
                    X = location.X,
                    Y = location.Y,
                });
            }
            return raw;
        }

        /// <summary>Kabel, zu dem die Verbindung als Ader gehört (wie bisher ShieldFinder.CableOf: Ausnahme ⇒ kein Kabel).</summary>
        private static RawCableRef ReadCableRef(Connection connection)
        {
            Cable cable = Silent(() => connection.CableDefinitionLine, null);
            if (cable == null)
            {
                return null;
            }
            return new RawCableRef
            {
                Name = Silent(() => cable.Name ?? "", ""),
                Type = Value(() => cable.Properties.FUNC_CABLETYPE),
                WireCountAndCrossSection = Value(() => cable.Properties.FUNC_CABLEWIRECOUNTANDCROSSSECTION),
            };
        }

        /// <summary>
        /// Anschluss einer Verbindung. Ohne ParentFunction trotzdem ein Pin-Objekt (functionName ""), damit
        /// „Anschluss vorhanden“ erkennbar bleibt (Schirmanschlüsse haben beide Enden null).
        /// </summary>
        private RawPin ReadPin(string code, Func<Pin> getPin)
        {
            Pin pin = Read(code, getPin, null);
            if (pin == null)
            {
                return null;
            }

            var raw = new RawPin
            {
                // Anschlussbezeichnung wie im Verbindungsnavigator (z. B. "1/L1", "B"); fehlt an manchen Anschlüssen
                PinName = Silent(() => pin.Name ?? "", ""),
                PinDesignation = Read(code, () => pin.Designation ?? "", ""),
            };

            Function function = Read(code, () => pin.ParentFunction, null);
            if (function != null)
            {
                raw.FunctionName = Read(code, () => function.Name ?? "", "");
                raw.PlugAutomatic = Value(() => function.Properties.FUNC_PLCPLUG_DESIGNATION_AUTOMATIC);
                raw.PlugManual = Value(() => function.Properties.FUNC_PLCPLUG_DESIGNATION_MANUAL);
                raw.ParentIsShield = function is Shield;
            }
            return raw;
        }

        /// <summary>Gerätesymbol am Ende: Lage der SymbolReference, Anschlusspunkt relativ dazu (0/0 ohne ConnPoint).</summary>
        private RawSymbolEnd ReadSymbolEnd(string code, Func<SymbolReference> getReference, Func<PinBase> getConnPoint)
        {
            SymbolReference reference = Read(code, getReference, null);
            if (reference == null)
            {
                return null;
            }

            var location = ReadPoint(code, () => { var p = reference.Location; return new RawPoint(p.X, p.Y); });
            PinBase connPoint = Read(code, getConnPoint, null);
            var pin = connPoint == null
                ? new RawPoint(0, 0)
                : ReadPoint(code, () => { var p = connPoint.Location; return new RawPoint(p.X, p.Y); });
            return new RawSymbolEnd
            {
                Page = Read(code, () => reference.Page?.Name ?? "", ""),
                X = location.X,
                Y = location.Y,
                PinX = pin.X,
                PinY = pin.Y,
            };
        }

        // ── Hilfen ───────────────────────────────────────────────────────────────

        /// <summary>Deutsch, sonst sprachneutral, sonst Englisch, getrimmt.</summary>
        private static string Localized(MultiLangString text)
        {
            if (text == null)
            {
                return "";
            }
            return Localization.Choose(
                () => text.GetStringToDisplay(ISOCode.Language.L_de_DE),
                () => text.GetStringToDisplay(ISOCode.Language.L___),
                () => text.GetStringToDisplay(ISOCode.Language.L_en_US));
        }

        /// <summary>Wie bisher ConnectionExporter.Value: leer ⇒ "", Ausnahme (Eigenschaft gibt es hier nicht) ⇒ "".</summary>
        private static string Value(Func<PropertyValue> property)
        {
            try
            {
                var value = property();
                return value.IsEmpty ? "" : value.ToString() ?? "";
            }
            catch (Exception)
            {
                return "";
            }
        }

        /// <summary>Artikelnummern, nicht leer, in API-Reihenfolge (entdoppelt wird in der Auswertung).</summary>
        private static List<string> PartNumbers(Func<ArticleReference[]> references)
        {
            try
            {
                return (references() ?? new ArticleReference[0])
                    .Select(reference => reference.PartNr)
                    .Where(partNr => !string.IsNullOrEmpty(partNr))
                    .ToList();
            }
            catch (Exception)
            {
                return new List<string>();
            }
        }

        private T Read<T>(string code, Func<T> read, T fallback)
        {
            try
            {
                return read();
            }
            catch (Exception ex)
            {
                if (code != null)
                {
                    _reporter.Issue(code, ex);
                }
                return fallback;
            }
        }

        private RawPoint ReadPoint(string code, Func<RawPoint> read)
        {
            return Read(code, read, new RawPoint(0, 0));
        }

        private static T Silent<T>(Func<T> read, T fallback)
        {
            try
            {
                return read();
            }
            catch (Exception)
            {
                return fallback;
            }
        }
    }
}
