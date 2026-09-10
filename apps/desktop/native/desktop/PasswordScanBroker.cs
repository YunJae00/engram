using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed class PasswordScanBroker : IDisposable
{
    private Process Worker;
    private ScannerJob Job;
    private int Sequence;
    private bool Unavailable;
    private const int TimeoutMs = 2000;

    internal static string ReadLine(TextReader reader)
    {
        var line = new StringBuilder();
        while (true)
        {
            var character = reader.Read();
            if (character < 0)
            {
                if (line.Length != 0) throw new EndOfStreamException("Incomplete scanner response");
                return null;
            }
            if (character == '\n') return line.ToString().TrimEnd('\r');
            if (line.Length >= 1024) throw new InvalidDataException("Scanner message exceeds its limit");
            line.Append((char)character);
        }
    }

    internal static bool ReadResponse(string line, int id, IntPtr window, int pid, long started,
        out bool password, out long workingSetBytes)
    {
        password = false; workingSetBytes = 0;
        if (line == null || line.Length > 1024) throw new InvalidDataException("Scanner response is unavailable");
        var response = new JavaScriptSerializer { MaxJsonLength = 1024, RecursionLimit = 4 }
            .Deserialize<Dictionary<string, object>>(line);
        object value;
        if (response == null || response.Count != 8
            || !response.TryGetValue("id", out value) || !(value is int) || (int)value != id
            || !response.TryGetValue("window", out value) || !(value is string) || (string)value != window.ToInt64().ToString(CultureInfo.InvariantCulture)
            || !response.TryGetValue("pid", out value) || !(value is int) || (int)value != pid
            || !response.TryGetValue("started", out value) || !(value is string) || (string)value != started.ToString(CultureInfo.InvariantCulture))
            throw new InvalidDataException("Scanner response belongs to a different request");
        if (!response.TryGetValue("complete", out value) || !(value is bool)) throw new InvalidDataException("Invalid scanner coverage");
        var complete = (bool)value;
        if (!response.TryGetValue("password", out value) || (complete ? !(value is bool) : value != null))
            throw new InvalidDataException("Invalid scanner password result");
        var found = complete && (bool)value;
        if (!response.TryGetValue("workingSetBytes", out value) || !(value is int || value is long)
            || Convert.ToInt64(value, CultureInfo.InvariantCulture) <= 0) throw new InvalidDataException("Invalid scanner memory measurement");
        workingSetBytes = Convert.ToInt64(value, CultureInfo.InvariantCulture);
        if (!response.TryGetValue("elapsedMs", out value) || !(value is int || value is long || value is decimal || value is double))
            throw new InvalidDataException("Invalid scanner timing");
        var elapsed = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (double.IsNaN(elapsed) || double.IsInfinity(elapsed) || elapsed < 0 || elapsed > TimeoutMs)
            throw new InvalidDataException("Scanner response exceeded its time limit");
        password = found;
        return complete;
    }

    private void Start()
    {
        if (Worker != null && !Worker.HasExited) return;
        Stop();
        using (var owner = Process.GetCurrentProcess())
        {
            var start = new ProcessStartInfo {
                FileName = typeof(Program).Assembly.Location,
                Arguments = "--password-scan-worker " + owner.Id.ToString(CultureInfo.InvariantCulture) + " "
                    + owner.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true, RedirectStandardOutput = true,
                StandardOutputEncoding = new UTF8Encoding(false)
            };
            Worker = Process.Start(start);
            if (Worker == null) throw new InvalidOperationException("Scanner process could not start");
            Job = ScannerJob.Attach(Worker);
        }
    }

    internal bool TryScan(IntPtr window, int pid, long started, out bool password)
    {
        password = false;
        if (Unavailable) return false;
        Task<string> response = null;
        var succeeded = false;
        try
        {
            if (window.ToInt64() <= 0 || pid <= 4 || started <= 0) return false;
            if (Sequence == int.MaxValue) { Stop(); Sequence = 0; }
            var cold = Worker == null || Worker.HasExited;
            var watch = Stopwatch.StartNew();
            Start();
            var id = ++Sequence;
            var request = new JavaScriptSerializer().Serialize(new {
                id = id, window = window.ToInt64().ToString(CultureInfo.InvariantCulture), pid = pid,
                started = started.ToString(CultureInfo.InvariantCulture)
            });
            Worker.StandardInput.WriteLine(request);
            Worker.StandardInput.Flush();
            var reader = Worker.StandardOutput;
            response = Task.Factory.StartNew(delegate { return ReadLine(reader); });
            var remaining = TimeoutMs - (int)Math.Min(TimeoutMs, watch.ElapsedMilliseconds);
            if (!response.Wait(remaining)) throw new TimeoutException("Scanner response timed out");
            if (watch.ElapsedMilliseconds > TimeoutMs) throw new TimeoutException("Scanner response arrived too late");
            long memory;
            var complete = ReadResponse(response.Result, id, window, pid, started, out password, out memory);
            if (Environment.GetEnvironmentVariable("CI") == "true" && Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true")
                Console.Error.WriteLine("SCANNER_PROFILE " + new JavaScriptSerializer().Serialize(new {
                    cold = cold, elapsedMs = watch.Elapsed.TotalMilliseconds, workingSetBytes = memory, complete = complete
                }));
            succeeded = complete;
            return complete;
        }
        catch (IOException) { return false; }
        catch (InvalidDataException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (ArgumentException) { return false; }
        catch (Win32Exception) { return false; }
        catch (TimeoutException) { return false; }
        catch (AggregateException) { return false; }
        finally
        {
            if (!succeeded)
            {
                // Keep the fresh native fallback for this helper lifetime instead of spawning per packet.
                Unavailable = true;
                Stop();
                if (response != null) try { response.Wait(500); } catch (AggregateException) { /* The closed pipe ends the pending read. */ }
            }
        }
    }

    private void Stop()
    {
        var worker = Worker; Worker = null;
        if (Job != null) { Job.Dispose(); Job = null; }
        if (worker == null) return;
        try { if (!worker.HasExited) worker.Kill(); worker.WaitForExit(500); }
        catch (InvalidOperationException) { /* The process already exited. */ }
        catch (Win32Exception) { /* Closing the attached job also terminates the worker. */ }
        finally { worker.Dispose(); }
    }

    public void Dispose() { Stop(); }
}
