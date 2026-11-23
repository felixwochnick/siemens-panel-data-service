using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker
{
    /// <summary>
    /// Eine Verbindung mit einem Client über zwei Streams (Pipe oder stdin/stdout): sendet <c>hello</c>, liest
    /// Anfragen zeilenweise und beantwortet sie. <c>analyze</c> läuft im Hintergrund, damit <c>status</c> und
    /// <c>exit</c> auch währenddessen sofort beantwortet werden. Die Streams gehören dem Aufrufer.
    /// </summary>
    public sealed class Session
    {
        private readonly Stream _input;
        private readonly WorkerController _worker;
        private readonly Action<int> _exit;
        private readonly ILogger _logger;
        private readonly MessageWriter _writer;

        /// <param name="exit">
        /// Beendet den Prozess mit dem Code aus <c>exit</c>; wird aufgerufen, nachdem die Antwort geschrieben ist.
        /// </param>
        public Session(Stream input, Stream output, WorkerController worker, Action<int> exit, ILogger logger)
        {
            _input = input ?? throw new ArgumentNullException(nameof(input));
            _worker = worker ?? throw new ArgumentNullException(nameof(worker));
            _exit = exit ?? throw new ArgumentNullException(nameof(exit));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _writer = new MessageWriter(output ?? throw new ArgumentNullException(nameof(output)), logger);
        }

        /// <summary>
        /// Läuft, bis der Client die Verbindung schließt, <c>exit</c> schickt oder <paramref name="cancellationToken"/>
        /// ausgelöst wird (dann muss der Aufrufer den Eingabestream schließen, damit das Lesen endet). Eine laufende
        /// Analyse läuft danach weiter; ihre Antwort geht verloren, der Worker bleibt bis zu ihrem Ende <c>busy</c>.
        /// </summary>
        public async Task RunAsync(CancellationToken cancellationToken = default(CancellationToken))
        {
            await _writer.WriteAsync(Messages.Hello(_worker.Version)).ConfigureAwait(false);

            // Ein BOM des Clients am Anfang wird übersprungen; sonst UTF-8
            using (var reader = new StreamReader(_input, JsonText.Utf8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096, leaveOpen: true))
            {
                while (!cancellationToken.IsCancellationRequested && !_writer.IsBroken)
                {
                    string line;
                    try
                    {
                        line = await reader.ReadLineAsync().ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is IOException || ex is ObjectDisposedException || ex is OperationCanceledException)
                    {
                        _logger.LogDebug("Lesen beendet: {Error}", ex.Message);
                        break;
                    }

                    if (line == null)
                    {
                        break;
                    }
                    if (line.Trim().Length == 0)
                    {
                        continue;
                    }
                    if (!await HandleLineAsync(line).ConfigureAwait(false))
                    {
                        break;
                    }
                }
            }

            await _writer.FlushAsync().ConfigureAwait(false);
        }

        /// <summary>Bearbeitet eine Zeile; <c>false</c> beendet die Sitzung (nach <c>exit</c>).</summary>
        private async Task<bool> HandleLineAsync(string line)
        {
            Request request;
            try
            {
                request = Request.Parse(line);
            }
            catch (RequestException ex)
            {
                _logger.LogWarning("Ungültige Anfrage: {Error}", ex.Message);
                await _writer.WriteAsync(Messages.Error(ex.RequestId, ErrorCodes.InvalidRequest, ex.Message)).ConfigureAwait(false);
                return true;
            }

            try
            {
                switch (request.Method)
                {
                    case Methods.Status:
                        await _writer.WriteAsync(Messages.Result(request.Id, _worker.WriteStatus)).ConfigureAwait(false);
                        return true;

                    case Methods.Configure:
                        _worker.Configure(EplanPaths.FromParams(request.Params));
                        await _writer.WriteAsync(Messages.Result(request.Id, null)).ConfigureAwait(false);
                        return true;

                    case Methods.Analyze:
                        StartAnalysis(request);
                        return true;

                    case Methods.Exit:
                        int code = ParamReader.OptionalInt(request.Params, "code", 0);
                        await _writer.WriteAsync(Messages.Result(request.Id, null)).ConfigureAwait(false);
                        await _writer.FlushAsync().ConfigureAwait(false);
                        _logger.LogWarning("Client verlangt Beenden mit Code {Code}", code);
                        _exit(code);
                        return false;

                    default:
                        throw ParamReader.Invalid("Unbekannte Methode: " + request.Method);
                }
            }
            catch (WorkerException ex)
            {
                _logger.LogWarning("{Method} ({Id}): {Code} {Error}", request.Method, request.Id, ex.Code, ex.Message);
                await _writer.WriteAsync(Messages.Error(request.Id, ex.Code, ex.Message)).ConfigureAwait(false);
                return true;
            }
        }

        /// <summary>Prüft die Anfrage sofort (Fehler gleich als Antwort) und startet die Analyse im Hintergrund.</summary>
        private void StartAnalysis(Request request)
        {
            AnalyzeRequest analyze = AnalyzeRequest.FromParams(request.Params);
            WorkerController.AnalysisLease lease = _worker.BeginAnalysis();
            _logger.LogInformation("Analyse {Id}: {Project}", request.Id, analyze.ProjectPath);
            Task.Run(() => RunAnalysisAsync(request.Id, analyze, lease));
        }

        private async Task RunAnalysisAsync(string id, AnalyzeRequest request, WorkerController.AnalysisLease lease)
        {
            var reporter = new SessionReporter(_writer, id, _logger);
            Action<System.Text.Json.Utf8JsonWriter> response;
            try
            {
                AnalyzeResult result = await _worker.AnalyzeAsync(lease, request, reporter).ConfigureAwait(false);
                _logger.LogInformation("Analyse {Id} fertig: {Pages} Seiten, {Connections} Verbindungen -> {File}",
                    id, result.Pages, result.Connections, result.OutputFile);
                response = Messages.Result(id, result.Write);
            }
            catch (WorkerException ex)
            {
                _logger.LogError("Analyse {Id} fehlgeschlagen: {Code} {Error}", id, ex.Code, ex.Message);
                response = Messages.Error(id, ex.Code, ex.Message);
            }
            catch (Exception ex)
            {
                // Unerwartet (z. B. Fehler im Lesecode): als Lesefehler melden, Details im Log
                _logger.LogError(ex, "Analyse {Id} fehlgeschlagen", id);
                response = Messages.Error(id, ErrorCodes.ReadFailed, ex.Message);
            }

            // Reihenfolge: gesammelte Lesefehler, dann freigeben, dann Antwort – wer die Antwort hat, darf sofort die
            // nächste Analyse schicken, ohne busy zu bekommen
            try
            {
                reporter.FlushIssues();
            }
            finally
            {
                lease.Dispose();
            }
            await _writer.WriteAsync(response).ConfigureAwait(false);
        }

        /// <summary>Leitet Fortschritt und Logs einer Analyse an den Client weiter; Lesefehler je Code gesammelt.</summary>
        private sealed class SessionReporter : IAnalysisReporter
        {
            private readonly MessageWriter _writer;
            private readonly string _id;
            private readonly ILogger _logger;
            private readonly IssueCollector _issues = new IssueCollector();

            public SessionReporter(MessageWriter writer, string id, ILogger logger)
            {
                _writer = writer;
                _id = id;
                _logger = logger;
            }

            public void Progress(string stage)
            {
                _logger.LogInformation("Analyse {Id}: {Stage}", _id, stage);
                _writer.WriteAsync(Messages.Progress(_id, stage));
            }

            public void Log(string level, string code, string message)
            {
                _logger.Log(level == LogLevels.Error ? LogLevel.Error : level == LogLevels.Warn ? LogLevel.Warning : LogLevel.Information,
                    "Analyse {Id}: {Code} {Message}", _id, code, message);
                _writer.WriteAsync(Messages.Log(_id, level, code, message));
            }

            public void Issue(string code, Exception exception)
            {
                _issues.Add(code, exception);
            }

            public void FlushIssues()
            {
                foreach (var issue in _issues.Drain())
                {
                    Log(LogLevels.Warn, issue.Code, issue.Message);
                }
            }
        }
    }
}
