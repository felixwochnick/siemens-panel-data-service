using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Pds.EplanWorker.Protocol
{
    /// <summary>Gemeinsame Einstellungen für alles, was der Worker als JSON schreibt.</summary>
    public static class JsonText
    {
        /// <summary>UTF-8 ohne BOM (Protokoll und raw.json).</summary>
        public static readonly Encoding Utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        /// <summary>
        /// Kompakt (eine Zeile) und ohne unnötiges Maskieren: Umlaute, „²“ oder „+“ bleiben lesbar (der Standard-Encoder
        /// würde sie als ü usw. schreiben). Pflicht-Maskierungen (", \, Steuerzeichen, Zeilenumbrüche) bleiben, damit
        /// jede Nachricht genau eine Zeile ist. Das JSON wird nie in HTML eingebettet.
        /// </summary>
        public static readonly JsonWriterOptions WriterOptions = new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            Indented = false,
        };

        /// <summary>
        /// Text für JSON: <c>null</c> wird <c>""</c>, einzelne UTF-16-Surrogate (kaputte Texte aus EPLAN) werden durch
        /// U+FFFD ersetzt, damit der Writer nicht mit einer Ausnahme abbricht.
        /// </summary>
        public static string Clean(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "";
            }

            StringBuilder builder = null;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                bool valid;
                if (char.IsHighSurrogate(c))
                {
                    valid = i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]);
                    if (valid)
                    {
                        builder?.Append(c).Append(value[i + 1]);
                        i++;
                        continue;
                    }
                }
                else
                {
                    valid = !char.IsLowSurrogate(c);
                }

                if (!valid && builder == null)
                {
                    builder = new StringBuilder(value.Length);
                    builder.Append(value, 0, i);
                }
                builder?.Append(valid ? c : '�');
            }
            return builder == null ? value : builder.ToString();
        }
    }
}
