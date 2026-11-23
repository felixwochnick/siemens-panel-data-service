// Stub von Eplan.EplApi.Baseu.dll (nur verwendete Mitglieder, siehe Eplan.EplApi.Stubs.csproj)
using System;

namespace Eplan.EplApi.Base
{
    /// <summary>Punkt auf einer Seite in mm.</summary>
    public struct PointD
    {
        public double X => throw new NotImplementedException();

        public double Y => throw new NotImplementedException();
    }

    public class ISOCode
    {
        public enum Language
        {
            L___,
            L_de_DE,
            L_en_US,
        }
    }

    /// <summary>Mehrsprachiger Text.</summary>
    public class MultiLangString
    {
        public string GetStringToDisplay(ISOCode.Language language) => throw new NotImplementedException();
    }
}
