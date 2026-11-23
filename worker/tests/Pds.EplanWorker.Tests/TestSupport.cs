using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipelines;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Pds.EplanWorker.Protocol;
using Pds.EplanWorker.Raw;

namespace Pds.EplanWorker.Tests
{
    /// <summary>Ersatz für EPLAN: meldet die Stufen wie der echte Leser und liefert Beispiel-Rohdaten.</summary>
    internal sealed class FakeReader : IProjectReader
    {
        private readonly object _sync = new object();
        private EplanStatus _status = EplanStatus.NotStarted;

        public EplanStatus Eplan
        {
            get
            {
                lock (_sync)
                {
                    return _status;
                }
            }
        }

        /// <summary>Hält die Analyse nach dem EPLAN-Start an, bis der Test sie freigibt.</summary>
        public TaskCompletionSource Gate { get; set; }

        /// <summary>Wird gesetzt, sobald ReadAsync läuft (EPLAN „gestartet“).</summary>
        public TaskCompletionSource Entered { get; } = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        public Func<ProjectSource, IAnalysisReporter, RawProject> Read { get; set; } = (_, _) => Samples.Project();

        public ProjectSource LastSource { get; private set; }

        public bool RestoreFolderWasEmpty { get; private set; }

        public int Calls { get; private set; }

        public async Task<RawProject> ReadAsync(EplanPaths eplan, ProjectSource source, IAnalysisReporter reporter)
        {
            Calls++;
            LastSource = source;
            if (Eplan.State != EplanState.Ready)
            {
                reporter.Progress(Stages.StartingEplan);
                lock (_sync)
                {
                    _status = new EplanStatus(EplanState.Ready, "2025.0.3", eplan);
                }
            }
            Entered.TrySetResult();
            if (Gate != null)
            {
                await Gate.Task;
            }

            if (source.IsArchive)
            {
                reporter.Progress(Stages.Restoring);
                RestoreFolderWasEmpty = Directory.Exists(source.RestoreFolder) && !Directory.EnumerateFileSystemEntries(source.RestoreFolder).Any();
                File.WriteAllText(Path.Combine(source.RestoreFolder, "Anlage.elk"), "");
            }
            reporter.Progress(Stages.Opening);
            reporter.Progress(Stages.Reading);
            return Read(source, reporter);
        }
    }

    /// <summary>Client am anderen Ende einer Sitzung, über zwei In-Memory-Pipes.</summary>
    internal sealed class TestClient : IAsyncDisposable
    {
        public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

        private readonly Pipe _toWorker = new Pipe();
        private readonly Pipe _fromWorker = new Pipe();
        private readonly RecordingStream _output;
        private readonly StreamReader _reader;

        public TestClient(WorkerController worker)
        {
            _output = new RecordingStream(_fromWorker.Writer.AsStream());
            var session = new Session(_toWorker.Reader.AsStream(), _output, worker, OnExit, NullLogger.Instance);
            SessionTask = Task.Run(() => session.RunAsync());
            _reader = new StreamReader(_fromWorker.Reader.AsStream(), new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false);
        }

        public Task SessionTask { get; }

        /// <summary>Alle Bytes, die der Worker bisher geschrieben hat.</summary>
        public byte[] WrittenBytes => _output.Recorded;

        public List<int> ExitCodes { get; } = new List<int>();

        /// <summary>Alle bisher gelesenen Nachrichten (auch die, auf die <see cref="ResponseAsync"/> nicht gewartet hat).</summary>
        public List<JsonElement> Received { get; } = new List<JsonElement>();

        public static Dictionary<string, object> Paths(string product = @"C:\Program Files\EPLAN\Electric P8\2025.0.3\Bin")
        {
            return new Dictionary<string, object>
            {
                ["platformBin"] = @"C:\Program Files\EPLAN\Platform\2025.0.3\Bin",
                ["productBin"] = product,
                ["applicationModifier"] = "",
            };
        }

        public async Task SendLineAsync(string line)
        {
            await _toWorker.Writer.WriteAsync(Encoding.UTF8.GetBytes(line + "\n"));
        }

        public Task SendAsync(string id, string method, object parameters = null)
        {
            return SendLineAsync(JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["type"] = "request",
                ["id"] = id,
                ["method"] = method,
                ["params"] = parameters ?? new Dictionary<string, object>(),
            }));
        }

        public async Task<JsonElement> NextAsync()
        {
            string line = await _reader.ReadLineAsync().WaitAsync(Timeout);
            Assert.NotNull(line);
            using var document = JsonDocument.Parse(line);
            var message = document.RootElement.Clone();
            Received.Add(message);
            return message;
        }

        /// <summary>Liest bis zur Antwort mit dieser ID.</summary>
        public async Task<JsonElement> ResponseAsync(string id)
        {
            while (true)
            {
                var message = await NextAsync();
                if (message.GetProperty("type").GetString() == "response" && message.GetProperty("id").GetString() == id)
                {
                    return message;
                }
            }
        }

        /// <summary>Sendet und liest bis zur Antwort.</summary>
        public async Task<JsonElement> RequestAsync(string id, string method, object parameters = null)
        {
            await SendAsync(id, method, parameters);
            return await ResponseAsync(id);
        }

        public async Task ConfigureAsync()
        {
            var response = await RequestAsync("configure", Methods.Configure, Paths());
            Assert.True(response.TryGetProperty("result", out _), response.ToString());
        }

        /// <summary>Schließt die Eingabe (Client trennt) und wartet auf das Ende der Sitzung.</summary>
        public async Task CloseInputAsync()
        {
            await _toWorker.Writer.CompleteAsync();
            await SessionTask.WaitAsync(Timeout);
        }

        public async ValueTask DisposeAsync()
        {
            await _toWorker.Writer.CompleteAsync();
            try
            {
                await SessionTask.WaitAsync(Timeout);
            }
            catch (TimeoutException)
            {
                // Test ist ohnehin schon gescheitert
            }
        }

        private void OnExit(int code)
        {
            lock (ExitCodes)
            {
                ExitCodes.Add(code);
            }
        }
    }

    /// <summary>Schreibt durch und merkt sich jedes geschriebene Byte.</summary>
    internal sealed class RecordingStream : Stream
    {
        private readonly Stream _inner;
        private readonly MemoryStream _recorded = new MemoryStream();

        public RecordingStream(Stream inner)
        {
            _inner = inner;
        }

        public byte[] Recorded
        {
            get
            {
                lock (_recorded)
                {
                    return _recorded.ToArray();
                }
            }
        }

        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            Record(buffer, offset, count);
            _inner.Write(buffer, offset, count);
        }

        public override async Task WriteAsync(byte[] buffer, int offset, int count, System.Threading.CancellationToken cancellationToken)
        {
            Record(buffer, offset, count);
            await _inner.WriteAsync(buffer.AsMemory(offset, count), cancellationToken);
        }

        public override void Flush() => _inner.Flush();

        public override Task FlushAsync(System.Threading.CancellationToken cancellationToken) => _inner.FlushAsync(cancellationToken);

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        private void Record(byte[] buffer, int offset, int count)
        {
            lock (_recorded)
            {
                _recorded.Write(buffer, offset, count);
            }
        }
    }

    /// <summary>Temporärer Arbeitsordner mit Projektdateien.</summary>
    internal sealed class TempFolder : IDisposable
    {
        public TempFolder()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "pds-eplan-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public string File(string name)
        {
            return System.IO.Path.Combine(Path, name);
        }

        /// <summary>Archiv (Inhalt egal, den Leser gibt es nur als Ersatz).</summary>
        public string Archive(string name = "Anlage.zw1")
        {
            string path = File(name);
            System.IO.File.WriteAllText(path, "zw1");
            return path;
        }

        /// <summary>.elk mit .edb-Ordner.</summary>
        public string ElkProject(string name = "Anlage")
        {
            string elk = File(name + ".elk");
            System.IO.File.WriteAllText(elk, "");
            Directory.CreateDirectory(File(name + ".edb"));
            return elk;
        }

        public Dictionary<string, object> AnalyzeParams(string projectPath, string openMode = null)
        {
            var parameters = new Dictionary<string, object>
            {
                ["projectPath"] = projectPath,
                ["workFolder"] = Path,
                ["outputFile"] = File("raw.json"),
            };
            if (openMode != null)
            {
                parameters["openMode"] = openMode;
            }
            return parameters;
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, true);
            }
            catch (IOException)
            {
            }
        }
    }

    internal static class Samples
    {
        /// <summary>Kleines Projekt mit allen Feldarten.</summary>
        public static RawProject Project()
        {
            var raw = new RawProject
            {
                Worker = "9.9.9",
                EplanVersion = "2025.0.3",
                Project = { Name = "Anlage", PageCount = 2 },
            };
            raw.Pages.Add(new RawPage { Name = "=VB030+LCM&EFS/7", IsReport = false });
            raw.Pages.Add(new RawPage { Name = "=A/1", IsReport = true });

            var connection = new RawConnection
            {
                Id = "1/2",
                Page = "=VB030+LCM&EFS/7",
                Definition = "Ader / Draht",
                Designation = "VD_X500",
                WireNumber = "BK",
                CrossSection = "1,5 mm²",
                WireType = "SIENOPYR(90)",
                PartNumbers = { "A1", "A1" },
                Cable = new RawCableRef { Name = "-W1", Type = "GSC-01", WireCountAndCrossSection = "4x0,22" },
                Start = new RawPin { FunctionName = "=VB030+LCM-Q20", PinName = "1", PinDesignation = "1" },
                StartSymbol = new RawSymbolEnd { Page = "=VB030+LCM&EFS/7", X = 1, Y = 2, PinX = 0.5, PinY = 0 },
            };
            connection.Shieldings.Add(new RawShieldRef { Page = "=VB030+LCM&EFS/7", X = 10.5, Y = -2, Name = "" });
            connection.Symbols.Add(new RawPagePoint { Page = "=VB030+LCM&EFS/7", X = 1, Y = 2 });
            raw.Connections.Add(connection);
            raw.Connections.Add(new RawConnection { Id = "3/4", Is3d = true });

            raw.Texts.Add(new RawText
            {
                Page = "=VB030+LCM&EFS/7",
                Content = "#",
                X = 12.25,
                Y = 100,
                Box = { new RawPoint(11, 99), new RawPoint(13.5, 101) },
                Free = true,
            });
            raw.Lines.Add(new RawLine { Page = "=VB030+LCM&EFS/7", X2 = 6.5 });
            raw.Shields.Add(new RawShield { Page = "=VB030+LCM&EFS/7", X = 1, Y = 2, Variant = 0, Width = 12.5 });

            var cable = new RawCableDefinition
            {
                Page = "=VB030+LCM&EFS/7",
                Kind = RawCableDefinition.KindCable,
                Name = "-W1",
                X = 3,
                Y = 4,
                Definition = "Kabeldefinition",
                SourceProperty = "=A-K1",
                Type = "GSC-01",
                WireCountAndCrossSection = "4x0,22",
                Length = "5 m",
                PartNumbers = { "X" },
            };
            cable.Wires.Add("1/2");
            raw.CableDefinitions.Add(cable);
            return raw;
        }

        /// <summary>Entfernt Leerraum außerhalb von Strings (für lesbare erwartete JSON-Texte im Test).</summary>
        public static string Minify(string json)
        {
            var builder = new StringBuilder(json.Length);
            bool inString = false;
            bool escaped = false;
            foreach (char c in json)
            {
                if (inString)
                {
                    builder.Append(c);
                    if (escaped)
                    {
                        escaped = false;
                    }
                    else if (c == '\\')
                    {
                        escaped = true;
                    }
                    else if (c == '"')
                    {
                        inString = false;
                    }
                }
                else if (!char.IsWhiteSpace(c))
                {
                    builder.Append(c);
                    inString = c == '"';
                }
            }
            return builder.ToString();
        }
    }
}
