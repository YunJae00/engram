using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

internal static class ScannerLifecycleProbe
{
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    private static int Main(string[] args)
    {
        if (Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true") return 2;
        if (args.Length != 3) return 2;
        var window = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        var pid = int.Parse(args[2], CultureInfo.InvariantCulture);
        uint actual;
        var title = new StringBuilder(128);
        GetWindowThreadProcessId(window, out actual);
        GetWindowText(window, title, title.Capacity);
        if (actual != pid || title.ToString() != "Desktop input fixture") return 2;
        long started;
        using (var target = Process.GetProcessById(pid)) started = target.StartTime.ToUniversalTime().Ticks;
        using (var current = Process.GetCurrentProcess())
        using (var child = new Process())
        {
            child.StartInfo = new ProcessStartInfo(args[0], "--password-scan-worker " + current.Id + " "
                + current.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture))
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            ScannerJob job = null;
            try
            {
                child.Start();
                job = ScannerJob.Attach(child);
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs line)
                { if (line.Data != null) { Console.WriteLine(line.Data); Console.Out.Flush(); } };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs line)
                { if (line.Data != null) Console.Error.WriteLine(line.Data); };
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                child.Refresh();
                Console.WriteLine("{\"type\":\"ready\",\"pid\":" + child.Id + ",\"started\":\"" + started + "\"}");
                Console.Out.Flush();
                string command;
                while ((command = Console.ReadLine()) != null)
                {
                    if (command == "dispose")
                    {
                        job.Dispose();
                        if (!child.WaitForExit(2000)) throw new InvalidOperationException("The disposed job retained its child");
                        Console.WriteLine("{\"exited\":true}");
                        Console.Out.Flush();
                        return 0;
                    }
                    if (command == "memory")
                    {
                        child.Refresh();
                        Console.WriteLine("{\"workingSetBytes\":" + child.WorkingSet64 + ",\"privateBytes\":" + child.PrivateMemorySize64 + "}");
                        Console.Out.Flush();
                    }
                    else if (command == "eof")
                    {
                        child.StandardInput.Close();
                        if (!child.WaitForExit(2000)) throw new InvalidOperationException("The scanner ignored pipe EOF");
                        Console.WriteLine("{\"exited\":true}");
                        Console.Out.Flush();
                        return 0;
                    }
                    else
                    {
                        if (command.Length > 1024 || !command.StartsWith("{")) throw new InvalidOperationException("Invalid scanner request");
                        child.StandardInput.WriteLine(command);
                        child.StandardInput.Flush();
                    }
                }
                return 0;
            }
            finally
            {
                if (job != null) job.Dispose();
                try { if (!child.HasExited) { child.Kill(); child.WaitForExit(2000); } }
                catch (InvalidOperationException) { }
            }
        }
    }
}
