using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

internal static class PasswordScanWorker
{
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    private static long Positive(string value)
    {
        long number;
        if (value == null || value.Length > 19 || !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number) || number <= 0)
            throw new ArgumentException("Invalid scanner identity");
        return number;
    }
    private static bool Same(IntPtr window, int pid, long started, int session)
    {
        uint actual;
        if (!IsWindow(window) || GetAncestor(window, 2) != window || GetWindowThreadProcessId(window, out actual) == 0 || actual != pid) return false;
        using (var process = Process.GetProcessById(pid))
            return !process.HasExited && process.SessionId == session && process.StartTime.ToUniversalTime().Ticks == started;
    }
    internal static int Run(string[] args)
    {
        try
        {
            if (args.Length != 3) return 2;
            var ownerPid = checked((int)Positive(args[1]));
            var ownerStarted = Positive(args[2]);
            using (var owner = Process.GetProcessById(ownerPid))
            using (var self = Process.GetCurrentProcess())
            {
                if (ownerPid == self.Id || owner.SessionId != self.SessionId || owner.StartTime.ToUniversalTime().Ticks != ownerStarted) return 2;
                // Cover parent death before job attachment, including a blocked provider.
                using (var watcher = new Timer(delegate {
                    try { if (owner.HasExited) Environment.Exit(2); }
                    catch { Environment.Exit(2); }
                }, null, 250, 250))
                using (var scan = new RemotePasswordScan())
                {
                    var client = (PasswordScan.Client)Activator.CreateInstance(Type.GetTypeFromCLSID(
                        new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true));
                    try
                    {
                        var json = new JavaScriptSerializer { MaxJsonLength = 1024, RecursionLimit = 4 };
                        string line;
                        while ((line = PasswordScanBroker.ReadLine(Console.In)) != null)
                        {
                            var request = json.Deserialize<Dictionary<string, object>>(line);
                            object value;
                            if (request == null || request.Count != 4 || !request.TryGetValue("id", out value) || !(value is int) || (int)value <= 0) return 2;
                            var id = (int)value;
                            if (!request.TryGetValue("window", out value) || !(value is string)) return 2;
                            var windowText = (string)value;
                            var window = new IntPtr(Positive(windowText));
                            if (!request.TryGetValue("pid", out value) || !(value is int) || (int)value <= 4) return 2;
                            var pid = (int)value;
                            if (pid == self.Id || pid == ownerPid) return 2;
                            if (!request.TryGetValue("started", out value) || !(value is string)) return 2;
                            var startedText = (string)value;
                            var started = Positive(startedText);
                            if (owner.HasExited || !Same(window, pid, started, self.SessionId)) return 2;
                            var watch = Stopwatch.StartNew();
                            bool password;
                            PasswordScan.Element root = null;
                            bool complete;
                            try
                            {
                                Marshal.ThrowExceptionForHR(client.ElementFromHandle(window, out root));
                                if (root == null) return 2;
                                complete = scan.TryScan(root, pid, out password);
                            }
                            finally { if (root != null) Marshal.FinalReleaseComObject(root); }
                            if (owner.HasExited || !Same(window, pid, started, self.SessionId)) return 2;
                            watch.Stop();
                            self.Refresh();
                            Console.WriteLine(json.Serialize(new {
                                id = id, window = windowText, pid = pid, started = startedText, complete = complete,
                                password = complete ? (object)password : null, elapsedMs = watch.Elapsed.TotalMilliseconds,
                                workingSetBytes = self.WorkingSet64
                            }));
                            Console.Out.Flush();
                        }
                        return 0;
                    }
                    finally { Marshal.FinalReleaseComObject(client); }
                }
            }
        }
        catch { return 2; }
    }
}
