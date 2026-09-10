using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;

internal static class ScannerTimeoutProbe
{
    internal static int Run(string[] args)
    {
        if (Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true") return 2;
        if (args.Length == 3 && args[0] == "--password-scan-worker")
        {
            File.AppendAllText(Environment.GetEnvironmentVariable("ENGRAM_SCANNER_PID_FILE"), Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + "\n");
            Thread.Sleep(30000);
            return 2;
        }
        if (args.Length != 4) return 2;
        try
        {
            Environment.SetEnvironmentVariable("ENGRAM_SCANNER_PID_FILE", args[0]);
            var clock = Stopwatch.StartNew();
            bool password;
            bool available;
            double secondMs;
            using (var broker = new PasswordScanBroker())
            {
                available = broker.TryScan(new IntPtr(long.Parse(args[1])), int.Parse(args[2]), long.Parse(args[3]), out password);
                if (available) throw new InvalidOperationException("An unresponsive scanner became proof of safety");
                var second = Stopwatch.StartNew();
                if (broker.TryScan(new IntPtr(long.Parse(args[1])), int.Parse(args[2]), long.Parse(args[3]), out password))
                    throw new InvalidOperationException("An unavailable scanner was reused as proof of safety");
                secondMs = second.Elapsed.TotalMilliseconds;
                if (secondMs >= 500) throw new InvalidOperationException("An unavailable scanner was restarted");
            }
            clock.Stop();
            if (available) throw new InvalidOperationException("An unresponsive scanner became proof of safety");
            var children = File.ReadAllLines(args[0]);
            if (children.Length != 1) throw new InvalidOperationException("An unavailable scanner spawned another child");
            var child = int.Parse(children[0], CultureInfo.InvariantCulture);
            try
            {
                using (var process = Process.GetProcessById(child))
                    if (!process.WaitForExit(2000)) throw new InvalidOperationException("The timed-out scanner remained alive");
            }
            catch (ArgumentException) { }
            Console.WriteLine("{\"unavailable\":true,\"sticky\":true,\"exited\":true,\"elapsedMs\":"
                + clock.Elapsed.TotalMilliseconds.ToString(CultureInfo.InvariantCulture) + ",\"secondMs\":"
                + secondMs.ToString(CultureInfo.InvariantCulture) + "}");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}

internal static class Program
{
    private static int Main(string[] args) { return ScannerTimeoutProbe.Run(args); }
}
