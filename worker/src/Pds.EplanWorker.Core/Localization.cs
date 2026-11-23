using System;

namespace Pds.EplanWorker
{
    /// <summary>Auswahl der Sprache bei mehrsprachigen Texten (MultiLangString).</summary>
    public static class Localization
    {
        /// <summary>
        /// Deutsch, sonst sprachneutral, sonst Englisch, getrimmt (Spec „Rohdaten“). Eine Sprache, die nur Leerzeichen
        /// enthält, zählt als leer. Die Werte werden erst bei Bedarf gelesen.
        /// </summary>
        public static string Choose(Func<string> german, Func<string> neutral, Func<string> english)
        {
            foreach (var language in new[] { german, neutral, english })
            {
                string text = language();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    return text.Trim();
                }
            }
            return "";
        }
    }
}
