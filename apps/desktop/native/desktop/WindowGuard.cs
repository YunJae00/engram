using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Linq;
using System.Windows.Automation;

internal sealed class DesktopTarget
{
    internal IntPtr Handle;
    internal int Pid;
    internal string Title;
    internal long Started;
    internal long Generation;
    internal bool Minimized;
    internal string Id { get { return Handle.ToInt64().ToString(CultureInfo.InvariantCulture); } }
}

internal sealed class WindowGuard : IDisposable
{
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] private static extern bool IsProcessCritical(IntPtr process, out bool critical);
    [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    private readonly int OwnerPid;
    private readonly int HelperPid;
    private readonly int SessionId;
    private readonly string UserSid;
    private readonly string OwnerPath;
    private readonly long OwnerStarted;
    private readonly WindowLifetime Lifetime;
    private readonly Dictionary<string, Tuple<int, long, string>> Identities = new Dictionary<string, Tuple<int, long, string>>();
    private static readonly HashSet<string> ProtectedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "engram", "electron", "system", "idle", "csrss", "smss", "services", "lsass", "wininit", "winlogon",
        "logonui", "consent", "credentialuibroker", "dwm", "sihost", "shellexperiencehost", "lockapp",
        "securityhealthhost", "securityhealthservice", "securityhealthsystray", "sechealthui", "msmpeng"
        , "cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "mintty", "bash",
        "wsl", "putty", "ssh", "regedit", "mmc", "taskmgr", "systemsettings", "control", "mshta", "rundll32"
    };

    internal WindowGuard(int owner)
    {
        OwnerPid = owner;
        using (var current = Process.GetCurrentProcess()) { HelperPid = current.Id; SessionId = current.SessionId; }
        using (var identity = WindowsIdentity.GetCurrent()) UserSid = identity.User.Value;
        using (var process = Process.GetProcessById(owner))
        {
            if (process.SessionId != SessionId) throw new InvalidOperationException("Desktop owner belongs to another session");
            OwnerStarted = process.StartTime.ToUniversalTime().Ticks;
        }
        OwnerPath = ProcessPath(owner);
        RequireUserProcess(HelperPid);
        Lifetime = new WindowLifetime();
    }

    private static string ProcessPath(int pid)
    {
        var process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) throw new InvalidOperationException("Cannot inspect the selected process");
        try
        {
            var path = new StringBuilder(32768);
            var size = path.Capacity;
            if (!QueryFullProcessImageName(process, 0, path, ref size)) throw new InvalidOperationException("Cannot identify the selected process");
            return path.ToString();
        }
        finally { CloseHandle(process); }
    }

    private static string DesktopName(IntPtr desktop)
    {
        var name = new StringBuilder(256);
        int needed;
        if (desktop == IntPtr.Zero || !GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed))
            throw new InvalidOperationException("The desktop is not available for window sharing");
        return name.ToString();
    }

    private static void RequireUserDesktop(uint thread)
    {
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) throw new InvalidOperationException("The secure desktop cannot be shared");
        try
        {
            if (DesktopName(desktop) != "Default" || DesktopName(GetThreadDesktop(thread)) != "Default")
                throw new InvalidOperationException("Only the normal user desktop can be shared");
        }
        finally { CloseDesktop(desktop); }
    }

    private static IntPtr TokenInfo(IntPtr token, int kind)
    {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        if (needed <= 0 || needed > 65536) throw new InvalidOperationException("Cannot verify process permissions");
        var buffer = Marshal.AllocHGlobal(needed);
        if (GetTokenInformation(token, kind, buffer, needed, out needed)) return buffer;
        Marshal.FreeHGlobal(buffer);
        throw new InvalidOperationException("Cannot verify process permissions");
    }

    private void RequireUserProcess(int pid)
    {
        var process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) throw new InvalidOperationException("Protected processes cannot be shared");
        IntPtr token = IntPtr.Zero;
        try
        {
            bool critical;
            if (!IsProcessCritical(process, out critical) || critical) throw new InvalidOperationException("System processes cannot be shared");
            if (!OpenProcessToken(process, 8, out token)) throw new InvalidOperationException("Cannot verify process permissions");
            var user = TokenInfo(token, 1);
            try
            {
                if (new SecurityIdentifier(Marshal.ReadIntPtr(user)).Value != UserSid)
                    throw new InvalidOperationException("Only your own application windows can be shared");
            }
            finally { Marshal.FreeHGlobal(user); }
            foreach (var kind in new[] { 20, 26 })
            {
                var info = TokenInfo(token, kind);
                try { if (Marshal.ReadInt32(info) != 0) throw new InvalidOperationException("Elevated or privileged applications cannot be shared"); }
                finally { Marshal.FreeHGlobal(info); }
            }
            var integrity = TokenInfo(token, 25);
            try
            {
                var sid = Marshal.ReadIntPtr(integrity);
                var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0 || Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))) > 0x2000)
                    throw new InvalidOperationException("Elevated applications cannot be shared");
            }
            finally { Marshal.FreeHGlobal(integrity); }
        }
        finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
    }

    internal DesktopTarget Resolve(string id, int pid)
    {
        using (var owner = Process.GetProcessById(OwnerPid))
        {
            if (owner.StartTime.ToUniversalTime().Ticks != OwnerStarted) throw new InvalidOperationException("The desktop owner is no longer available");
        }
        long raw;
        if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out raw) || raw <= 0)
            throw new ArgumentException("Window must be a positive decimal handle");
        var handle = new IntPtr(raw);
        if (!IsWindow(handle) || !IsWindowVisible(handle) || GetAncestor(handle, 2) != handle)
            throw new InvalidOperationException("Select a visible top-level application window");
        uint actual;
        var thread = GetWindowThreadProcessId(handle, out actual);
        if ((pid != 0 && actual != pid) || actual > int.MaxValue || thread == 0)
            throw new InvalidOperationException("The selected window has changed process");
        var targetPid = (int)actual;
        if (targetPid <= 4 || targetPid == OwnerPid || targetPid == HelperPid) throw new InvalidOperationException("This window cannot be shared");
        long started;
        using (var process = Process.GetProcessById(targetPid))
        {
            if (process.SessionId != SessionId || ProtectedNames.Contains(process.ProcessName))
                throw new InvalidOperationException("System and Engram windows cannot be shared");
            started = process.StartTime.ToUniversalTime().Ticks;
        }
        var normalized = raw.ToString(CultureInfo.InvariantCulture);
        Tuple<int, long, string> prior;
        if (pid != 0 && Identities.TryGetValue(normalized, out prior) && (prior.Item1 != targetPid || prior.Item2 != started))
            throw new InvalidOperationException("The application process was replaced. Select the window again.");
        if (string.Equals(ProcessPath(targetPid), OwnerPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Engram windows cannot be shared");
        RequireUserDesktop(thread);
        RequireUserProcess(targetPid);
        var generation = pid == 0 ? Lifetime.Select(handle) : Lifetime.Require(handle);
        var runtime = AutomationElement.FromHandle(handle).GetRuntimeId();
        if (runtime == null || runtime.Length == 0) throw new InvalidOperationException("The window has no stable accessibility identity");
        var rootId = string.Join(".", runtime.Select(value => value.ToString(CultureInfo.InvariantCulture)).ToArray());
        if (pid != 0 && Identities.TryGetValue(normalized, out prior) && prior.Item3 != rootId)
            throw new InvalidOperationException("The application window was replaced. Select the window again.");
        if (Identities.Count >= 64 && !Identities.ContainsKey(normalized)) throw new InvalidOperationException("Reconnect window sharing before selecting more windows");
        Identities[normalized] = Tuple.Create(targetPid, started, rootId);
        var title = new StringBuilder(1024);
        GetWindowText(handle, title, title.Capacity);
        if (Lifetime.Require(handle) != generation) throw new InvalidOperationException("The selected window changed while validating");
        return new DesktopTarget { Handle = handle, Pid = targetPid, Title = title.ToString(), Started = started, Generation = generation, Minimized = IsIconic(handle) };
    }

    internal void Same(DesktopTarget selected)
    {
        var current = Resolve(selected.Id, selected.Pid);
        if (current.Started != selected.Started || current.Generation != selected.Generation)
            throw new InvalidOperationException("The selected application window was replaced");
    }

    internal bool FastCurrent(DesktopTarget target)
    {
        try
        {
            uint pid;
            var thread = GetWindowThreadProcessId(target.Handle, out pid);
            if (pid != target.Pid || thread == 0 || !IsWindow(target.Handle) || IsIconic(target.Handle)
                || DesktopNative.GetForegroundWindow() != target.Handle || Lifetime.Require(target.Handle) != target.Generation) return false;
            RequireUserDesktop(thread);
            return true;
        }
        catch { return false; }
    }

    internal bool OwnerAlive()
    {
        try { using (var owner = Process.GetProcessById(OwnerPid)) return !owner.HasExited && owner.StartTime.ToUniversalTime().Ticks == OwnerStarted; }
        catch { return false; }
    }

    internal bool GrantForeground(int helper)
    {
        uint foregroundPid;
        var thread = GetWindowThreadProcessId(DesktopNative.GetForegroundWindow(), out foregroundPid);
        if (thread == 0 || foregroundPid != OwnerPid || !OwnerAlive()) return false;
        RequireUserDesktop(thread);
        RequireUserProcess(helper);
        if (!string.Equals(ProcessPath(helper), ProcessPath(HelperPid), StringComparison.OrdinalIgnoreCase)) return false;
        // A fresh child of the foreground owner can delegate activation to its
        // long-lived helper. No focus or input is changed by this grant.
        return AllowSetForegroundWindow((uint)helper);
    }

    public void Dispose() { Lifetime.Dispose(); }
}
