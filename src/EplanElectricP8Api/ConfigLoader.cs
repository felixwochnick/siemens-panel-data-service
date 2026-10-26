using System;
using System.IO;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace EplanElectricP8Api
{
    internal static class ConfigLoader
    {
        public static string DefaultConfigPath => Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.yaml");

        public static ConfigModel Load(string path)
        {
            var deserializer = new DeserializerBuilder()
                .WithNamingConvention(UnderscoredNamingConvention.Instance)
                .IgnoreUnmatchedProperties()
                .Build();

            var config = deserializer.Deserialize<ConfigModel>(File.ReadAllText(path)) ?? new ConfigModel();
            config.Logging = config.Logging ?? new LoggingConfig();
            config.Eplan = config.Eplan ?? new EplanConfig();
            config.Database = config.Database ?? new DatabaseConfig();
            config.Export = config.Export ?? new ExportConfig();
            config.Export.Labels = config.Export.Labels ?? LabelExportConfig.Defaults();

            // Relative Pfade beziehen sich auf den Ordner der config.yaml (ein Dienst läuft in C:\Windows\System32)
            string baseDir = Path.GetDirectoryName(Path.GetFullPath(path));
            config.Logging.Directory = Resolve(baseDir, config.Logging.Directory);
            config.Database.Path = Resolve(baseDir, config.Database.Path);
            config.Export.ProjectFolder = Resolve(baseDir, config.Export.ProjectFolder);
            config.Export.OutputFolder = Resolve(baseDir, config.Export.OutputFolder);
            return config;
        }

        public static void Save(ConfigModel config, string path)
        {
            var serializer = new SerializerBuilder()
                .WithNamingConvention(UnderscoredNamingConvention.Instance)
                .Build();

            File.WriteAllText(path, serializer.Serialize(config));
        }

        private static string Resolve(string baseDir, string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return path;
            }
            return Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(baseDir, path));
        }
    }
}
