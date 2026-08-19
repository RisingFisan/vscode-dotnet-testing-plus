using System;
using System.IO;
using System.Text;
using Microsoft.VisualStudio.TestPlatform.ObjectModel;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Logging;

namespace Playlist
{
    // VSTest logger that appends one JSON line per test result to the file in
    // PLAYLIST_STREAM_LOG as soon as each test completes, letting the VS Code
    // extension show results live instead of waiting for the final TRX.
    // The assembly name MUST end with "TestLogger.dll" — VSTest only probes
    // assemblies matching that pattern for ITestLogger implementations.
    [ExtensionUri("logger://playlist/stream/1.0")]
    [FriendlyName("playliststream")]
    public class JsonStreamLogger : ITestLogger
    {
        private string outputPath;

        public void Initialize(TestLoggerEvents events, string testRunDirectory)
        {
            this.outputPath = Environment.GetEnvironmentVariable("PLAYLIST_STREAM_LOG");
            if (string.IsNullOrEmpty(this.outputPath))
            {
                this.outputPath = Path.Combine(testRunDirectory ?? ".", "playlist-stream.jsonl");
            }
            events.TestResult += this.OnTestResult;
        }

        private void OnTestResult(object sender, TestResultEventArgs e)
        {
            try
            {
                var r = e.Result;
                var fqn = r.TestCase != null ? r.TestCase.FullyQualifiedName : r.DisplayName;
                var line = "{" +
                    "\"fqn\":" + JsonEscape(fqn) + "," +
                    "\"outcome\":" + JsonEscape(r.Outcome.ToString()) + "," +
                    "\"durationMs\":" + ((long)r.Duration.TotalMilliseconds).ToString() + "," +
                    "\"message\":" + JsonEscape(r.ErrorMessage) + "," +
                    "\"stackTrace\":" + JsonEscape(r.ErrorStackTrace) +
                    "}\n";
                File.AppendAllText(this.outputPath, line, Encoding.UTF8);
            }
            catch
            {
            }
        }

        private static string JsonEscape(string s)
        {
            if (s == null)
            {
                return "null";
            }
            var sb = new StringBuilder("\"");
            foreach (var c in s)
            {
                switch (c)
                {
                    case '\"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        sb.Append(c < 0x20 ? "\\u" + ((int)c).ToString("x4") : c.ToString());
                        break;
                }
            }
            sb.Append("\"");
            return sb.ToString();
        }
    }
}
