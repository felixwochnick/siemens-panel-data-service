using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Pds.EplanWorker.Protocol
{
    /// <summary>
    /// Schreibt Nachrichten als JSON-Zeilen (UTF-8 ohne BOM, <c>\n</c>). Mehrere Threads schreiben gleichzeitig (Lese-
    /// schleife, EPLAN-Thread mit Fortschritt, Abschluss der Analyse); die Zeilen gehen in der Reihenfolge der Aufrufe
    /// hinaus und werden nie vermischt. Ist die Gegenstelle weg, werden weitere Nachrichten verworfen.
    /// </summary>
    public sealed class MessageWriter
    {
        private readonly Stream _output;
        private readonly ILogger _logger;
        private readonly object _sync = new object();
        private Task _tail = Task.CompletedTask;
        private volatile bool _broken;

        public MessageWriter(Stream output, ILogger logger)
        {
            _output = output ?? throw new ArgumentNullException(nameof(output));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        /// <summary>Die Gegenstelle ist nicht mehr erreichbar.</summary>
        public bool IsBroken => _broken;

        /// <summary>
        /// Reiht eine Nachricht ein. <paramref name="writeProperties"/> schreibt die Eigenschaften des Objekts. Die
        /// Aufgabe endet, wenn die Zeile geschrieben ist; sie schlägt nie fehl (Schreibfehler machen den Writer „kaputt“).
        /// </summary>
        public Task WriteAsync(Action<Utf8JsonWriter> writeProperties)
        {
            // Sofort serialisieren: spätere Änderungen an den Daten wirken nicht mehr, und Fehler treffen den Aufrufer
            byte[] line = Serialize(writeProperties);
            lock (_sync)
            {
                _tail = _tail.ContinueWith(_ => WriteLineAsync(line), CancellationToken.None,
                    TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
                return _tail;
            }
        }

        /// <summary>Wartet, bis alle bisher eingereihten Nachrichten geschrieben sind.</summary>
        public Task FlushAsync()
        {
            lock (_sync)
            {
                return _tail;
            }
        }

        /// <summary>Eine Nachricht als Zeile: <c>{…}\n</c>.</summary>
        internal static byte[] Serialize(Action<Utf8JsonWriter> writeProperties)
        {
            using (var buffer = new MemoryStream())
            {
                using (var writer = new Utf8JsonWriter(buffer, JsonText.WriterOptions))
                {
                    writer.WriteStartObject();
                    writeProperties(writer);
                    writer.WriteEndObject();
                }
                buffer.WriteByte((byte)'\n');
                return buffer.ToArray();
            }
        }

        private async Task WriteLineAsync(byte[] line)
        {
            if (_broken)
            {
                return;
            }

            try
            {
                await _output.WriteAsync(line, 0, line.Length).ConfigureAwait(false);
                await _output.FlushAsync().ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException || ex is ObjectDisposedException || ex is InvalidOperationException
                                       || ex is NotSupportedException || ex is OperationCanceledException)
            {
                _broken = true;
                _logger.LogDebug("Gegenstelle nicht mehr erreichbar, Nachrichten werden verworfen ({Error})", ex.Message);
            }
        }
    }
}
