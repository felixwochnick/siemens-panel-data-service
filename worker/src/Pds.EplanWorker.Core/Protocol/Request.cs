using System.Text.Json;

namespace Pds.EplanWorker.Protocol
{
    /// <summary>Anfrage des Clients: <c>{ "type": "request", "id": "r1", "method": "…", "params": { … } }</c>.</summary>
    public sealed class Request
    {
        private Request(string id, string method, JsonElement parameters)
        {
            Id = id;
            Method = method;
            Params = parameters;
        }

        public string Id { get; }

        public string Method { get; }

        /// <summary>Immer ein Objekt (fehlt <c>params</c>, ist es leer).</summary>
        public JsonElement Params { get; }

        /// <summary>
        /// Liest eine Zeile. Wirft <see cref="RequestException"/> mit der ID, soweit sie lesbar war (sonst <c>null</c>),
        /// damit die Fehlerantwort trotzdem zugeordnet werden kann.
        /// </summary>
        public static Request Parse(string line)
        {
            JsonElement root;
            try
            {
                using (var document = JsonDocument.Parse(line))
                {
                    // Clone: das Element bleibt nach dem Freigeben des Dokuments gültig
                    root = document.RootElement.Clone();
                }
            }
            catch (JsonException ex)
            {
                throw new RequestException(null, "Ungültiges JSON: " + ex.Message);
            }

            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new RequestException(null, "Eine Anfrage muss ein JSON-Objekt sein.");
            }

            string id = root.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String
                ? idElement.GetString()
                : null;
            if (id == null || id.Length == 0)
            {
                throw new RequestException(null, "\"id\" fehlt oder ist kein (nicht leerer) Text.");
            }

            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "request")
            {
                throw new RequestException(id, "\"type\" muss \"request\" sein.");
            }

            if (!root.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String)
            {
                throw new RequestException(id, "\"method\" fehlt.");
            }

            JsonElement parameters;
            if (!root.TryGetProperty("params", out parameters) || parameters.ValueKind == JsonValueKind.Null)
            {
                parameters = EmptyObject();
            }
            else if (parameters.ValueKind != JsonValueKind.Object)
            {
                throw new RequestException(id, "\"params\" muss ein Objekt sein.");
            }

            return new Request(id, method.GetString(), parameters);
        }

        private static JsonElement EmptyObject()
        {
            using (var document = JsonDocument.Parse("{}"))
            {
                return document.RootElement.Clone();
            }
        }
    }

    /// <summary>Anfrage ist ungültig (⇒ <c>invalid_request</c>); <see cref="RequestId"/> ist <c>null</c>, wenn unbekannt.</summary>
    public sealed class RequestException : System.Exception
    {
        public RequestException(string requestId, string message)
            : base(message)
        {
            RequestId = requestId;
        }

        public string RequestId { get; }
    }

    /// <summary>Liest Parameter einer Anfrage; Fehler ⇒ <c>invalid_request</c>.</summary>
    public static class ParamReader
    {
        public static string RequiredString(JsonElement parameters, string name)
        {
            string value = OptionalString(parameters, name, null);
            if (string.IsNullOrWhiteSpace(value))
            {
                throw Invalid("Parameter \"" + name + "\" fehlt oder ist leer.");
            }
            return value;
        }

        public static string OptionalString(JsonElement parameters, string name, string fallback)
        {
            if (!parameters.TryGetProperty(name, out var element) || element.ValueKind == JsonValueKind.Null)
            {
                return fallback;
            }
            if (element.ValueKind != JsonValueKind.String)
            {
                throw Invalid("Parameter \"" + name + "\" muss Text sein.");
            }
            return element.GetString();
        }

        public static int OptionalInt(JsonElement parameters, string name, int fallback)
        {
            if (!parameters.TryGetProperty(name, out var element) || element.ValueKind == JsonValueKind.Null)
            {
                return fallback;
            }
            if (element.ValueKind != JsonValueKind.Number || !element.TryGetInt32(out int value))
            {
                throw Invalid("Parameter \"" + name + "\" muss eine ganze Zahl sein.");
            }
            return value;
        }

        public static WorkerException Invalid(string message)
        {
            return new WorkerException(ErrorCodes.InvalidRequest, message);
        }
    }
}
