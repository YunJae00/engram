using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class SessionPlatform
{
    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSIsChildSessionsEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSEnableChildSessions([MarshalAs(UnmanagedType.Bool)] bool enabled);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSGetChildSessionId(out uint session);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSLogoffSession(IntPtr server, uint session, [MarshalAs(UnmanagedType.Bool)] bool wait);

    public static int Current { get { return Process.GetCurrentProcess().SessionId; } }

    public static bool Enabled()
    {
        bool enabled;
        if (!WTSIsChildSessionsEnabled(out enabled)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return enabled;
    }

    public static int Child()
    {
        uint session;
        if (!WTSGetChildSessionId(out session))
        {
            int code = Marshal.GetLastWin32Error();
            if (code == 1168) return -1;
            throw new Win32Exception(code);
        }
        return session == UInt32.MaxValue ? -1 : checked((int)session);
    }

    public static void RequireHostedRunner()
    {
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
            || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
            throw new InvalidOperationException("Session provisioning is limited to disposable hosted CI runners.");
        if (Current == 0) throw new InvalidOperationException("An interactive parent session is required.");
    }

    public static void SetEnabled(bool enabled)
    {
        RequireHostedRunner();
        if (!WTSEnableChildSessions(enabled)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (Enabled() != enabled) throw new InvalidOperationException("The child-session state did not change.");
    }

    public static void LogOffOwned(int child)
    {
        RequireHostedRunner();
        if (child <= 0 || child == Current || Child() != child)
            throw new InvalidOperationException("The child-session ownership check failed during cleanup.");
        if (!WTSLogoffSession(IntPtr.Zero, (uint)child, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
