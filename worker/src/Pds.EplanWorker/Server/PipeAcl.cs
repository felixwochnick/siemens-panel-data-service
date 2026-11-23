using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker.Server
{
    /// <summary>
    /// Zugriffsrechte der Pipe: nur der Web-Dienst (<c>NT SERVICE\pds</c>), Administratoren und das Konto des Workers
    /// selbst (EPLAN-Konto); sonst niemand. Kein Port, kein Geheimnis – die ACL ist die Zugangskontrolle.
    /// </summary>
    internal static class PipeAcl
    {
        public static PipeSecurity Create()
        {
            var security = new PipeSecurity();
            // Keine geerbten Einträge: nur die drei Konten unten
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

            // Web-Dienst: lesen und schreiben, aber keine weiteren Instanzen anlegen (CreateNewInstance gehört zu
            // FullControl) – so kann er sich nicht selbst als Worker ausgeben. Synchronize braucht der Client zum Öffnen.
            var webService = new SecurityIdentifier(ServiceSid.For(ProtocolConstants.WebServiceName));
            security.AddAccessRule(new PipeAccessRule(webService,
                PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));

            var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            security.AddAccessRule(new PipeAccessRule(administrators, PipeAccessRights.FullControl, AccessControlType.Allow));

            // Eigenes Konto: braucht FullControl, um nach jeder Verbindung eine neue Instanz anzulegen
            using (var self = WindowsIdentity.GetCurrent())
            {
                security.AddAccessRule(new PipeAccessRule(self.User, PipeAccessRights.FullControl, AccessControlType.Allow));
            }
            return security;
        }
    }
}
