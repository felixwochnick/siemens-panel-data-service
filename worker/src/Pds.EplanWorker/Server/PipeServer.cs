using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Pds.EplanWorker.Server
{
    /// <summary>
    /// Lauscht auf <c>\\.\pipe\&lt;name&gt;</c>. Immer nur ein Client (eine Pipe-Instanz); trennt er die Verbindung,
    /// wird eine neue Instanz angelegt und auf den nächsten gewartet. Zwischen zwei Verbindungen gibt es kurz keine
    /// Instanz – der Client muss einen Verbindungsversuch wiederholen.
    /// </summary>
    internal sealed class PipeServer
    {
        private const int BufferSize = 64 * 1024;
        private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(5);

        private readonly string _pipeName;
        private readonly WorkerController _worker;
        private readonly Action<int> _exit;
        private readonly ILogger _logger;

        public PipeServer(string pipeName, WorkerController worker, Action<int> exit, ILogger logger)
        {
            _pipeName = pipeName;
            _worker = worker;
            _exit = exit;
            _logger = logger;
        }

        public async Task RunAsync(CancellationToken cancellationToken)
        {
            PipeSecurity security = PipeAcl.Create();
            _logger.LogInformation("Warte auf Verbindungen an \\\\.\\pipe\\{Pipe}", _pipeName);

            while (!cancellationToken.IsCancellationRequested)
            {
                NamedPipeServerStream pipe;
                try
                {
                    pipe = new NamedPipeServerStream(_pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous, BufferSize, BufferSize, security);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    // z. B. ein anderer Prozess hat die Pipe schon (zweiter Worker, Pipe noch nicht freigegeben)
                    _logger.LogError("Pipe \\\\.\\pipe\\{Pipe} nicht anlegbar: {Error}", _pipeName, ex.Message);
                    if (!await DelayAsync(cancellationToken).ConfigureAwait(false))
                    {
                        break;
                    }
                    continue;
                }

                using (pipe)
                // WaitForConnectionAsync und das Lesen lassen sich unter .NET Framework nicht abbrechen; Schließen hilft
                using (cancellationToken.Register(() => pipe.Dispose()))
                {
                    try
                    {
                        await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is OperationCanceledException || ex is ObjectDisposedException)
                    {
                        break;
                    }
                    catch (IOException ex)
                    {
                        _logger.LogWarning("Verbindungsaufbau fehlgeschlagen: {Error}", ex.Message);
                        continue;
                    }

                    _logger.LogInformation("Client verbunden");
                    try
                    {
                        await new Session(pipe, pipe, _worker, _exit, _logger).RunAsync(cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Sitzung mit Fehler beendet");
                    }
                    _logger.LogInformation("Client getrennt");
                }
            }
        }

        private static async Task<bool> DelayAsync(CancellationToken cancellationToken)
        {
            try
            {
                await Task.Delay(RetryDelay, cancellationToken).ConfigureAwait(false);
                return true;
            }
            catch (OperationCanceledException)
            {
                return false;
            }
        }
    }
}
