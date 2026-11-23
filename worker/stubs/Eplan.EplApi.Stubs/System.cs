// Stub von Eplan.EplApi.Systemu.dll (nur verwendete Mitglieder, siehe Eplan.EplApi.Stubs.csproj).
// Achtung: innerhalb von „namespace Eplan.EplApi.System“ meint „System.X“ diesen Namespace, daher nur einfache Namen.
using System;

namespace Eplan.EplApi.System
{
    /// <summary>EPLAN als Offline-Anwendung im eigenen Prozess.</summary>
    public class EplApplication
    {
        public enum QuietModes
        {
            ShowAllDialogs,
            ShowNoDialogs,
        }

        public EplApplication() => throw new NotImplementedException();

        public string EplanBinFolder
        {
            get => throw new NotImplementedException();
            set => throw new NotImplementedException();
        }

        public QuietModes QuietMode
        {
            get => throw new NotImplementedException();
            set => throw new NotImplementedException();
        }

        public string Variant => throw new NotImplementedException();

        public string Version => throw new NotImplementedException();

        public void Init(string strAppModifier, bool bLoadSystemAPIAddIns, bool bLoadAddIns) => throw new NotImplementedException();

        public void Exit() => throw new NotImplementedException();
    }
}
