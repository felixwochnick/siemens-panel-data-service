using System;
using System.Collections.Generic;
using System.Linq;
using Eplan.EplApi.Base;
using Eplan.EplApi.DataModel;
using Eplan.EplApi.DataModel.Graphics;

namespace EplanElectricP8Api
{
    /// <summary>Liest die freien Texte der Seiten (z.B. Hinweise für die Montage) für das Blatt "Texte".</summary>
    internal static class TextList
    {
        public static readonly string[] Header = { "Seite", "Text" };

        /// <summary>Markierungen wie "#" sind eigene Spalten im Blatt "Verbindungen" und werden hier ausgelassen.</summary>
        private static readonly HashSet<string> Ignored = new HashSet<string> { "#" };

        public static List<string[]> Rows(Project project)
        {
            var rows = new List<string[]>();
            foreach (var page in project.Pages)
            {
                // Automatisch erzeugte Auswertungsseiten (Klemmenplan, Kabelplan, ...) enthalten nur Listeninhalte
                if (IsReport(page))
                {
                    continue;
                }

                // Von oben nach unten, dann von links nach rechts (Seitenkoordinaten: y wächst nach oben)
                // Nur freie Texte: Texte in Gruppen gehören zu Symbolen, Gerätegrafiken oder Makros (z.B. "RDY", "ON")
                var texts = page.AllPlacements.OfType<Text>()
                    .Where(text => IsFree(text))
                    .Select(text => new { Content = Content(text), Location = text.Location })
                    .Where(text => text.Content.Length > 0 && !Ignored.Contains(text.Content))
                    .OrderByDescending(text => text.Location.Y)
                    .ThenBy(text => text.Location.X);
                foreach (var text in texts)
                {
                    rows.Add(new[] { page.Name, text.Content });
                }
            }
            return rows;
        }

        private static bool IsReport(Page page)
        {
            try
            {
                return page.ReportBlock != null;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool IsFree(Text text)
        {
            try
            {
                return text.Group == null;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static string Content(Text text)
        {
            try
            {
                string content = text.Contents.GetStringToDisplay(ISOCode.Language.L_de_DE);
                if (string.IsNullOrEmpty(content))
                {
                    content = text.Contents.GetStringToDisplay(ISOCode.Language.L___);
                }
                if (string.IsNullOrEmpty(content))
                {
                    content = text.Contents.GetStringToDisplay(ISOCode.Language.L_en_US);
                }
                return (content ?? "").Trim();
            }
            catch (Exception)
            {
                return "";
            }
        }
    }
}
