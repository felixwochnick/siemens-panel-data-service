using System;
using System.Text.Json;

namespace Pds.EplanWorker.Protocol
{
    /// <summary>Nachrichten vom Worker an den Client (Feldnamen laut Spec, Abschnitt „Protokoll“).</summary>
    public static class Messages
    {
        /// <summary><c>{ "type": "hello", "protocol": 1, "version": "1.2.3" }</c></summary>
        public static Action<Utf8JsonWriter> Hello(string version)
        {
            return w =>
            {
                w.WriteString("type", "hello");
                w.WriteNumber("protocol", ProtocolConstants.ProtocolVersion);
                w.WriteString("version", JsonText.Clean(version));
            };
        }

        /// <summary><c>{ "type": "progress", "id": "r3", "stage": "opening" }</c></summary>
        public static Action<Utf8JsonWriter> Progress(string id, string stage)
        {
            return w =>
            {
                w.WriteString("type", "progress");
                WriteId(w, id);
                w.WriteString("stage", stage);
            };
        }

        /// <summary><c>{ "type": "log", "id": "r3", "level": "warn", "code": "…", "message": "…" }</c>, <c>id</c> optional.</summary>
        public static Action<Utf8JsonWriter> Log(string id, string level, string code, string message)
        {
            return w =>
            {
                w.WriteString("type", "log");
                if (id != null)
                {
                    w.WriteString("id", JsonText.Clean(id));
                }
                w.WriteString("level", level);
                w.WriteString("code", code);
                w.WriteString("message", JsonText.Clean(message));
            };
        }

        /// <summary><c>{ "type": "response", "id": "r2", "result": { … } }</c></summary>
        public static Action<Utf8JsonWriter> Result(string id, Action<Utf8JsonWriter> writeResult)
        {
            return w =>
            {
                w.WriteString("type", "response");
                WriteId(w, id);
                w.WriteStartObject("result");
                writeResult?.Invoke(w);
                w.WriteEndObject();
            };
        }

        /// <summary>
        /// <c>{ "type": "response", "id": "r1", "error": { "code": "…", "message": "…" } }</c>; ohne bekannte Anfrage-ID
        /// (z. B. ungültiges JSON) ist <c>id</c> <c>null</c>.
        /// </summary>
        public static Action<Utf8JsonWriter> Error(string id, string code, string message)
        {
            return w =>
            {
                w.WriteString("type", "response");
                WriteId(w, id);
                w.WriteStartObject("error");
                w.WriteString("code", code);
                w.WriteString("message", JsonText.Clean(message));
                w.WriteEndObject();
            };
        }

        private static void WriteId(Utf8JsonWriter w, string id)
        {
            if (id == null)
            {
                w.WriteNull("id");
            }
            else
            {
                w.WriteString("id", JsonText.Clean(id));
            }
        }
    }
}
