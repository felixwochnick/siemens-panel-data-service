using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Quartz;

namespace EplanElectricP8Api
{
    /// <summary>
    /// Quartz Job: durchsucht den Projektordner und exportiert alle neuen, geänderten oder zuletzt fehlgeschlagenen Projekte.
    /// </summary>
    [DisallowConcurrentExecution]
    internal sealed class ExportJob : IJob
    {
        private readonly ExportConfig _config;
        private readonly EplanWorker _worker;
        private readonly ExportDatabase _database;
        private readonly ProjectExporter _exporter;
        private readonly ILogger<ExportJob> _logger;

        public ExportJob(ExportConfig config, EplanWorker worker, ExportDatabase database, ProjectExporter exporter, ILogger<ExportJob> logger)
        {
            _config = config;
            _worker = worker;
            _database = database;
            _exporter = exporter;
            _logger = logger;
        }

        public Task Execute(IJobExecutionContext context)
        {
            return RunAsync(context?.CancellationToken ?? CancellationToken.None);
        }

        public async Task RunAsync(CancellationToken cancellationToken)
        {
            _logger.LogInformation("─── Export-Lauf gestartet ───");

            if (!Directory.Exists(_config.ProjectFolder))
            {
                _logger.LogWarning("Projektordner nicht gefunden: {Folder}", _config.ProjectFolder);
                return;
            }

            var option = _config.Recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
            var patterns = _config.FilePatterns ?? ExportConfig.DefaultFilePatterns();
            var projects = patterns
                .SelectMany(pattern => Directory.GetFiles(_config.ProjectFolder, pattern, option))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            _logger.LogInformation("{Count} Projekt(e) in {Folder} gefunden", projects.Length, _config.ProjectFolder);

            int exported = 0, skipped = 0, failed = 0;
            foreach (var projectPath in projects)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    _logger.LogWarning("Export-Lauf abgebrochen.");
                    break;
                }

                if (!ProjectFiles.HasProjectData(projectPath))
                {
                    _logger.LogWarning("Übersprungen, Projektordner fehlt: {Folder}", ProjectFiles.DataFolder(projectPath));
                    skipped++;
                    continue;
                }

                var record = _database.Get(projectPath);
                if (record != null && record.Success && GetLastModifiedUtc(projectPath) <= record.ProjectModified)
                {
                    skipped++;
                    continue;
                }

                ExportResult result;
                try
                {
                    result = await _worker.InvokeAsync(() => _exporter.Export(projectPath, _config.OutputFolder));
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Export von {Project} fehlgeschlagen", projectPath);
                    result = new ExportResult();
                    result.Errors.Add(ex.Message);
                }

                // Änderungszeit erst nach dem Export messen: EPLAN schreibt beim Öffnen selbst in den Projektordner
                _database.Save(new ExportRecord
                {
                    ProjectPath = projectPath,
                    ProjectModified = GetLastModifiedUtc(projectPath),
                    ExportedAt = DateTime.UtcNow,
                    Success = result.Success,
                    Error = result.Success ? null : string.Join("; ", result.Errors),
                });

                if (result.Success)
                {
                    exported++;
                }
                else
                {
                    failed++;
                }
            }

            _logger.LogInformation("─── Export-Lauf beendet: {Exported} exportiert, {Skipped} übersprungen, {Failed} fehlgeschlagen ───",
                exported, skipped, failed);
        }

        /// <summary>Letzte Änderung eines Projekts: neueste Datei aus .elk Datei und .edb Ordner.</summary>
        private static DateTime GetLastModifiedUtc(string projectPath)
        {
            var modified = File.GetLastWriteTimeUtc(projectPath);

            string edbFolder = ProjectFiles.DataFolder(projectPath);
            if (Directory.Exists(edbFolder))
            {
                var latest = new DirectoryInfo(edbFolder)
                    .EnumerateFiles("*", SearchOption.AllDirectories)
                    .Select(f => f.LastWriteTimeUtc)
                    .DefaultIfEmpty(modified)
                    .Max();
                if (latest > modified)
                {
                    modified = latest;
                }
            }

            return modified;
        }
    }
}
