using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Threading;
using Spectre.Console;
using Spectre.Console.Cli;

namespace EplanElectricP8Api
{
    internal sealed class ServiceInstallCommand : Command<ServiceInstallCommand.Settings>
    {
        public sealed class Settings : CommandSettings
        {
            [CommandOption("-c|--config <PATH>")]
            [Description("config.yaml, die der Dienst verwendet (Standard: neben der exe)")]
            public string ConfigFile { get; set; }

            [CommandOption("-l|--logging <PATH>")]
            [Description("Log-Verzeichnis des Dienstes")]
            public string LoggingDirectory { get; set; }

            [CommandOption("-u|--user <ACCOUNT>")]
            [Description("Dienstkonto, z.B. DOMAIN\\user (muss EPLAN lizenziert nutzen dürfen). Ohne Angabe: LocalSystem")]
            public string User { get; set; }
        }

        public override int Execute(CommandContext context, Settings settings)
        {
            if (!ServiceHelper.IsAdmin())
            {
                AnsiConsole.MarkupLine("[red bold]Administratorrechte erforderlich.[/] Terminal als Administrator starten und erneut ausführen.");
                return 1;
            }

            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            string configPath = Path.GetFullPath(settings.ConfigFile ?? ConfigLoader.DefaultConfigPath);
            string logDir = Path.GetFullPath(settings.LoggingDirectory ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs"));

            if (!File.Exists(configPath))
            {
                AnsiConsole.MarkupLine("[red bold]Fehler:[/] Konfigurationsdatei nicht gefunden: [yellow]{0}[/]", Markup.Escape(configPath));
                return 1;
            }

            string password = null;
            if (!string.IsNullOrEmpty(settings.User))
            {
                password = AnsiConsole.Prompt(new TextPrompt<string>("Passwort für [cyan]" + Markup.Escape(settings.User) + "[/]:").Secret());
            }
            else
            {
                AnsiConsole.MarkupLine("[yellow]Hinweis:[/] Ohne --user läuft der Dienst als LocalSystem. EPLAN benötigt dort ggf. eine eigene Lizenz und Einstellungen.");
            }

            var grid = new Grid().AddColumn(new GridColumn().NoWrap()).AddColumn();
            grid.AddRow("[bold]Dienst[/]", RunCommand.ServiceName);
            grid.AddRow("[bold]Programm[/]", Markup.Escape(exePath));
            grid.AddRow("[bold]Config[/]", Markup.Escape(configPath));
            grid.AddRow("[bold]Logs[/]", Markup.Escape(logDir));
            grid.AddRow("[bold]Konto[/]", Markup.Escape(settings.User ?? "LocalSystem"));
            AnsiConsole.Write(grid);

            string binPath = "\\\"" + exePath + "\\\" run --config \\\"" + configPath + "\\\" --logging \\\"" + logDir + "\\\"";
            string account = string.IsNullOrEmpty(settings.User)
                ? ""
                : " obj= \"" + settings.User + "\" password= \"" + password + "\"";

            // Vorhandenen Dienst ersetzen
            ServiceHelper.RunSc("stop " + RunCommand.ServiceName, ignoreErrors: true);
            Thread.Sleep(2000);
            ServiceHelper.RunSc("delete " + RunCommand.ServiceName, ignoreErrors: true);
            Thread.Sleep(1000);

            if (!ServiceHelper.RunSc("create " + RunCommand.ServiceName + " binPath= \"" + binPath + "\" start= auto"
                    + " DisplayName= \"EPLAN Electric P8 Export\"" + account, logArguments: false))
            {
                return 1;
            }
            ServiceHelper.RunSc("description " + RunCommand.ServiceName + " \"Exportiert EPLAN Projekte nach Zeitplan\"");

            if (!ServiceHelper.RunSc("start " + RunCommand.ServiceName))
            {
                AnsiConsole.MarkupLine("[yellow]Dienst installiert, konnte aber nicht gestartet werden. Siehe Log in {0}[/]", Markup.Escape(logDir));
                return 1;
            }

            AnsiConsole.MarkupLine("[green bold]Dienst {0} installiert und gestartet.[/]", RunCommand.ServiceName);
            return 0;
        }
    }

    internal sealed class ServiceUninstallCommand : Command<CommandSettings>
    {
        public override int Execute(CommandContext context, CommandSettings settings)
        {
            if (!ServiceHelper.IsAdmin())
            {
                AnsiConsole.MarkupLine("[red bold]Administratorrechte erforderlich.[/] Terminal als Administrator starten und erneut ausführen.");
                return 1;
            }

            if (!AnsiConsole.Confirm("Dienst [bold]" + RunCommand.ServiceName + "[/] stoppen und entfernen?"))
            {
                AnsiConsole.MarkupLine("[yellow]Abgebrochen.[/]");
                return 0;
            }

            ServiceHelper.RunSc("stop " + RunCommand.ServiceName, ignoreErrors: true);
            Thread.Sleep(2000);
            if (!ServiceHelper.RunSc("delete " + RunCommand.ServiceName))
            {
                return 1;
            }

            AnsiConsole.MarkupLine("[green bold]Dienst {0} entfernt.[/]", RunCommand.ServiceName);
            return 0;
        }
    }

    internal static class ServiceHelper
    {
        public static bool IsAdmin()
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        /// <param name="logArguments">false, wenn die Argumente ein Passwort enthalten können.</param>
        public static bool RunSc(string arguments, bool ignoreErrors = false, bool logArguments = true)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "sc.exe",
                Arguments = arguments,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            using (var process = Process.Start(psi))
            {
                string output = process.StandardOutput.ReadToEnd();
                process.WaitForExit();

                if (process.ExitCode != 0 && !ignoreErrors)
                {
                    string command = logArguments ? arguments : arguments.Split(' ')[0];
                    AnsiConsole.MarkupLine("[red]sc.exe {0} fehlgeschlagen ({1}):[/] {2}",
                        Markup.Escape(command), process.ExitCode, Markup.Escape(output.Trim()));
                }
                return process.ExitCode == 0;
            }
        }
    }
}
