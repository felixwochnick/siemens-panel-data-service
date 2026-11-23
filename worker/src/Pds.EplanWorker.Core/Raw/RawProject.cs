using System.Collections.Generic;

namespace Pds.EplanWorker.Raw
{
    // Rohdaten (raw.json, Format 1) – Vertrag mit packages/analyzer/src/types.ts und dem Spec, Abschnitt „Rohdaten“.
    // Der Worker liest nur, er entscheidet nichts. Strings sind nie null (RawJsonWriter schreibt null als ""),
    // Koordinaten in mm (Seitenkoordinaten, y wächst nach oben).

    /// <summary>Punkt in mm.</summary>
    public struct RawPoint
    {
        public RawPoint(double x, double y)
        {
            X = x;
            Y = y;
        }

        public double X { get; }

        public double Y { get; }
    }

    public sealed class RawProject
    {
        /// <summary>Version des Workers (hello.version).</summary>
        public string Worker { get; set; } = "";

        public string EplanVersion { get; set; } = "";

        public RawProjectInfo Project { get; set; } = new RawProjectInfo();

        /// <summary>Reihenfolge wie project.Pages.</summary>
        public List<RawPage> Pages { get; } = new List<RawPage>();

        /// <summary>DMObjectsFinder.GetConnections(null), alle (auch 3D).</summary>
        public List<RawConnection> Connections { get; } = new List<RawConnection>();

        public List<RawText> Texts { get; } = new List<RawText>();

        public List<RawLine> Lines { get; } = new List<RawLine>();

        public List<RawShield> Shields { get; } = new List<RawShield>();

        public List<RawCableDefinition> CableDefinitions { get; } = new List<RawCableDefinition>();
    }

    public sealed class RawProjectInfo
    {
        public string Name { get; set; } = "";

        public int PageCount { get; set; }
    }

    public sealed class RawPage
    {
        public string Name { get; set; } = "";

        /// <summary>Page.ReportBlock != null.</summary>
        public bool IsReport { get; set; }
    }

    public sealed class RawConnection
    {
        /// <summary>
        /// StorableObject.ToStringIdentifier(). Laut EPLAN-Doku nur gültig, solange das Projekt geöffnet ist: verbindet
        /// Adern und Verbindungen innerhalb einer raw.json, ist aber keine über Analysen hinweg stabile Kennung.
        /// </summary>
        public string Id { get; set; } = "";

        /// <summary>Connection3D (Schaltschrankaufbau).</summary>
        public bool Is3d { get; set; }

        public string Page { get; set; } = "";

        /// <summary>FunctionDefinition.Name, lokalisiert.</summary>
        public string Definition { get; set; } = "";

        /// <summary>CONNECTION_DESIGNATION.</summary>
        public string Designation { get; set; } = "";

        /// <summary>CONNECTION_SOURCE.</summary>
        public string SourceProperty { get; set; } = "";

        /// <summary>CONNECTION_DESTINATION.</summary>
        public string DestinationProperty { get; set; } = "";

        /// <summary>CONNECTION_WIRENUMBER.</summary>
        public string WireNumber { get; set; } = "";

        /// <summary>CONNECTION_WIRECROSSSECTION_WITH_UNIT.</summary>
        public string CrossSection { get; set; } = "";

        /// <summary>CONNECTION_WIRETYPE.</summary>
        public string WireType { get; set; } = "";

        /// <summary>CONNECTION_WIRELENGTH_FULL.</summary>
        public string Length { get; set; } = "";

        /// <summary>ArticleReferences[].PartNr, nicht leer, Reihenfolge der API (nicht entdoppelt).</summary>
        public List<string> PartNumbers { get; set; } = new List<string>();

        /// <summary>CableDefinitionLine; null ohne Kabel.</summary>
        public RawCableRef Cable { get; set; }

        /// <summary>StartPin; null ohne Anschluss.</summary>
        public RawPin Start { get; set; }

        /// <summary>EndPin; null ohne Anschluss.</summary>
        public RawPin End { get; set; }

        /// <summary>Connection.Shieldings.</summary>
        public List<RawShieldRef> Shieldings { get; } = new List<RawShieldRef>();

        /// <summary>SymbolReferences in API-Reihenfolge.</summary>
        public List<RawPagePoint> Symbols { get; } = new List<RawPagePoint>();

        public RawSymbolEnd StartSymbol { get; set; }

        public RawSymbolEnd EndSymbol { get; set; }
    }

    public sealed class RawCableRef
    {
        public string Name { get; set; } = "";

        /// <summary>FUNC_CABLETYPE.</summary>
        public string Type { get; set; } = "";

        /// <summary>FUNC_CABLEWIRECOUNTANDCROSSSECTION.</summary>
        public string WireCountAndCrossSection { get; set; } = "";
    }

    public sealed class RawPin
    {
        /// <summary>ParentFunction.Name; "" ohne Funktion.</summary>
        public string FunctionName { get; set; } = "";

        /// <summary>Pin.Name.</summary>
        public string PinName { get; set; } = "";

        /// <summary>Pin.Designation.</summary>
        public string PinDesignation { get; set; } = "";

        /// <summary>FUNC_PLCPLUG_DESIGNATION_AUTOMATIC der Funktion.</summary>
        public string PlugAutomatic { get; set; } = "";

        /// <summary>FUNC_PLCPLUG_DESIGNATION_MANUAL der Funktion.</summary>
        public string PlugManual { get; set; } = "";

        /// <summary>ParentFunction ist ein Shield.</summary>
        public bool ParentIsShield { get; set; }
    }

    public class RawPagePoint
    {
        public string Page { get; set; } = "";

        public double X { get; set; }

        public double Y { get; set; }
    }

    public sealed class RawShieldRef : RawPagePoint
    {
        public string Name { get; set; } = "";
    }

    /// <summary>Gerätesymbol am Ende einer Verbindung: Ursprung (Location) und Anschlusspunkt relativ dazu.</summary>
    public sealed class RawSymbolEnd : RawPagePoint
    {
        public double PinX { get; set; }

        public double PinY { get; set; }
    }

    public sealed class RawText : RawPagePoint
    {
        /// <summary>Deutsch, sonst sprachneutral, sonst Englisch; getrimmt.</summary>
        public string Content { get; set; } = "";

        /// <summary>Ecken von GetBoundingBox(); leer, wenn unlesbar.</summary>
        public List<RawPoint> Box { get; set; } = new List<RawPoint>();

        /// <summary>Group == null (Ausnahme ⇒ false).</summary>
        public bool Free { get; set; }
    }

    public sealed class RawLine
    {
        public string Page { get; set; } = "";

        public double X1 { get; set; }

        public double Y1 { get; set; }

        public double X2 { get; set; }

        public double Y2 { get; set; }
    }

    public sealed class RawShield : RawPagePoint
    {
        public string Name { get; set; } = "";

        /// <summary>SymbolVariant.VariantNr; -1, wenn unlesbar.</summary>
        public int Variant { get; set; } = -1;

        /// <summary>RECTANGLE_WIDTH in mm; null, wenn unlesbar.</summary>
        public double? Width { get; set; }

        /// <summary>RECTANGLE_HEIGHT in mm; null, wenn unlesbar.</summary>
        public double? Height { get; set; }
    }

    public sealed class RawCableDefinition : RawPagePoint
    {
        public const string KindCable = "cable";
        public const string KindShield = "shield";

        /// <summary>"cable" oder "shield".</summary>
        public string Kind { get; set; } = KindCable;

        public string Name { get; set; } = "";

        public string Definition { get; set; } = "";

        /// <summary>FUNC_CABLE_SOURCE.</summary>
        public string SourceProperty { get; set; } = "";

        /// <summary>FUNC_CABLE_DESTINATION.</summary>
        public string DestinationProperty { get; set; } = "";

        /// <summary>FUNC_CABLETYPE.</summary>
        public string Type { get; set; } = "";

        /// <summary>FUNC_CABLEWIRECOUNTANDCROSSSECTION.</summary>
        public string WireCountAndCrossSection { get; set; } = "";

        /// <summary>FUNC_CABLELENGTH_FULL.</summary>
        public string Length { get; set; } = "";

        public List<string> PartNumbers { get; set; } = new List<string>();

        /// <summary>Kabel: CableConnections; Schirm: Pins[].Connections – als RawConnection.Id, entdoppelt.</summary>
        public List<string> Wires { get; } = new List<string>();
    }
}
