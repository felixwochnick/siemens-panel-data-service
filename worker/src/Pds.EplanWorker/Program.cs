using System;
using System.Text;
using Spectre.Console.Cli;

namespace EplanElectricP8Api
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            // Umlaute und Rahmenzeichen korrekt ausgeben (als Dienst gibt es keine Konsole)
            if (Environment.UserInteractive)
            {
                Console.OutputEncoding = Encoding.UTF8;
            }

            var app = new CommandApp<RunCommand>();
            app.Configure(config =>
            {
                config.SetApplicationName("EplanElectricP8Api");

                config.AddCommand<RunCommand>("run")
                    .WithDescription("Dienst starten: Projekte nach Cron-Zeitplan exportieren (Standard)")
                    .WithExample("run", "--now");

                config.AddCommand<ExportCommand>("export")
                    .WithDescription("Ein einzelnes Projekt sofort exportieren")
                    .WithExample("export", "C:\\Projekte\\Anlage.elk", "-o", "C:\\Export");

                config.AddCommand<ConfigureCommand>("configure")
                    .WithDescription("Interaktiver Assistent zum Erstellen/Bearbeiten der config.yaml");

                config.AddBranch("service", service =>
                {
                    service.SetDescription("Windows-Dienst verwalten");
                    service.AddCommand<ServiceInstallCommand>("install")
                        .WithDescription("Als Windows-Dienst installieren und starten (Administratorrechte nötig)");
                    service.AddCommand<ServiceUninstallCommand>("uninstall")
                        .WithDescription("Windows-Dienst stoppen und entfernen (Administratorrechte nötig)");
                });
            });

            return app.Run(args);
        }
    }
}
