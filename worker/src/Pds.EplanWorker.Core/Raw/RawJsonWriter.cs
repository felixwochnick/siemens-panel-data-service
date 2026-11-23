using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using Pds.EplanWorker.Protocol;

namespace Pds.EplanWorker.Raw
{
    /// <summary>
    /// Schreibt <c>raw.json</c> (Format 1) mit <see cref="Utf8JsonWriter"/>: UTF-8 ohne BOM, Feldnamen und Reihenfolge
    /// wie im Spec, Zahlen unabhängig von der Kultur mit Punkt, Strings nie <c>null</c>.
    /// </summary>
    public static class RawJsonWriter
    {
        /// <summary>Puffer des Writers ab dieser Größe in den Stream leeren (große Projekte).</summary>
        private const int FlushThreshold = 64 * 1024;

        /// <summary>
        /// Schreibt zuerst <c>&lt;Datei&gt;.tmp</c> und benennt sie dann um, damit der Client nie eine halbe Datei liest.
        /// </summary>
        public static void WriteFile(string path, RawProject project)
        {
            string fullPath = Path.GetFullPath(path);
            string directory = Path.GetDirectoryName(fullPath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            string temp = fullPath + ".tmp";
            try
            {
                using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024))
                {
                    Write(stream, project);
                }
                if (File.Exists(fullPath))
                {
                    File.Delete(fullPath);
                }
                File.Move(temp, fullPath);
            }
            catch
            {
                TryDelete(temp);
                throw;
            }
        }

        public static void Write(Stream stream, RawProject project)
        {
            using (var w = new Utf8JsonWriter(stream, JsonText.WriterOptions))
            {
                w.WriteStartObject();
                w.WriteNumber("format", ProtocolConstants.RawFormat);
                WriteText(w, "worker", project.Worker);
                WriteText(w, "eplanVersion", project.EplanVersion);

                var info = project.Project ?? new RawProjectInfo();
                w.WriteStartObject("project");
                WriteText(w, "name", info.Name);
                w.WriteNumber("pageCount", info.PageCount);
                w.WriteEndObject();

                w.WriteStartArray("pages");
                foreach (var page in project.Pages)
                {
                    w.WriteStartObject();
                    WriteText(w, "name", page.Name);
                    w.WriteBoolean("isReport", page.IsReport);
                    w.WriteEndObject();
                }
                w.WriteEndArray();

                w.WriteStartArray("connections");
                foreach (var connection in project.Connections)
                {
                    WriteConnection(w, connection);
                    FlushIfNeeded(w);
                }
                w.WriteEndArray();

                w.WriteStartArray("texts");
                foreach (var text in project.Texts)
                {
                    w.WriteStartObject();
                    WriteText(w, "page", text.Page);
                    WriteText(w, "content", text.Content);
                    Number(w, "x", text.X);
                    Number(w, "y", text.Y);
                    w.WriteStartArray("box");
                    foreach (var corner in text.Box ?? new List<RawPoint>())
                    {
                        w.WriteStartArray();
                        Number(w, corner.X);
                        Number(w, corner.Y);
                        w.WriteEndArray();
                    }
                    w.WriteEndArray();
                    w.WriteBoolean("free", text.Free);
                    w.WriteEndObject();
                    FlushIfNeeded(w);
                }
                w.WriteEndArray();

                w.WriteStartArray("lines");
                foreach (var line in project.Lines)
                {
                    w.WriteStartObject();
                    WriteText(w, "page", line.Page);
                    Number(w, "x1", line.X1);
                    Number(w, "y1", line.Y1);
                    Number(w, "x2", line.X2);
                    Number(w, "y2", line.Y2);
                    w.WriteEndObject();
                    FlushIfNeeded(w);
                }
                w.WriteEndArray();

                w.WriteStartArray("shields");
                foreach (var shield in project.Shields)
                {
                    w.WriteStartObject();
                    WriteText(w, "page", shield.Page);
                    WriteText(w, "name", shield.Name);
                    Number(w, "x", shield.X);
                    Number(w, "y", shield.Y);
                    w.WriteNumber("variant", shield.Variant);
                    NullableNumber(w, "width", shield.Width);
                    NullableNumber(w, "height", shield.Height);
                    w.WriteEndObject();
                }
                w.WriteEndArray();

                w.WriteStartArray("cableDefinitions");
                foreach (var cable in project.CableDefinitions)
                {
                    w.WriteStartObject();
                    WriteText(w, "page", cable.Page);
                    WriteText(w, "kind", cable.Kind == RawCableDefinition.KindShield ? RawCableDefinition.KindShield : RawCableDefinition.KindCable);
                    WriteText(w, "name", cable.Name);
                    Number(w, "x", cable.X);
                    Number(w, "y", cable.Y);
                    WriteText(w, "definition", cable.Definition);
                    WriteText(w, "sourceProperty", cable.SourceProperty);
                    WriteText(w, "destinationProperty", cable.DestinationProperty);
                    WriteText(w, "type", cable.Type);
                    WriteText(w, "wireCountAndCrossSection", cable.WireCountAndCrossSection);
                    WriteText(w, "length", cable.Length);
                    StringArray(w, "partNumbers", cable.PartNumbers);
                    StringArray(w, "wires", cable.Wires);
                    w.WriteEndObject();
                    FlushIfNeeded(w);
                }
                w.WriteEndArray();

                w.WriteEndObject();
                w.Flush();
            }
        }

        private static void WriteConnection(Utf8JsonWriter w, RawConnection c)
        {
            w.WriteStartObject();
            WriteText(w, "id", c.Id);
            w.WriteBoolean("is3d", c.Is3d);
            WriteText(w, "page", c.Page);
            WriteText(w, "definition", c.Definition);
            WriteText(w, "designation", c.Designation);
            WriteText(w, "sourceProperty", c.SourceProperty);
            WriteText(w, "destinationProperty", c.DestinationProperty);
            WriteText(w, "wireNumber", c.WireNumber);
            WriteText(w, "crossSection", c.CrossSection);
            WriteText(w, "wireType", c.WireType);
            WriteText(w, "length", c.Length);
            StringArray(w, "partNumbers", c.PartNumbers);

            if (c.Cable == null)
            {
                w.WriteNull("cable");
            }
            else
            {
                w.WriteStartObject("cable");
                WriteText(w, "name", c.Cable.Name);
                WriteText(w, "type", c.Cable.Type);
                WriteText(w, "wireCountAndCrossSection", c.Cable.WireCountAndCrossSection);
                w.WriteEndObject();
            }

            WritePin(w, "start", c.Start);
            WritePin(w, "end", c.End);

            w.WriteStartArray("shieldings");
            foreach (var shielding in c.Shieldings)
            {
                w.WriteStartObject();
                WriteText(w, "page", shielding.Page);
                Number(w, "x", shielding.X);
                Number(w, "y", shielding.Y);
                WriteText(w, "name", shielding.Name);
                w.WriteEndObject();
            }
            w.WriteEndArray();

            w.WriteStartArray("symbols");
            foreach (var symbol in c.Symbols)
            {
                w.WriteStartObject();
                WriteText(w, "page", symbol.Page);
                Number(w, "x", symbol.X);
                Number(w, "y", symbol.Y);
                w.WriteEndObject();
            }
            w.WriteEndArray();

            WriteSymbolEnd(w, "startSymbol", c.StartSymbol);
            WriteSymbolEnd(w, "endSymbol", c.EndSymbol);
            w.WriteEndObject();
        }

        private static void WritePin(Utf8JsonWriter w, string name, RawPin pin)
        {
            if (pin == null)
            {
                w.WriteNull(name);
                return;
            }

            w.WriteStartObject(name);
            WriteText(w, "functionName", pin.FunctionName);
            WriteText(w, "pinName", pin.PinName);
            WriteText(w, "pinDesignation", pin.PinDesignation);
            WriteText(w, "plugAutomatic", pin.PlugAutomatic);
            WriteText(w, "plugManual", pin.PlugManual);
            w.WriteBoolean("parentIsShield", pin.ParentIsShield);
            w.WriteEndObject();
        }

        private static void WriteSymbolEnd(Utf8JsonWriter w, string name, RawSymbolEnd symbol)
        {
            if (symbol == null)
            {
                w.WriteNull(name);
                return;
            }

            w.WriteStartObject(name);
            WriteText(w, "page", symbol.Page);
            Number(w, "x", symbol.X);
            Number(w, "y", symbol.Y);
            Number(w, "pinX", symbol.PinX);
            Number(w, "pinY", symbol.PinY);
            w.WriteEndObject();
        }

        private static void WriteText(Utf8JsonWriter w, string name, string value)
        {
            w.WriteString(name, JsonText.Clean(value));
        }

        private static void StringArray(Utf8JsonWriter w, string name, IEnumerable<string> values)
        {
            w.WriteStartArray(name);
            if (values != null)
            {
                foreach (var value in values)
                {
                    w.WriteStringValue(JsonText.Clean(value));
                }
            }
            w.WriteEndArray();
        }

        private static void Number(Utf8JsonWriter w, string name, double value)
        {
            w.WritePropertyName(name);
            Number(w, value);
        }

        private static void Number(Utf8JsonWriter w, double value)
        {
            w.WriteRawValue(FormatNumber(value), skipInputValidation: true);
        }

        private static void NullableNumber(Utf8JsonWriter w, string name, double? value)
        {
            if (value.HasValue && IsFinite(value.Value))
            {
                Number(w, name, value.Value);
            }
            else
            {
                w.WriteNull(name);
            }
        }

        /// <summary>
        /// Kürzeste Darstellung, die genau denselben Wert ergibt, mit Punkt (InvariantCulture). Selbst formatiert, weil
        /// System.Text.Json unter .NET Framework „G17“ schreibt (0.1 ⇒ 0.10000000000000001) – so ist raw.json im Worker
        /// (net481) und in den Tests (net10.0) gleich. „R“ ist unter .NET Framework in seltenen Fällen ungenau, dann G17.
        /// JSON kennt weder NaN noch Unendlich; EPLAN liefert sie nicht, sicher ist sicher: dann 0.
        /// </summary>
        internal static string FormatNumber(double value)
        {
            if (!IsFinite(value))
            {
                return "0";
            }
            string text = value.ToString("R", CultureInfo.InvariantCulture);
            if (double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture) != value)
            {
                text = value.ToString("G17", CultureInfo.InvariantCulture);
            }
            return text;
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private static void FlushIfNeeded(Utf8JsonWriter w)
        {
            if (w.BytesPending > FlushThreshold)
            {
                w.Flush();
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
                // Rest bleibt liegen; der Arbeitsordner wird von der Web-App gelöscht
            }
        }
    }
}
