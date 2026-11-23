using System;
using System.IO;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker.Tests
{
    public class ProjectFilesTests
    {
        [Fact]
        public void Resolve_Archive_UsesRestoreFolderInWorkFolder()
        {
            using var folder = new TempFolder();
            string archive = folder.Archive("Anlage.ZW1");

            var source = ProjectFiles.Resolve(new AnalyzeRequest(archive, folder.Path, folder.File("raw.json"), "ReadOnly"));

            Assert.True(source.IsArchive);
            Assert.Equal(archive, source.ProjectPath);
            Assert.Equal(Path.Combine(folder.Path, "restore"), source.RestoreFolder);
        }

        [Fact]
        public void Resolve_ElkWithoutEdb_IsProjectNotFound()
        {
            using var folder = new TempFolder();
            string elk = folder.File("Anlage.elk");
            File.WriteAllText(elk, "");

            var error = Assert.Throws<WorkerException>(() => ProjectFiles.Resolve(new AnalyzeRequest(elk, folder.Path, "raw.json", "ReadOnly")));

            Assert.Equal(ErrorCodes.ProjectNotFound, error.Code);
            Assert.Contains("Anlage.edb", error.Message);
        }

        [Fact]
        public void Resolve_OtherExtension_IsInvalidRequest()
        {
            using var folder = new TempFolder();
            string file = folder.File("Anlage.zip");
            File.WriteAllText(file, "");

            var error = Assert.Throws<WorkerException>(() => ProjectFiles.Resolve(new AnalyzeRequest(file, folder.Path, "raw.json", "ReadOnly")));

            Assert.Equal(ErrorCodes.InvalidRequest, error.Code);
        }

        [Fact]
        public void FindRestoredProject_WithoutElk_IsArchiveWithoutProject()
        {
            using var folder = new TempFolder();
            File.WriteAllText(folder.File("liesmich.txt"), "");

            var error = Assert.Throws<WorkerException>(() => ProjectFiles.FindRestoredProject(folder.Path));

            Assert.Equal(ErrorCodes.ArchiveWithoutProject, error.Code);
        }

        [Fact]
        public void FindRestoredProject_ReturnsElk()
        {
            using var folder = new TempFolder();
            string elk = folder.ElkProject("Anlage");

            Assert.Equal(elk, ProjectFiles.FindRestoredProject(folder.Path));
        }

        [Fact]
        public void PrepareRestoreFolder_EmptiesExistingFolder()
        {
            using var folder = new TempFolder();
            string restore = folder.File("restore");
            Directory.CreateDirectory(Path.Combine(restore, "alt.edb"));

            ProjectFiles.PrepareRestoreFolder(restore);

            Assert.True(Directory.Exists(restore));
            Assert.Empty(Directory.GetFileSystemEntries(restore));
            Assert.True(ProjectFiles.TryDeleteFolder(restore, out _));
            Assert.False(Directory.Exists(restore));
        }
    }

    public class CommandLineOptionsTests
    {
        private const string DefaultLogs = @"C:\ProgramData\EPLAN Panel Data Service\logs";

        [Theory]
        [InlineData("service", WorkerMode.Service)]
        [InlineData("run", WorkerMode.Run)]
        [InlineData("stdio", WorkerMode.Stdio)]
        public void Parse_Modes_WithDefaults(string mode, WorkerMode expected)
        {
            var options = CommandLineOptions.Parse(new[] { mode }, DefaultLogs);

            Assert.Equal(expected, options.Mode);
            Assert.Equal("pds-eplan", options.PipeName);
            Assert.Equal(DefaultLogs, options.LogDirectory);
            Assert.False(options.AllowDialogs);
        }

        [Fact]
        public void Parse_Options()
        {
            var options = CommandLineOptions.Parse(new[] { "run", "--pipe", @"\\.\pipe\pds-eplan-dev", "--log-dir=D:\\Logs", "--dialogs" }, DefaultLogs);

            Assert.Equal(WorkerMode.Run, options.Mode);
            Assert.Equal("pds-eplan-dev", options.PipeName);
            Assert.Equal(@"D:\Logs", options.LogDirectory);
            Assert.True(options.AllowDialogs);
        }

        [Theory]
        [InlineData("")]
        [InlineData("export")]
        [InlineData("run stdio")]
        [InlineData("run --now")]
        [InlineData("run --pipe")]
        [InlineData("run --pipe a\\b")]
        [InlineData("service --dialogs")]
        [InlineData("stdio --pipe x")]
        [InlineData("run --log-dir --dialogs")]
        public void Parse_Invalid_Throws(string commandLine)
        {
            string[] args = commandLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);

            Assert.Throws<ArgumentException>(() => CommandLineOptions.Parse(args, DefaultLogs));
        }

        [Fact]
        public void Parse_Help_NeedsNoMode()
        {
            Assert.True(CommandLineOptions.Parse(new[] { "--help" }, DefaultLogs).ShowHelp);
            Assert.True(CommandLineOptions.Parse(new[] { "--version" }, DefaultLogs).ShowVersion);
        }
    }

    public class ServiceSidTests
    {
        [Fact]
        public void For_MatchesWindows()
        {
            // Bekannte SID von NT SERVICE\TrustedInstaller
            Assert.Equal("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", ServiceSid.For("TrustedInstaller"));
        }

        [Fact]
        public void For_IgnoresCase()
        {
            Assert.Equal(ServiceSid.For("pds"), ServiceSid.For("PDS"));
            Assert.Matches(@"^S-1-5-80(-\d+){5}$", ServiceSid.For("pds"));
        }
    }

    public class EplanPathsTests
    {
        [Fact]
        public void Matches_IgnoresCaseAndTrailingSeparator()
        {
            var a = new EplanPaths(@"C:\EPLAN\Platform\Bin", @"C:\EPLAN\P8\Bin", "");
            var b = new EplanPaths(@"c:\eplan\platform\bin\", @"C:\EPLAN\P8\BIN", null);

            Assert.True(a.Matches(b));
            Assert.False(a.Matches(new EplanPaths(@"C:\EPLAN\Platform\Bin", @"C:\EPLAN\P8\Bin", "Electric P8")));
            Assert.False(a.Matches(new EplanPaths(@"C:\EPLAN\Platform\Bin", @"D:\EPLAN\P8\Bin", "")));
            Assert.False(a.Matches(null));
        }
    }

    public class LocalizationTests
    {
        [Theory]
        [InlineData(" Deutsch ", "neutral", "English", "Deutsch")]
        [InlineData("", " neutral", "English", "neutral")]
        [InlineData("  ", null, "English ", "English")]
        [InlineData(null, null, null, "")]
        public void Choose_GermanThenNeutralThenEnglish(string german, string neutral, string english, string expected)
        {
            Assert.Equal(expected, Localization.Choose(() => german, () => neutral, () => english));
        }

        [Fact]
        public void Choose_ReadsOnlyWhatItNeeds()
        {
            Assert.Equal("de", Localization.Choose(() => "de", () => throw new InvalidOperationException(), () => throw new InvalidOperationException()));
        }
    }

    public class IssueCollectorTests
    {
        [Fact]
        public void Drain_GroupsByCodeInOrderOfFirstOccurrence()
        {
            var issues = new IssueCollector();
            issues.Add(IssueCodes.LineUnreadable, new InvalidOperationException("erste"));
            issues.Add(IssueCodes.TextUnreadable, null);
            issues.Add(IssueCodes.LineUnreadable, new InvalidOperationException("zweite"));

            var summaries = issues.Drain();

            Assert.Collection(summaries,
                line =>
                {
                    Assert.Equal(IssueCodes.LineUnreadable, line.Code);
                    Assert.Equal(2, line.Count);
                    Assert.Equal("Linie nicht lesbar: 2× (erste Ausnahme: InvalidOperationException: erste)", line.Message);
                },
                text =>
                {
                    Assert.Equal(1, text.Count);
                    Assert.Equal("Text nicht vollständig lesbar: 1×", text.Message);
                });
            Assert.Empty(issues.Drain());
        }
    }

    public class MessagesTests
    {
        [Fact]
        public void Log_WithoutId_OmitsId()
        {
            string line = System.Text.Encoding.UTF8.GetString(MessageWriter.Serialize(Messages.Log(null, LogLevels.Info, "x", "y")));

            Assert.Equal("{\"type\":\"log\",\"level\":\"info\",\"code\":\"x\",\"message\":\"y\"}\n", line);
        }

        [Fact]
        public void Error_WithoutId_WritesNullId()
        {
            string line = System.Text.Encoding.UTF8.GetString(MessageWriter.Serialize(Messages.Error(null, ErrorCodes.InvalidRequest, "kaputt")));

            Assert.Equal("{\"type\":\"response\",\"id\":null,\"error\":{\"code\":\"invalid_request\",\"message\":\"kaputt\"}}\n", line);
        }

        [Fact]
        public void Hello_MatchesSpec()
        {
            string line = System.Text.Encoding.UTF8.GetString(MessageWriter.Serialize(Messages.Hello("1.2.3")));

            Assert.Equal("{\"type\":\"hello\",\"protocol\":1,\"version\":\"1.2.3\"}\n", line);
        }
    }
}
