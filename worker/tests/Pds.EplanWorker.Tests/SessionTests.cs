using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker.Tests
{
    public class SessionTests
    {
        private readonly FakeReader _reader = new FakeReader();
        private readonly WorkerController _worker;

        public SessionTests()
        {
            _worker = new WorkerController(_reader, "9.9.9", NullLogger.Instance);
        }

        [Fact]
        public async Task Hello_IsSentOnConnect()
        {
            await using var client = new TestClient(_worker);

            var hello = await client.NextAsync();

            Assert.Equal("hello", hello.GetProperty("type").GetString());
            Assert.Equal(1, hello.GetProperty("protocol").GetInt32());
            Assert.Equal("9.9.9", hello.GetProperty("version").GetString());
        }

        [Fact]
        public async Task Status_BeforeAnything_ReportsNotStartedAndNotConfigured()
        {
            await using var client = new TestClient(_worker);

            var result = (await client.RequestAsync("r1", Methods.Status)).GetProperty("result");

            Assert.Equal("not_started", result.GetProperty("eplan").GetString());
            Assert.Equal(JsonValueKind.Null, result.GetProperty("eplanVersion").ValueKind);
            Assert.False(result.GetProperty("busy").GetBoolean());
            Assert.False(result.GetProperty("configured").GetBoolean());
        }

        [Fact]
        public async Task Analyze_BeforeConfigure_ReturnsNotConfigured()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);

            var response = await client.RequestAsync("r1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));

            AssertError(response, "r1", ErrorCodes.NotConfigured);
            Assert.Equal(0, _reader.Calls);
        }

        [Fact]
        public async Task Status_DuringAnalyze_IsAnsweredImmediatelyAndReportsBusy()
        {
            using var folder = new TempFolder();
            _reader.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            await client.SendAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));
            await _reader.Entered.Task.WaitAsync(TestClient.Timeout, TestContext.Current.CancellationToken);
            var status = (await client.RequestAsync("s1", Methods.Status)).GetProperty("result");

            Assert.True(status.GetProperty("busy").GetBoolean());
            Assert.Equal("ready", status.GetProperty("eplan").GetString());
            Assert.Equal("2025.0.3", status.GetProperty("eplanVersion").GetString());
            Assert.True(status.GetProperty("configured").GetBoolean());

            _reader.Gate.SetResult();
            var done = await client.ResponseAsync("a1");
            Assert.True(done.TryGetProperty("result", out _), done.ToString());
            var after = (await client.RequestAsync("s2", Methods.Status)).GetProperty("result");
            Assert.False(after.GetProperty("busy").GetBoolean());
        }

        [Fact]
        public async Task SecondAnalyze_WhileRunning_ReturnsBusy()
        {
            using var folder = new TempFolder();
            _reader.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();
            string archive = folder.Archive();

            await client.SendAsync("a1", Methods.Analyze, folder.AnalyzeParams(archive));
            await _reader.Entered.Task.WaitAsync(TestClient.Timeout, TestContext.Current.CancellationToken);
            var second = await client.RequestAsync("a2", Methods.Analyze, folder.AnalyzeParams(archive));

            AssertError(second, "a2", ErrorCodes.Busy);
            _reader.Gate.SetResult();
            Assert.True((await client.ResponseAsync("a1")).TryGetProperty("result", out _));
            Assert.Equal(1, _reader.Calls);
        }

        [Fact]
        public async Task Configure_AfterEplanStart_SamePathsOk_OtherPathsRestartRequired()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();
            Assert.True((await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()))).TryGetProperty("result", out _));

            // Gleiche Pfade, nur anders geschrieben (Groß-/Kleinschreibung, abschließender Trenner)
            var same = TestClient.Paths(@"c:\program files\eplan\electric p8\2025.0.3\bin\");
            Assert.True((await client.RequestAsync("c2", Methods.Configure, same)).TryGetProperty("result", out _));

            var other = await client.RequestAsync("c3", Methods.Configure, TestClient.Paths(@"C:\Program Files\EPLAN\Electric P8\2026.0.0\Bin"));
            AssertError(other, "c3", ErrorCodes.RestartRequired);
        }

        [Fact]
        public async Task Configure_BeforeEplanStart_CanChangePaths()
        {
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            var other = await client.RequestAsync("c2", Methods.Configure, TestClient.Paths(@"D:\EPLAN\Bin"));

            Assert.True(other.TryGetProperty("result", out _), other.ToString());
        }

        [Fact]
        public async Task Configure_WithoutProductBin_ReturnsInvalidRequest()
        {
            await using var client = new TestClient(_worker);

            var response = await client.RequestAsync("c1", Methods.Configure, new Dictionary<string, object> { ["platformBin"] = @"C:\x" });

            AssertError(response, "c1", ErrorCodes.InvalidRequest);
        }

        [Theory]
        [InlineData("{not json")]
        [InlineData("[1,2]")]
        [InlineData("{\"type\":\"request\",\"method\":\"status\"}")]
        [InlineData("{\"type\":\"request\",\"id\":7,\"method\":\"status\"}")]
        public async Task InvalidLine_ReturnsInvalidRequestWithNullId(string line)
        {
            await using var client = new TestClient(_worker);
            await client.NextAsync();

            await client.SendLineAsync(line);
            var response = await client.NextAsync();

            Assert.Equal("response", response.GetProperty("type").GetString());
            Assert.Equal(JsonValueKind.Null, response.GetProperty("id").ValueKind);
            Assert.Equal(ErrorCodes.InvalidRequest, response.GetProperty("error").GetProperty("code").GetString());
            Assert.False(string.IsNullOrEmpty(response.GetProperty("error").GetProperty("message").GetString()));
        }

        [Theory]
        [InlineData("{\"type\":\"notify\",\"id\":\"r1\",\"method\":\"status\"}")]
        [InlineData("{\"type\":\"request\",\"id\":\"r1\"}")]
        [InlineData("{\"type\":\"request\",\"id\":\"r1\",\"method\":\"status\",\"params\":[]}")]
        public async Task InvalidRequestWithId_ReturnsInvalidRequestWithThatId(string line)
        {
            await using var client = new TestClient(_worker);

            await client.SendLineAsync(line);
            var response = await client.ResponseAsync("r1");

            AssertError(response, "r1", ErrorCodes.InvalidRequest);
        }

        [Fact]
        public async Task UnknownMethod_ReturnsInvalidRequest()
        {
            await using var client = new TestClient(_worker);

            var response = await client.RequestAsync("r1", "reboot");

            AssertError(response, "r1", ErrorCodes.InvalidRequest);
            Assert.Contains("reboot", response.GetProperty("error").GetProperty("message").GetString());
        }

        [Fact]
        public async Task InvalidRequest_DoesNotEndSession()
        {
            await using var client = new TestClient(_worker);
            await client.SendLineAsync("kaputt");
            await client.SendLineAsync("");

            var status = await client.RequestAsync("r1", Methods.Status);

            Assert.True(status.TryGetProperty("result", out _));
        }

        [Fact]
        public async Task Analyze_Archive_ReportsProgressInOrderAndWritesRawJson()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();
            var parameters = folder.AnalyzeParams(folder.Archive());

            var response = await client.RequestAsync("a1", Methods.Analyze, parameters);

            var stages = client.Received
                .Where(m => m.GetProperty("type").GetString() == "progress")
                .Select(m =>
                {
                    Assert.Equal("a1", m.GetProperty("id").GetString());
                    return m.GetProperty("stage").GetString();
                })
                .ToArray();
            Assert.Equal(new[] { "starting_eplan", "restoring", "opening", "reading", "writing" }, stages);

            var result = response.GetProperty("result");
            Assert.Equal(folder.File("raw.json"), result.GetProperty("outputFile").GetString());
            Assert.Equal(2, result.GetProperty("pages").GetInt32());
            Assert.Equal(2, result.GetProperty("connections").GetInt32());

            using var raw = JsonDocument.Parse(File.ReadAllBytes(folder.File("raw.json")));
            Assert.Equal(1, raw.RootElement.GetProperty("format").GetInt32());
            Assert.Equal("9.9.9", raw.RootElement.GetProperty("worker").GetString());
            Assert.False(File.Exists(folder.File("raw.json.tmp")));

            // Wiederherstellungsordner: leer vorbereitet, danach gelöscht
            Assert.True(_reader.RestoreFolderWasEmpty);
            Assert.Equal(Path.Combine(folder.Path, "restore"), _reader.LastSource.RestoreFolder);
            Assert.False(Directory.Exists(Path.Combine(folder.Path, "restore")));
        }

        [Fact]
        public async Task Analyze_Archive_ClearsLeftoversOfAnEarlierRun()
        {
            using var folder = new TempFolder();
            Directory.CreateDirectory(Path.Combine(folder.Path, "restore", "alt.edb"));
            File.WriteAllText(Path.Combine(folder.Path, "restore", "alt.elk"), "");
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));

            Assert.True(_reader.RestoreFolderWasEmpty);
        }

        [Fact]
        public async Task Analyze_ElkProject_SkipsRestoreAndPassesOpenMode()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            var response = await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.ElkProject(), "exclusive"));

            Assert.True(response.TryGetProperty("result", out _), response.ToString());
            Assert.False(_reader.LastSource.IsArchive);
            Assert.Null(_reader.LastSource.RestoreFolder);
            Assert.Equal("Exclusive", _reader.LastSource.OpenMode);
            Assert.DoesNotContain(client.Received, m => m.TryGetProperty("stage", out var s) && s.GetString() == "restoring");
        }

        [Fact]
        public async Task Analyze_DefaultOpenModeIsReadOnly()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.ElkProject()));

            Assert.Equal("ReadOnly", _reader.LastSource.OpenMode);
        }

        [Fact]
        public async Task Analyze_InvalidOpenMode_ReturnsInvalidRequest()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            var response = await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive(), "Schreibgeschützt"));

            AssertError(response, "a1", ErrorCodes.InvalidRequest);
        }

        [Fact]
        public async Task Analyze_MissingProject_ReturnsProjectNotFoundWithoutStartingEplan()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            var response = await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.File("fehlt.zw1")));

            AssertError(response, "a1", ErrorCodes.ProjectNotFound);
            Assert.Equal(0, _reader.Calls);
            var status = (await client.RequestAsync("s1", Methods.Status)).GetProperty("result");
            Assert.Equal("not_started", status.GetProperty("eplan").GetString());
            Assert.False(status.GetProperty("busy").GetBoolean());
        }

        [Fact]
        public async Task Analyze_ReaderError_IsReturnedAsErrorCode()
        {
            using var folder = new TempFolder();
            _reader.Read = (_, _) => throw new WorkerException(ErrorCodes.OpenFailed, "Projekt gesperrt");
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            var response = await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));

            AssertError(response, "a1", ErrorCodes.OpenFailed);
            Assert.Equal("Projekt gesperrt", response.GetProperty("error").GetProperty("message").GetString());
            Assert.False(Directory.Exists(Path.Combine(folder.Path, "restore")));
            Assert.False(File.Exists(folder.File("raw.json")));
            // Danach ist der Worker wieder frei
            Assert.False((await client.RequestAsync("s1", Methods.Status)).GetProperty("result").GetProperty("busy").GetBoolean());
        }

        [Fact]
        public async Task Analyze_UnexpectedException_IsReturnedAsReadFailed()
        {
            using var folder = new TempFolder();
            _reader.Read = (_, _) => throw new InvalidOperationException("Hoppla");
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            var response = await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));

            AssertError(response, "a1", ErrorCodes.ReadFailed);
        }

        [Fact]
        public async Task Analyze_OutputNotWritable_ReturnsWriteFailed()
        {
            using var folder = new TempFolder();
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();
            var parameters = folder.AnalyzeParams(folder.Archive());
            // Ziel ist ein Ordner: Datei lässt sich dort nicht anlegen
            Directory.CreateDirectory(folder.File("raw.json"));

            var response = await client.RequestAsync("a1", Methods.Analyze, parameters);

            AssertError(response, "a1", ErrorCodes.WriteFailed);
        }

        [Fact]
        public async Task Analyze_ReadIssues_AreReportedOncePerCodeWithCountBeforeResponse()
        {
            using var folder = new TempFolder();
            _reader.Read = (_, reporter) =>
            {
                for (int i = 0; i < 3; i++)
                {
                    reporter.Issue(IssueCodes.TextUnreadable, new InvalidOperationException("Text " + i));
                }
                reporter.Issue(IssueCodes.LineUnreadable, new ArgumentException("Linie"));
                return Samples.Project();
            };
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            await client.RequestAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));

            var logs = client.Received.Where(m => m.GetProperty("type").GetString() == "log").ToList();
            Assert.Equal(new[] { IssueCodes.TextUnreadable, IssueCodes.LineUnreadable }, logs.Select(l => l.GetProperty("code").GetString()));
            Assert.All(logs, l =>
            {
                Assert.Equal("a1", l.GetProperty("id").GetString());
                Assert.Equal("warn", l.GetProperty("level").GetString());
            });
            string message = logs[0].GetProperty("message").GetString();
            Assert.Contains("3×", message);
            Assert.Contains("Text 0", message);
            Assert.Contains("1×", logs[1].GetProperty("message").GetString());
            Assert.Equal("response", client.Received.Last().GetProperty("type").GetString());
        }

        [Fact]
        public async Task Exit_RespondsThenCallsHookWithCode()
        {
            await using var client = new TestClient(_worker);

            var response = await client.RequestAsync("x1", Methods.Exit, new Dictionary<string, object> { ["code"] = 3 });
            await client.SessionTask.WaitAsync(TestClient.Timeout, TestContext.Current.CancellationToken);

            Assert.True(response.TryGetProperty("result", out _));
            Assert.Equal(new[] { 3 }, client.ExitCodes);
        }

        [Fact]
        public async Task Exit_WithoutCode_UsesZero()
        {
            await using var client = new TestClient(_worker);

            await client.RequestAsync("x1", Methods.Exit);
            await client.SessionTask.WaitAsync(TestClient.Timeout, TestContext.Current.CancellationToken);

            Assert.Equal(new[] { 0 }, client.ExitCodes);
        }

        [Fact]
        public async Task Exit_WithInvalidCode_ReturnsInvalidRequestAndKeepsRunning()
        {
            await using var client = new TestClient(_worker);

            var response = await client.RequestAsync("x1", Methods.Exit, new Dictionary<string, object> { ["code"] = "drei" });

            AssertError(response, "x1", ErrorCodes.InvalidRequest);
            Assert.Empty(client.ExitCodes);
        }

        [Fact]
        public async Task Exit_DuringAnalyze_IsAnsweredImmediately()
        {
            using var folder = new TempFolder();
            _reader.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using var client = new TestClient(_worker);
            await client.ConfigureAsync();

            await client.SendAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));
            await _reader.Entered.Task.WaitAsync(TestClient.Timeout, TestContext.Current.CancellationToken);
            await client.RequestAsync("x1", Methods.Exit, new Dictionary<string, object> { ["code"] = 3 });

            Assert.Equal(new[] { 3 }, client.ExitCodes);
            _reader.Gate.SetResult();
        }

        [Fact]
        public async Task Busy_SurvivesReconnect_UntilAnalysisEnds()
        {
            using var folder = new TempFolder();
            _reader.Gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            string archive = folder.Archive();

            await using (var first = new TestClient(_worker))
            {
                await first.ConfigureAsync();
                await first.SendAsync("a1", Methods.Analyze, folder.AnalyzeParams(archive));
                await _reader.Entered.Task.WaitAsync(TestClient.Timeout, TestContext.Current.CancellationToken);
                await first.CloseInputAsync();
            }

            await using var second = new TestClient(_worker);
            Assert.True((await second.RequestAsync("s1", Methods.Status)).GetProperty("result").GetProperty("busy").GetBoolean());
            AssertError(await second.RequestAsync("a2", Methods.Analyze, folder.AnalyzeParams(archive)), "a2", ErrorCodes.Busy);

            _reader.Gate.SetResult();
            await WaitUntilAsync(() => !_worker.IsBusy);
            // Die Konfiguration gilt für den Prozess, nicht für die Verbindung
            var status = (await second.RequestAsync("s2", Methods.Status)).GetProperty("result");
            Assert.True(status.GetProperty("configured").GetBoolean());
            Assert.False(status.GetProperty("busy").GetBoolean());
            Assert.True(File.Exists(folder.File("raw.json")));
        }

        [Fact]
        public async Task Messages_AreSingleUtf8LinesWithoutBom()
        {
            using var folder = new TempFolder();
            _reader.Read = (_, reporter) =>
            {
                reporter.Issue(IssueCodes.TextUnreadable, new InvalidOperationException("Zeile 1\nZeile 2 \"Ä\" ²"));
                return Samples.Project();
            };
            await using var client = new TestClient(_worker);
            await client.SendAsync("c1", Methods.Configure, TestClient.Paths());
            await client.SendAsync("a1", Methods.Analyze, folder.AnalyzeParams(folder.Archive()));
            await client.SendAsync("s1", Methods.Status);
            await client.SendAsync("r1", "nix");
            await client.SendLineAsync("{kaputt");
            // hello, configure, progress ×5, log, analyze, status, unbekannt, kaputt
            for (int i = 0; i < 12; i++)
            {
                await client.NextAsync();
            }
            await client.CloseInputAsync();

            byte[] bytes = client.WrittenBytes;

            Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF, "BOM am Anfang");
            Assert.Equal((byte)'\n', bytes[^1]);
            Assert.DoesNotContain((byte)'\r', bytes);
            string text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes);
            string[] lines = text.Substring(0, text.Length - 1).Split('\n');
            Assert.Equal(12, lines.Length);
            foreach (var line in lines)
            {
                using var document = JsonDocument.Parse(line);
                Assert.Equal(JsonValueKind.Object, document.RootElement.ValueKind);
                Assert.True(document.RootElement.TryGetProperty("type", out _));
            }
            // Umlaute und ² lesbar, Zeilenumbruch maskiert
            Assert.Contains("Zeile 1\\nZeile 2 \\\"Ä\\\" ²", text);
        }

        [Fact]
        public async Task ClientBom_IsIgnored()
        {
            await using var client = new TestClient(_worker);

            await client.SendLineAsync("\uFEFF{\"type\":\"request\",\"id\":\"r1\",\"method\":\"status\"}");
            var response = await client.ResponseAsync("r1");

            Assert.True(response.TryGetProperty("result", out _), response.ToString());
        }

        private static void AssertError(JsonElement response, string id, string code)
        {
            Assert.Equal("response", response.GetProperty("type").GetString());
            Assert.Equal(id, response.GetProperty("id").GetString());
            Assert.True(response.TryGetProperty("error", out var error), "Fehler erwartet: " + response);
            Assert.Equal(code, error.GetProperty("code").GetString());
            Assert.Equal(JsonValueKind.String, error.GetProperty("message").ValueKind);
            Assert.False(response.TryGetProperty("result", out _));
        }

        private static async Task WaitUntilAsync(Func<bool> condition)
        {
            var deadline = DateTime.UtcNow + TestClient.Timeout;
            while (!condition())
            {
                if (DateTime.UtcNow > deadline)
                {
                    throw new TimeoutException("Bedingung nicht erfüllt");
                }
                await Task.Delay(10, TestContext.Current.CancellationToken);
            }
        }
    }
}
