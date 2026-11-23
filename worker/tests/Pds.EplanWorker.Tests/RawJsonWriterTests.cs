using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using Pds.EplanWorker.Raw;

namespace Pds.EplanWorker.Tests
{
    public class RawJsonWriterTests
    {
        /// <summary>
        /// Vertrag mit packages/analyzer/src/types.ts: Feldnamen, Reihenfolge, Typen, null nur bei Objekten/Zahlen
        /// laut Spec, Strings nie null.
        /// </summary>
        [Fact]
        public void Write_ProducesFormat1ExactlyAsSpecified()
        {
            const string expected = """
            {
              "format": 1, "worker": "9.9.9", "eplanVersion": "2025.0.3",
              "project": { "name": "Anlage", "pageCount": 2 },
              "pages": [ { "name": "=VB030+LCM&EFS/7", "isReport": false }, { "name": "=A/1", "isReport": true } ],
              "connections": [
                {
                  "id": "1/2", "is3d": false, "page": "=VB030+LCM&EFS/7", "definition": "Ader / Draht",
                  "designation": "VD_X500", "sourceProperty": "", "destinationProperty": "",
                  "wireNumber": "BK", "crossSection": "1,5 mm²", "wireType": "SIENOPYR(90)", "length": "",
                  "partNumbers": ["A1", "A1"],
                  "cable": { "name": "-W1", "type": "GSC-01", "wireCountAndCrossSection": "4x0,22" },
                  "start": { "functionName": "=VB030+LCM-Q20", "pinName": "1", "pinDesignation": "1",
                             "plugAutomatic": "", "plugManual": "", "parentIsShield": false },
                  "end": null,
                  "shieldings": [ { "page": "=VB030+LCM&EFS/7", "x": 10.5, "y": -2, "name": "" } ],
                  "symbols": [ { "page": "=VB030+LCM&EFS/7", "x": 1, "y": 2 } ],
                  "startSymbol": { "page": "=VB030+LCM&EFS/7", "x": 1, "y": 2, "pinX": 0.5, "pinY": 0 },
                  "endSymbol": null
                },
                {
                  "id": "3/4", "is3d": true, "page": "", "definition": "", "designation": "", "sourceProperty": "",
                  "destinationProperty": "", "wireNumber": "", "crossSection": "", "wireType": "", "length": "",
                  "partNumbers": [], "cable": null, "start": null, "end": null, "shieldings": [], "symbols": [],
                  "startSymbol": null, "endSymbol": null
                }
              ],
              "texts": [ { "page": "=VB030+LCM&EFS/7", "content": "#", "x": 12.25, "y": 100,
                           "box": [[11, 99], [13.5, 101]], "free": true } ],
              "lines": [ { "page": "=VB030+LCM&EFS/7", "x1": 0, "y1": 0, "x2": 6.5, "y2": 0 } ],
              "shields": [ { "page": "=VB030+LCM&EFS/7", "name": "", "x": 1, "y": 2, "variant": 0, "width": 12.5, "height": null } ],
              "cableDefinitions": [
                {
                  "page": "=VB030+LCM&EFS/7", "kind": "cable", "name": "-W1", "x": 3, "y": 4,
                  "definition": "Kabeldefinition", "sourceProperty": "=A-K1", "destinationProperty": "",
                  "type": "GSC-01", "wireCountAndCrossSection": "4x0,22", "length": "5 m",
                  "partNumbers": ["X"], "wires": ["1/2"]
                }
              ]
            }
            """;

            Assert.Equal(Samples.Minify(expected), Encoding.UTF8.GetString(Write(Samples.Project())));
        }

        [Fact]
        public void Write_UsesDecimalPointUnderGermanCulture()
        {
            var previous = CultureInfo.CurrentCulture;
            CultureInfo.CurrentCulture = new CultureInfo("de-DE");
            try
            {
                var project = new RawProject();
                project.Lines.Add(new RawLine { Page = "1", X1 = 1.5, Y1 = -0.25, X2 = 1234567.125, Y2 = 1e-7 });
                project.Shields.Add(new RawShield { Width = 12.5, Height = 0.1 });

                string json = Encoding.UTF8.GetString(Write(project));

                Assert.Contains("\"x1\":1.5,\"y1\":-0.25,\"x2\":1234567.125,", json);
                Assert.Contains("\"width\":12.5,\"height\":0.1", json);
                Assert.DoesNotContain("1,5", json);
                using var document = JsonDocument.Parse(json);
                var line = document.RootElement.GetProperty("lines")[0];
                Assert.Equal(1e-7, line.GetProperty("y2").GetDouble());
            }
            finally
            {
                CultureInfo.CurrentCulture = previous;
            }
        }

        [Theory]
        [InlineData(0.1, "0.1")]
        [InlineData(123.45, "123.45")]
        [InlineData(-4, "-4")]
        [InlineData(297.0000000001, "297.0000000001")]
        [InlineData(1e-7, "1E-07")]
        [InlineData(double.NaN, "0")]
        public void FormatNumber_IsShortestAndInvariant(double value, string expected)
        {
            var previous = CultureInfo.CurrentCulture;
            CultureInfo.CurrentCulture = new CultureInfo("de-DE");
            try
            {
                Assert.Equal(expected, RawJsonWriter.FormatNumber(value));
            }
            finally
            {
                CultureInfo.CurrentCulture = previous;
            }
        }

        [Fact]
        public void FormatNumber_RoundTrips()
        {
            var random = new Random(4711);
            for (int i = 0; i < 10000; i++)
            {
                double value = (random.NextDouble() - 0.5) * Math.Pow(10, random.Next(-8, 9));
                string text = RawJsonWriter.FormatNumber(value);

                using var document = JsonDocument.Parse(text);
                Assert.Equal(value, document.RootElement.GetDouble());
            }
        }

        [Theory]
        [InlineData("1,5 mm²")]
        [InlineData("Anführungszeichen \" und Backslash \\")]
        [InlineData("ÄÖÜäöüß €")]
        [InlineData("Zeile 1\r\nZeile 2\tTab")]
        [InlineData("=+H.A25-A1-B150:X531:1 <&>'")]
        [InlineData("\u0001 Steuerzeichen")]
        public void Write_KeepsSpecialCharacters(string text)
        {
            var project = new RawProject();
            project.Texts.Add(new RawText { Page = text, Content = text });

            byte[] bytes = Write(project);

            using var document = JsonDocument.Parse(bytes);
            Assert.Equal(text, document.RootElement.GetProperty("texts")[0].GetProperty("content").GetString());
            Assert.DoesNotContain((byte)'\n', bytes);
        }

        [Fact]
        public void Write_KeepsUmlautsAndSuperscriptReadable()
        {
            var project = new RawProject();
            project.Texts.Add(new RawText { Content = "Größe 1,5 mm² \"x\" \\" });

            string json = Encoding.UTF8.GetString(Write(project));

            Assert.Contains("\"content\":\"Größe 1,5 mm² \\\"x\\\" \\\\\"", json);
        }

        [Fact]
        public void Write_ReplacesBrokenSurrogates()
        {
            var project = new RawProject();
            project.Texts.Add(new RawText { Content = "a\uD800b" + "􏿿" });

            using var document = JsonDocument.Parse(Write(project));

            Assert.Equal("a�b􏿿", document.RootElement.GetProperty("texts")[0].GetProperty("content").GetString());
        }

        [Fact]
        public void Write_TurnsNullStringsIntoEmptyAndNonFiniteNumbersIntoZeroOrNull()
        {
            var project = new RawProject { Worker = null, EplanVersion = null };
            project.Pages.Add(new RawPage { Name = null });
            project.Lines.Add(new RawLine { X1 = double.NaN, Y1 = double.PositiveInfinity });
            project.Shields.Add(new RawShield { Width = double.NaN, Height = null });
            project.Texts.Add(new RawText { Box = null });

            using var document = JsonDocument.Parse(Write(project));
            var root = document.RootElement;

            Assert.Equal("", root.GetProperty("worker").GetString());
            Assert.Equal("", root.GetProperty("pages")[0].GetProperty("name").GetString());
            Assert.Equal(0, root.GetProperty("lines")[0].GetProperty("x1").GetDouble());
            Assert.Equal(0, root.GetProperty("lines")[0].GetProperty("y1").GetDouble());
            Assert.Equal(JsonValueKind.Null, root.GetProperty("shields")[0].GetProperty("width").ValueKind);
            Assert.Equal(-1, root.GetProperty("shields")[0].GetProperty("variant").GetInt32());
            Assert.Equal(0, root.GetProperty("texts")[0].GetProperty("box").GetArrayLength());
        }

        [Fact]
        public void WriteFile_WritesUtf8WithoutBomAndReplacesExistingFile()
        {
            using var folder = new TempFolder();
            string path = folder.File(Path.Combine("unter", "raw.json"));
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "alt");

            RawJsonWriter.WriteFile(path, Samples.Project());

            byte[] bytes = File.ReadAllBytes(path);
            Assert.Equal((byte)'{', bytes[0]);
            Assert.Equal(Write(Samples.Project()), bytes);
            Assert.False(File.Exists(path + ".tmp"));
        }

        [Fact]
        public void Write_LargeProject_IsComplete()
        {
            var project = new RawProject();
            for (int i = 0; i < 20000; i++)
            {
                project.Connections.Add(new RawConnection { Id = "c" + i, Designation = "VD_X" + i, PartNumbers = { "3RT2015-1BB42" } });
            }

            using var document = JsonDocument.Parse(Write(project));

            Assert.Equal(20000, document.RootElement.GetProperty("connections").GetArrayLength());
            Assert.Equal("c19999", document.RootElement.GetProperty("connections")[19999].GetProperty("id").GetString());
        }

        private static byte[] Write(RawProject project)
        {
            using var stream = new MemoryStream();
            RawJsonWriter.Write(stream, project);
            return stream.ToArray();
        }
    }
}
