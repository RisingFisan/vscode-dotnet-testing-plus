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
        private readonly object gate = new object();
        private StreamWriter writer;
        private bool warned;

        public void Initialize(TestLoggerEvents events, string testRunDirectory)
        {
            var outputPath = Environment.GetEnvironmentVariable("PLAYLIST_STREAM_LOG");
            if (string.IsNullOrEmpty(outputPath))
            {
                outputPath = Path.Combine(testRunDirectory ?? ".", "playlist-stream.jsonl");
            }

            try
            {
                // One handle for the whole run (instead of open/close per result);
                // AutoFlush keeps every line visible to the extension immediately.
                // FileShare.ReadWrite lets the extension tail the file meanwhile.
                var stream = new FileStream(outputPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                this.writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch (Exception ex)
            {
                this.Warn("could not open " + outputPath + ": " + ex.Message);
            }

            events.TestResult += this.OnTestResult;
            events.TestRunComplete += this.OnTestRunComplete;
        }

        private void OnTestRunComplete(object sender, TestRunCompleteEventArgs e)
        {
            lock (this.gate)
            {
                if (this.writer != null)
                {
                    this.writer.Dispose();
                    this.writer = null;
                }
            }
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
                lock (this.gate)
                {
                    if (this.writer != null)
                    {
                        this.writer.Write(line);
                    }
                }
            }
            catch (Exception ex)
            {
                // The extension falls back to the TRX when lines are missing, so a
                // failure must never fail the run; say so once instead of silently.
                this.Warn("could not write a result: " + ex.Message);
            }
        }

        private void Warn(string message)
        {
            if (this.warned)
            {
                return;
            }
            this.warned = true;
            try
            {
                Console.Error.WriteLine("playliststream logger: " + message);
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
