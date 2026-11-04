using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static class DesktopApps
{
    private static object Call(object item, string member, bool property, params object[] args)
    { return item.GetType().InvokeMember(member, property ? BindingFlags.GetProperty : BindingFlags.InvokeMethod, null, item, args); }
    private static string Property(object item, string name)
    { return Convert.ToString(Call(item, "ExtendedProperty", false, name)); }
    private static void Release(object item)
    { if (item != null && Marshal.IsComObject(item)) Marshal.FinalReleaseComObject(item); }
    internal static string Id(string identity)
    {
        using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").ToLowerInvariant();
    }
    internal static bool Allowed(string name, string identity, string target)
    {
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(identity)) return false;
        if (ControlPolicy.IsSensitive(name) || ControlPolicy.IsSensitive(identity) || ControlPolicy.IsSensitive(target)) return false;
        foreach (var part in Regex.Split(identity + " " + target, @"[\\/ .!_:\-]+"))
            if (WindowGuard.ProtectedApplication(part)) return false;
        return Regex.IsMatch(identity, @"^[A-Za-z0-9.\-_]+![A-Za-z0-9.\-_]+$")
            || (!string.IsNullOrEmpty(target) && Path.IsPathRooted(target) && string.Equals(Path.GetExtension(target), ".exe", StringComparison.OrdinalIgnoreCase));
    }
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr behind, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    private delegate bool WindowCallback(IntPtr window, IntPtr data);
    private static int Pid(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return (int)pid; }
    private static bool Matches(IntPtr window, string target, HashSet<int> prior)
    {
        var pid = Pid(window);
        if (pid <= 0) return false;
        if (!prior.Contains(pid)) return true;
        try { using (var process = System.Diagnostics.Process.GetProcessById(pid)) return !string.IsNullOrEmpty(target) && string.Equals(process.MainModule.FileName, target, StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }
    internal static object Launch(string name, Action open, Func<IntPtr> foreground, Func<IntPtr, bool> restore,
        Func<IntPtr, bool> matches, Func<bool> windowVerified, Action<IntPtr, IntPtr> behind, Action<int> wait)
    {
        var previous = foreground();
        var before = WindowGuard.ForegroundInfo(previous);
        try { open(); }
        catch { if (foreground() != previous) restore(previous); throw; }
        var changed = false;
        var cycles = 0;
        var hiddenMs = 0L;
        var guardStarted = System.Diagnostics.Stopwatch.StartNew();
        for (var poll = 0; poll < 60 && guardStarted.ElapsedMilliseconds < 3000; poll++)
        {
            wait(50);
            var current = foreground();
            if (current == previous || !matches(current)) continue;
            changed = true; cycles++;
            var started = System.Diagnostics.Stopwatch.StartNew();
            if (!restore(previous)) { behind(current, previous); restore(previous); }
            hiddenMs += 50 + started.ElapsedMilliseconds;
        }
        return new { requested = true, opened = true, alreadyOpen = false, name = name, title = name, requiresObservation = true,
            before = before, after = WindowGuard.ForegroundInfo(foreground()), windowVerified = windowVerified(),
            hiddenMs = hiddenMs, cycles = cycles, foregroundChanged = changed, foregroundRestored = foreground() == previous };
    }
    private static object Visit(string wanted, Func<bool> permitted)
    {
        if (wanted != null && !Regex.IsMatch(wanted, "^[a-f0-9]{64}$")) throw new ArgumentException("Use the app name or an ID that open_app gave. Paths and commands are not accepted.");
        object shell = null, folder = null, items = null;
        try
        {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
            folder = Call(shell, "NameSpace", false, "shell:AppsFolder");
            if (folder == null) throw new InvalidOperationException("Windows application catalog is unavailable.");
            items = Call(folder, "Items", false);
            var count = Convert.ToInt32(Call(items, "Count", true));
            if (count > 4096) throw new InvalidOperationException("Windows application catalog exceeds the supported size.");
            var result = new List<object>();
            for (var index = 0; index < count; index++)
            {
                if (!permitted()) throw new InvalidOperationException("The app request was cancelled.");
                object item = null;
                try
                {
                    item = Call(items, "Item", false, index);
                    var name = Convert.ToString(Call(item, "Name", true));
                    var identity = Property(item, "System.AppUserModel.ID");
                    var target = Property(item, "System.Link.TargetParsingPath");
                    var path = Convert.ToString(Call(item, "Path", true));
                    if (string.IsNullOrEmpty(identity)) identity = path;
                    if (!Allowed(name, identity, target)) continue;
                    var id = Id(identity + "\n" + target + "\n" + path);
                    if (wanted == null) result.Add(new { id = id, name = name, aliases = new[] { identity, Path.GetFileNameWithoutExtension(target ?? "") } });
                    else if (wanted == id)
                    {
                        if (!permitted()) throw new InvalidOperationException("The app launch was cancelled.");
                        var prior = new HashSet<int>();
                        foreach (var process in System.Diagnostics.Process.GetProcesses()) { using (process) prior.Add(process.Id); }
                        var previousPid = Pid(DesktopNative.GetForegroundWindow());
                        Func<IntPtr, bool> matches = window => Matches(window, target, prior);
                        return Launch(name, delegate { Call(item, "InvokeVerb", false, "open"); },
                            DesktopNative.GetForegroundWindow, DesktopNative.RestoreForeground, window => Pid(window) != previousPid && matches(window),
                            delegate {
                                var found = false;
                                EnumWindows(delegate(IntPtr window, IntPtr unused) { if (matches(window)) found = true; return !found; }, IntPtr.Zero);
                                return found;
                            },
                            delegate(IntPtr window, IntPtr previous) { SetWindowPos(window, previous, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); },
                            System.Threading.Thread.Sleep);
                    }
                }
                finally { Release(item); }
            }
            if (wanted != null) throw new InvalidOperationException("This app is no longer available. Call open_app with its name again.");
            return result;
        }
        finally { Release(items); Release(folder); Release(shell); }
    }
    internal static object List() { return Visit(null, delegate { return true; }); }
    internal static object Open(string id, Func<bool> permitted) { return Visit(id, permitted); }
}
