using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class FixtureAccessProbe
{
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int kind, StringBuilder name, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AccessCheck(IntPtr descriptor, IntPtr token, uint desired, ref Mapping mapping, IntPtr privileges, ref uint size, out uint granted, out bool allowed);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] private struct Mapping { internal uint Read, Write, Execute, All; }

    private static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\""; }
    private static string Bool(bool value) { return value ? "true" : "false"; }
    private static string Name(IntPtr handle)
    {
        var value = new StringBuilder(256);
        int needed;
        return handle != IntPtr.Zero && GetUserObjectInformation(handle, 2, value, value.Capacity * 2, out needed) ? value.ToString() : "unavailable";
    }
    private static string Rights(IntPtr descriptor, IntPtr primary, Mapping mapping, uint specific)
    {
        IntPtr token;
        if (!DuplicateTokenEx(primary, 8, IntPtr.Zero, 2, 2, out token)) return "{\"error\":" + Marshal.GetLastWin32Error() + "}";
        var privileges = Marshal.AllocHGlobal(4096);
        try
        {
            uint length = 4096, granted;
            bool allowed;
            var succeeded = AccessCheck(descriptor, token, 0x02000000, ref mapping, privileges, ref length, out granted, out allowed);
            var error = succeeded && allowed ? 0 : Marshal.GetLastWin32Error();
            return "{\"checkSucceeded\":" + Bool(succeeded) + ",\"allowed\":" + Bool(succeeded && allowed) + ",\"grantedMask\":\"0x" + (succeeded ? granted : 0).ToString("X8") + "\",\"specificRightsAllowed\":" + Bool(succeeded && allowed && (granted & specific) == specific) + ",\"fullRightsAllowed\":" + Bool(succeeded && allowed && (granted & mapping.All) == mapping.All) + ",\"error\":" + error + "}";
        }
        finally { Marshal.FreeHGlobal(privileges); CloseHandle(token); }
    }
    private static string ObjectAccess(IntPtr handle, int type, IntPtr current, IntPtr restricted, Mapping mapping, uint specific)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        var error = GetSecurityInfo(handle, type, 7, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) return "{\"securityReadError\":" + error + "}";
        try { return "{\"specificMask\":\"0x" + specific.ToString("X8") + "\",\"current\":" + Rights(descriptor, current, mapping, specific) + ",\"restricted\":" + Rights(descriptor, restricted, mapping, specific) + "}"; }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    internal static void Surfaces(IntPtr current, IntPtr restricted, string logs)
    {
        var station = GetProcessWindowStation();
        var desktop = GetThreadDesktop(GetCurrentThreadId());
        var stationMap = new Mapping { Read = 0x20303, Write = 0x2001C, Execute = 0x20060, All = 0xF037F };
        var desktopMap = new Mapping { Read = 0x20041, Write = 0x200BE, Execute = 0x20100, All = 0xF01FF };
        var result = "{\"scope\":\"discretionary-access-only\",\"includesMandatoryIntegrityPolicy\":false,\"windowStationName\":" + Quote(Name(station)) + ",\"desktopName\":" + Quote(Name(desktop)) + ",\"windowStation\":" + ObjectAccess(station, 7, current, restricted, stationMap, 0x37F) + ",\"desktop\":" + ObjectAccess(desktop, 7, current, restricted, desktopMap, 0x1FF) + "}\n";
        File.WriteAllText(Path.Combine(logs, "surface-access.json"), result, new UTF8Encoding(false));
    }
    internal static void OwnedProcess(IntPtr process, IntPtr thread, IntPtr current, IntPtr restricted, string logs, bool explicitOwnedSecurity)
    {
        var mapping = new Mapping { Read = 0x20410, Write = 0x20BEB, Execute = 0x120000, All = 0x1FFFFF };
        var threadMapping = new Mapping { Read = 0x20048, Write = 0x203B3, Execute = 0x120000, All = 0x1FFFFF };
        var result = "{\"scope\":\"discretionary-access-only\",\"includesMandatoryIntegrityPolicy\":false,\"explicitOwnedObjectSecurity\":" + Bool(explicitOwnedSecurity) + ",\"ownedProcess\":" + ObjectAccess(process, 6, current, restricted, mapping, 0x1410) + ",\"ownedThread\":" + ObjectAccess(thread, 6, current, restricted, threadMapping, 0x848) + "}\n";
        File.WriteAllText(Path.Combine(logs, "process-access.json"), result, new UTF8Encoding(false));
    }
    internal static void Stage(string logs, string stage, uint pid, uint? exit)
    {
        var result = "{\"stage\":" + Quote(stage) + ",\"pid\":" + pid + ",\"suspendedCreation\":true,\"jobKillOnClose\":true";
        if (exit.HasValue) result += ",\"exitCode\":" + exit.Value + ",\"exitHex\":\"0x" + exit.Value.ToString("X8") + "\"";
        File.WriteAllText(Path.Combine(logs, "child-launch.json"), result + "}\n", new UTF8Encoding(false));
    }
}
