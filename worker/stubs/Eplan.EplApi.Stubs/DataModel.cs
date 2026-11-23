// Stub von Eplan.EplApi.DataModelu.dll (nur verwendete Mitglieder, siehe Eplan.EplApi.Stubs.csproj).
// Namespaces geprüft gegen https://www.eplan.help/en-US/Infoportal/content/api/2025/ (z. B. Group in DataModel,
// SymbolVariant in DataModel.MasterData).
using System;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel.EObjects;
using Eplan.EplApi.DataModel.MasterData;

namespace Eplan.EplApi.DataModel
{
    /// <summary>Gruppe (Symbol, Makro, Gerätegrafik), zu der eine Platzierung gehört.</summary>
    public class Group : Placement
    {
    }

    /// <summary>Basis aller Objekte der Projektdatenbank.</summary>
    public class StorableObject
    {
        /// <summary>Kennung des Objekts als Text; gleich für alle Zugriffe auf dasselbe Objekt.</summary>
        public string ToStringIdentifier() => throw new NotImplementedException();
    }

    public class Placement : StorableObject
    {
        public Page Page => throw new NotImplementedException();

        public PointD Location => throw new NotImplementedException();

        public Group Group => throw new NotImplementedException();
    }

    public class Project : StorableObject
    {
        public string ProjectName => throw new NotImplementedException();

        public Page[] Pages => throw new NotImplementedException();

        public void Close() => throw new NotImplementedException();
    }

    public class Page : StorableObject
    {
        public string Name => throw new NotImplementedException();

        /// <summary>Gesetzt bei automatisch erzeugten Auswertungsseiten.</summary>
        public ReportBlock ReportBlock => throw new NotImplementedException();

        public Placement[] AllPlacements => throw new NotImplementedException();
    }

    public class ReportBlock : StorableObject
    {
    }

    public class ProjectManager
    {
        public enum OpenMode
        {
            Standard,
            ReadOnly,
            Exclusive,
        }

        public ProjectManager() => throw new NotImplementedException();

        public Project OpenProject(string strProjectPath, OpenMode openMode) => throw new NotImplementedException();
    }

    /// <summary>Sperrt Projektdaten für Zugriffe; Dispose gibt alle Sperren frei.</summary>
    public class LockingStep : IDisposable
    {
        public LockingStep() => throw new NotImplementedException();

        public void Dispose() => throw new NotImplementedException();
    }

    public class ConnectionsFilter
    {
    }

    public class DMObjectsFinder
    {
        public DMObjectsFinder(Project project) => throw new NotImplementedException();

        public Connection[] GetConnections(ConnectionsFilter oConnectionsFilter) => throw new NotImplementedException();
    }

    public class PropertyValue
    {
        public bool IsEmpty => throw new NotImplementedException();

        public double ToDouble() => throw new NotImplementedException();

        public override string ToString() => throw new NotImplementedException();
    }

    public class FunctionPropertyList
    {
        public PropertyValue FUNC_CABLETYPE => throw new NotImplementedException();

        public PropertyValue FUNC_CABLEWIRECOUNTANDCROSSSECTION => throw new NotImplementedException();

        public PropertyValue FUNC_CABLE_SOURCE => throw new NotImplementedException();

        public PropertyValue FUNC_CABLE_DESTINATION => throw new NotImplementedException();

        public PropertyValue FUNC_CABLELENGTH_FULL => throw new NotImplementedException();

        public PropertyValue FUNC_PLCPLUG_DESIGNATION_AUTOMATIC => throw new NotImplementedException();

        public PropertyValue FUNC_PLCPLUG_DESIGNATION_MANUAL => throw new NotImplementedException();

        public PropertyValue RECTANGLE_WIDTH => throw new NotImplementedException();

        public PropertyValue RECTANGLE_HEIGHT => throw new NotImplementedException();
    }

    public class ConnectionPropertyList
    {
        public PropertyValue CONNECTION_DESIGNATION => throw new NotImplementedException();

        public PropertyValue CONNECTION_SOURCE => throw new NotImplementedException();

        public PropertyValue CONNECTION_DESTINATION => throw new NotImplementedException();

        public PropertyValue CONNECTION_WIRENUMBER => throw new NotImplementedException();

        public PropertyValue CONNECTION_WIRECROSSSECTION_WITH_UNIT => throw new NotImplementedException();

        public PropertyValue CONNECTION_WIRETYPE => throw new NotImplementedException();

        public PropertyValue CONNECTION_WIRELENGTH_FULL => throw new NotImplementedException();
    }

    public class FunctionDefinition : StorableObject
    {
        public MultiLangString Name => throw new NotImplementedException();
    }

    public class ArticleReference : StorableObject
    {
        public string PartNr => throw new NotImplementedException();
    }

    public class Function : Placement
    {
        public string Name => throw new NotImplementedException();

        public FunctionPropertyList Properties => throw new NotImplementedException();

        public FunctionDefinition FunctionDefinition => throw new NotImplementedException();

        public ArticleReference[] ArticleReferences => throw new NotImplementedException();

        public Pin[] Pins => throw new NotImplementedException();

        public SymbolVariant SymbolVariant => throw new NotImplementedException();
    }

    public class PinBase : Placement
    {
    }

    public class Pin : PinBase
    {
        public string Name => throw new NotImplementedException();

        public string Designation => throw new NotImplementedException();

        public Function ParentFunction => throw new NotImplementedException();

        public Connection[] Connections => throw new NotImplementedException();
    }

    public class SymbolReference : Placement
    {
    }

    public class Connection : Placement
    {
        public ConnectionPropertyList Properties => throw new NotImplementedException();

        public FunctionDefinition FunctionDefinition => throw new NotImplementedException();

        public ArticleReference[] ArticleReferences => throw new NotImplementedException();

        /// <summary>Kabel, zu dem die Verbindung als Ader gehört.</summary>
        public Cable CableDefinitionLine => throw new NotImplementedException();

        public Pin StartPin => throw new NotImplementedException();

        public Pin EndPin => throw new NotImplementedException();

        public Function[] Shieldings => throw new NotImplementedException();

        public SymbolReference[] SymbolReferences => throw new NotImplementedException();

        public SymbolReference StartSymbolReference => throw new NotImplementedException();

        public SymbolReference EndSymbolReference => throw new NotImplementedException();

        public PinBase StartSymbolConnPoint => throw new NotImplementedException();

        public PinBase EndSymbolConnPoint => throw new NotImplementedException();
    }
}

namespace Eplan.EplApi.DataModel.MasterData
{
    public class SymbolVariant
    {
        /// <summary>Typ in der Doku nicht angegeben; der Worker liest ihn über Convert.ToInt32.</summary>
        public int VariantNr => throw new NotImplementedException();
    }
}

namespace Eplan.EplApi.DataModel.Graphics
{
    public class Text : Placement
    {
        public MultiLangString Contents => throw new NotImplementedException();

        public PointD[] GetBoundingBox() => throw new NotImplementedException();
    }

    public class Line : Placement
    {
        public PointD StartPoint => throw new NotImplementedException();

        public PointD EndPoint => throw new NotImplementedException();
    }
}

namespace Eplan.EplApi.DataModel.EObjects
{
    public class Cable : Function
    {
        public Connection[] CableConnections => throw new NotImplementedException();
    }

    /// <summary>Schirm („Abschirmung, Kabeldefinition“).</summary>
    public class Shield : Function
    {
    }
}

namespace Eplan.EplApi.DataModel.E3D
{
    /// <summary>Verbindung im Schaltschrankaufbau (Doppelung der Schaltplan-Verbindung).</summary>
    public class Connection3D : Connection
    {
    }
}
