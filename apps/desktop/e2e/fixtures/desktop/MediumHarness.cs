using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class MediumHarness
{
    private const int LimitMs = 180000;
    private const uint TokenRights = 0x008B;
    private const uint Suspended = 0x00000004;
    private const uint UnicodeEnvironment = 0x00000400;
    private const uint NoWindow = 0x08000000;
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr value, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application, StringBuilder arguments, uint creationFlags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string application, StringBuilder arguments, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool assigned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal int Size;
        internal string Reserved, Desktop, Title;
        internal uint X, Y, Width, Height, XCount, YCount, Fill, Flags;
        internal ushort Show, ReservedLength;
        internal IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { internal IntPtr Process, Thread; internal uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        internal long ProcessTime, JobTime;
        internal uint Flags;
        internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        internal uint ActiveProcesses;
        internal UIntPtr Affinity;
        internal uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        internal BasicLimits Basic;
        internal IoCounters Io;
        internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    private sealed class TokenState
    {
        internal string Sid;
        internal int Session, ElevationType, Elevated, UiAccess, Integrity;
        internal bool Standard { get { return Elevated == 0 && UiAccess == 0 && Integrity == 0x2000; } }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    private static void Native(bool succeeded, string operation)
    {
        if (!succeeded) throw new InvalidOperationException(operation + " failed (" + Marshal.GetLastWin32Error() + ")");
    }
    private static IntPtr Information(IntPtr token, int kind)
    {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        Require(needed > 0 && needed <= 65536, "Token information is unavailable");
        var value = Marshal.AllocHGlobal(needed);
        try { Native(GetTokenInformation(token, kind, value, needed, out needed), "GetTokenInformation"); return value; }
        catch { Marshal.FreeHGlobal(value); throw; }
    }
    private static int Scalar(IntPtr token, int kind)
    {
        var value = Information(token, kind);
        try { return Marshal.ReadInt32(value); }
        finally { Marshal.FreeHGlobal(value); }
    }
    private static TokenState Inspect(IntPtr token)
    {
        var result = new TokenState { Session = Scalar(token, 12), ElevationType = Scalar(token, 18), Elevated = Scalar(token, 20), UiAccess = Scalar(token, 26) };
        var user = Information(token, 1);
        try { result.Sid = new SecurityIdentifier(Marshal.ReadIntPtr(user)).Value; }
        finally { Marshal.FreeHGlobal(user); }
        var integrity = Information(token, 25);
        try
        {
            var sid = Marshal.ReadIntPtr(integrity);
            var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            Require(count > 0, "Token integrity is unavailable");
            result.Integrity = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        }
        finally { Marshal.FreeHGlobal(integrity); }
        return result;
    }
    private static void SameUser(TokenState source, TokenState target)
    {
        Require(target.Sid == source.Sid && target.Session == source.Session && target.Session != 0, "The limited token belongs to another user or session");
        Require(target.Standard, "The child requires a non-elevated medium-integrity token without UIAccess");
    }
    private static string ExistingPath(string path, bool directory)
    {
        Require(Path.IsPathRooted(path), "Fixture paths must be absolute");
        var full = Path.GetFullPath(path);
        Require(directory ? Directory.Exists(full) : File.Exists(full), "A required fixture path does not exist");
        for (var current = full; !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "Fixture paths cannot contain links");
            if (current == Path.GetPathRoot(current)) break;
        }
        return full;
    }
    private static string Quoted(string value)
    {
        Require(value.IndexOfAny(new[] { '"', '\r', '\n' }) < 0 && !value.EndsWith("\\", StringComparison.Ordinal), "Invalid fixture argument");
        return "\"" + value + "\"";
    }
    private static string LogDirectory(string repository, string supplied)
    {
        var temporary = Path.Combine(repository, "tmp");
        Directory.CreateDirectory(temporary);
        ExistingPath(temporary, true);
        if (supplied != null)
        {
            var full = ExistingPath(supplied, true);
            Require(string.Equals(Path.GetDirectoryName(full), temporary, StringComparison.OrdinalIgnoreCase) && Path.GetFileName(full).StartsWith("desktop-medium-ci-", StringComparison.Ordinal), "Invalid fixture output directory");
            return full;
        }
        var created = Path.Combine(temporary, "desktop-medium-ci-" + Guid.NewGuid().ToString("D"));
        Directory.CreateDirectory(created);
        return created;
    }
    private static int RunHarness(string node, string repository, string logs)
    {
        var script = ExistingPath(Path.Combine(repository, "apps", "desktop", "scripts", "test-desktop-native.mjs"), false);
        var start = new ProcessStartInfo(node, Quoted(script)) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = repository, RedirectStandardOutput = true, RedirectStandardError = true };
        start.EnvironmentVariables["ENGRAM_DESKTOP_MEDIUM_CHILD"] = "true";
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
        var sync = new object();
        var written = 0;
        using (var log = new StreamWriter(new FileStream(Path.Combine(logs, "harness.log"), FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false)))
        using (var child = new Process { StartInfo = start })
        {
            DataReceivedEventHandler receive = delegate(object sender, DataReceivedEventArgs line)
            {
                if (line.Data == null) return;
                lock (sync)
                {
                    if (written >= 4 * 1024 * 1024) return;
                    var bounded = line.Data.Length > 32768 ? line.Data.Substring(0, 32768) : line.Data;
                    log.WriteLine(bounded); log.Flush(); written += bounded.Length;
                }
            };
            child.OutputDataReceived += receive; child.ErrorDataReceived += receive;
            Require(child.Start(), "The owned Node harness did not start");
            child.BeginOutputReadLine(); child.BeginErrorReadLine();
            if (!child.WaitForExit(LimitMs)) { child.Kill(); throw new InvalidOperationException("The owned Node harness timed out"); }
            child.WaitForExit();
            return child.ExitCode;
        }
    }
    private static void RequireOwnedJob(string name, int session)
    {
        var prefix = "Local\\EngramDesktopFixture-" + session + "-";
        Guid id;
        Require(name.StartsWith(prefix, StringComparison.Ordinal) && Guid.TryParse(name.Substring(prefix.Length), out id), "Invalid fixture job identity");
        var job = OpenJobObject(4, false, name);
        Native(job != IntPtr.Zero, "OpenJobObject");
        try
        {
            bool assigned;
            using (var process = Process.GetCurrentProcess()) Native(IsProcessInJob(process.Handle, job, out assigned), "IsProcessInJob");
            Require(assigned, "The fixture child is not confined to its owned job");
        }
        finally { CloseHandle(job); }
    }
    private static int LaunchConfined(IntPtr currentToken, TokenState current, string node, string repository, string logs)
    {
        IntPtr linked = IntPtr.Zero, primary = IntPtr.Zero, job = IntPtr.Zero, environment = IntPtr.Zero;
        var created = new ProcessInfo();
        var assigned = false;
        string[] requiredDeniedGroups = null;
        try
        {
            if (!current.Standard)
            {
                if (current.ElevationType == 1)
                    primary = RestrictedFixtureToken.Create(currentToken, logs, out requiredDeniedGroups);
                else
                {
                    Require(current.ElevationType == 2, "No supported limited CI token is available");
                    var linkedInfo = Information(currentToken, 19);
                    linked = Marshal.ReadIntPtr(linkedInfo);
                    Marshal.FreeHGlobal(linkedInfo);
                    Require(linked != IntPtr.Zero, "No existing linked limited token is available");
                    var state = Inspect(linked);
                    SameUser(current, state);
                    Require(state.ElevationType == 3, "The linked token is not a limited token");
                    Native(DuplicateTokenEx(linked, TokenRights, IntPtr.Zero, 2, 1, out primary), "DuplicateTokenEx");
                }
                SameUser(current, Inspect(primary));
            }
            var jobName = "Local\\EngramDesktopFixture-" + current.Session + "-" + Guid.NewGuid().ToString("D");
            job = CreateJobObject(IntPtr.Zero, jobName);
            Native(job != IntPtr.Zero, "CreateJobObject");
            var limits = new JobLimits { Basic = new BasicLimits { Flags = 0x2000 } };
            Native(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))), "SetInformationJobObject");
            var executable = ExistingPath(Assembly.GetExecutingAssembly().Location, false);
            var command = new StringBuilder(Quoted(executable) + " --medium-child " + Quoted(node) + " " + Quoted(repository) + " " + Quoted(logs) + " " + Quoted(jobName));
            Require(command.Length < 1024, "The fixture command is too long");
            var values = new System.Collections.Generic.List<string>();
            foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) values.Add((string)entry.Key + "=" + (string)entry.Value);
            values.Sort(StringComparer.OrdinalIgnoreCase);
            environment = Marshal.StringToHGlobalUni(string.Join("\0", values.ToArray()) + "\0\0");
            var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Desktop = "WinSta0\\Default" };
            if (current.Standard)
                Native(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, Suspended | UnicodeEnvironment | NoWindow, environment, repository, ref startup, out created), "CreateProcessW");
            else
                Native(CreateProcessWithTokenW(primary, 0, executable, command, Suspended | UnicodeEnvironment | NoWindow, environment, repository, ref startup, out created), "CreateProcessWithTokenW");
            Native(AssignProcessToJobObject(job, created.Process), "AssignProcessToJobObject");
            assigned = true;
            IntPtr childToken;
            Native(OpenProcessToken(created.Process, 8, out childToken), "OpenProcessToken(child)");
            try
            {
                SameUser(current, Inspect(childToken));
                if (requiredDeniedGroups != null) RestrictedFixtureToken.Verify(childToken, requiredDeniedGroups);
            }
            finally { CloseHandle(childToken); }
            Native(ResumeThread(created.Thread) != uint.MaxValue, "ResumeThread");
            Require(WaitForSingleObject(created.Process, LimitMs + 15000) == 0, "The limited fixture launcher timed out");
            uint code;
            Native(GetExitCodeProcess(created.Process, out code), "GetExitCodeProcess");
            return unchecked((int)code);
        }
        finally
        {
            if (assigned) TerminateJobObject(job, 1);
            else if (created.Process != IntPtr.Zero) TerminateProcess(created.Process, 1);
            if (created.Thread != IntPtr.Zero) CloseHandle(created.Thread);
            if (created.Process != IntPtr.Zero) CloseHandle(created.Process);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (primary != IntPtr.Zero) CloseHandle(primary);
            if (linked != IntPtr.Zero) CloseHandle(linked);
        }
    }
    private static int Main(string[] args)
    {
        string logs = null;
        try
        {
            Require(Environment.GetEnvironmentVariable("CI") == "true" && Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true", "The limited fixture launcher requires an isolated Windows CI runner");
            var nested = args.Length == 5 && args[0] == "--medium-child";
            Require(nested || args.Length == 2, "Expected the absolute Node executable and repository directory");
            var node = ExistingPath(args[nested ? 1 : 0], false);
            Require(string.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase), "Only the owned Node fixture harness is supported");
            var repository = ExistingPath(args[nested ? 2 : 1], true);
            ExistingPath(Path.Combine(repository, "apps", "desktop", "scripts", "test-desktop-native.mjs"), false);
            logs = LogDirectory(repository, nested ? args[3] : null);
            IntPtr token;
            using (var process = Process.GetCurrentProcess()) Native(OpenProcessToken(process.Handle, TokenRights, out token), "OpenProcessToken");
            try
            {
                var state = Inspect(token);
                Require(state.Session != 0, "An interactive CI session is required");
                if (nested)
                {
                    Require(state.Standard, "The limited child did not inherit a standard token");
                    RequireOwnedJob(args[4], state.Session);
                }
                File.WriteAllText(Path.Combine(logs, nested ? "child-token.json" : "parent-token.json"),
                    "{\"elevationType\":" + state.ElevationType + ",\"elevated\":" + state.Elevated + ",\"uiAccess\":" + state.UiAccess + ",\"integrity\":" + state.Integrity + ",\"session\":" + state.Session + "}\n", new UTF8Encoding(false));
                var code = nested ? RunHarness(node, repository, logs) : LaunchConfined(token, state, node, repository, logs);
                if (!nested)
                {
                    var log = Path.Combine(logs, "harness.log");
                    if (File.Exists(log)) Console.Write(File.ReadAllText(log));
                    var failure = Path.Combine(logs, "launcher-error.txt");
                    if (File.Exists(failure)) Console.Error.WriteLine(File.ReadAllText(failure));
                    Console.WriteLine("Native medium-integrity CI evidence: " + logs);
                }
                return code;
            }
            finally { CloseHandle(token); }
        }
        catch (Exception error)
        {
            var message = "Native limited fixture failed: " + error.Message;
            if (logs != null) File.WriteAllText(Path.Combine(logs, "launcher-error.txt"), message, new UTF8Encoding(false));
            Console.Error.WriteLine(message);
            return 1;
        }
    }
}
