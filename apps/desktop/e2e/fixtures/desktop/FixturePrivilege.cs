using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class FixturePrivilege
{
    private const string ChildMarker = "--medium-child";
    private const uint MediumIntegrity = 8192;
    [StructLayout(LayoutKind.Sequential)] private struct SidAttributes { internal IntPtr Sid; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        internal int Size; internal string Reserved; internal string Desktop; internal string Title;
        internal uint X; internal uint Y; internal uint Width; internal uint Height;
        internal uint XChars; internal uint YChars; internal uint Fill; internal uint Flags;
        internal short Show; internal short ReservedSize; internal IntPtr ReservedBytes;
        internal IntPtr Input; internal IntPtr Output; internal IntPtr Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { internal StartupInfo Startup; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { internal IntPtr Process; internal IntPtr Thread; internal uint Pid; internal uint Tid; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        internal long ProcessTime; internal long JobTime; internal uint Flags;
        internal UIntPtr MinimumWorkingSet; internal UIntPtr MaximumWorkingSet; internal uint ActiveProcesses;
        internal UIntPtr Affinity; internal uint Priority; internal uint Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters
    {
        internal ulong ReadCount; internal ulong WriteCount; internal ulong OtherCount;
        internal ulong ReadBytes; internal ulong WriteBytes; internal ulong OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    {
        internal BasicLimits Basic; internal IoCounters Io;
        internal UIntPtr ProcessMemory; internal UIntPtr JobMemory; internal UIntPtr PeakProcessMemory; internal UIntPtr PeakJobMemory;
    }
    private sealed class Facts
    {
        internal uint Elevation; internal uint Integrity; internal uint UiAccess; internal string User;
        internal void VerifyMedium()
        {
            if (Elevation != 0 || Integrity != MediumIntegrity || UiAccess != 0)
                throw new InvalidOperationException("Fixture requires an un-elevated medium-integrity token without UI access");
        }
    }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int required);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr data, int size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount, IntPtr disabled, uint deletedCount, IntPtr deleted, uint restrictedCount, IntPtr restricted, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSidToSid(string text, out IntPtr sid);
    [DllImport("advapi32.dll")] private static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    internal static object Report()
    {
        var token = OpenOwnToken(8);
        try
        {
            var facts = ReadFacts(token);
            return new { elevated = facts.Elevation != 0, integrity = facts.Integrity, uiAccess = facts.UiAccess != 0 };
        }
        finally { CloseHandle(token); }
    }

    internal static int? Bootstrap(string[] args)
    {
        var token = OpenOwnToken(8);
        try
        {
            var facts = ReadFacts(token);
            if (Array.IndexOf(args, ChildMarker) >= 0) { facts.VerifyMedium(); return null; }
            if (facts.UiAccess != 0) throw new InvalidOperationException("UI-access fixture tokens are unsupported");
            if (facts.Elevation == 0 && facts.Integrity == MediumIntegrity) return null;
            if (facts.Elevation == 0 && facts.Integrity < MediumIntegrity)
                throw new InvalidOperationException("The fixture launcher cannot increase integrity");
        }
        finally { CloseHandle(token); }
        return LaunchRestricted(args);
    }

    private static IntPtr OpenOwnToken(uint access)
    {
        IntPtr token;
        using (var process = Process.GetCurrentProcess())
            Check(OpenProcessToken(process.Handle, access, out token), "Open fixture token");
        return token;
    }

    private static IntPtr ReadToken(IntPtr token, int kind)
    {
        int required;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out required);
        if (required <= 0 || required > 65536) throw new InvalidOperationException("Invalid fixture token information");
        var data = Marshal.AllocHGlobal(required);
        try { Check(GetTokenInformation(token, kind, data, required, out required), "Read fixture token"); return data; }
        catch { Marshal.FreeHGlobal(data); throw; }
    }

    private static uint ReadNumber(IntPtr token, int kind)
    {
        var data = ReadToken(token, kind);
        try { return unchecked((uint)Marshal.ReadInt32(data)); }
        finally { Marshal.FreeHGlobal(data); }
    }

    private static string ReadSid(IntPtr token, int kind)
    {
        var data = ReadToken(token, kind);
        try { return new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; }
        finally { Marshal.FreeHGlobal(data); }
    }

    private static Facts ReadFacts(IntPtr token)
    {
        var integrity = ReadSid(token, 25).Split('-');
        return new Facts { Elevation = ReadNumber(token, 20), UiAccess = ReadNumber(token, 26),
            Integrity = uint.Parse(integrity[integrity.Length - 1]), User = ReadSid(token, 1) };
    }

    private static void LowerToken(IntPtr token)
    {
        var user = ReadToken(token, 1);
        var owner = Marshal.AllocHGlobal(IntPtr.Size);
        IntPtr sid = IntPtr.Zero;
        var label = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAttributes)));
        try
        {
            Marshal.WriteIntPtr(owner, Marshal.ReadIntPtr(user));
            Check(SetTokenInformation(token, 4, owner, IntPtr.Size), "Set fixture token owner");
            Check(ConvertStringSidToSid("S-1-16-8192", out sid), "Create medium-integrity label");
            Marshal.StructureToPtr(new SidAttributes { Sid = sid, Attributes = 0x20 }, label, false);
            Check(SetTokenInformation(token, 25, label, Marshal.SizeOf(typeof(SidAttributes)) + (int)GetLengthSid(sid)), "Lower fixture integrity");
        }
        finally
        {
            if (sid != IntPtr.Zero) LocalFree(sid);
            Marshal.FreeHGlobal(label); Marshal.FreeHGlobal(owner); Marshal.FreeHGlobal(user);
        }
    }

    private static int LaunchRestricted(string[] args)
    {
        var source = OpenOwnToken(0x8B);
        IntPtr token = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        var process = new ProcessInfo();
        try
        {
            Check(CreateRestrictedToken(source, 0x5, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out token), "Reduce fixture token");
            LowerToken(token);
            var reduced = ReadFacts(token);
            reduced.VerifyMedium();
            if (reduced.User != ReadFacts(source).User) throw new InvalidOperationException("Fixture token changed user");
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "Create fixture lifetime job");
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))), "Configure fixture lifetime job");
            process = StartChild(token, args);
            Check(AssignProcessToJobObject(job, process.Process), "Attach fixture lifetime job");
            IntPtr actual;
            Check(OpenProcessToken(process.Process, 8, out actual), "Verify fixture child token");
            try
            {
                var child = ReadFacts(actual);
                child.VerifyMedium();
                if (child.User != reduced.User) throw new InvalidOperationException("Fixture child changed user");
            }
            finally { CloseHandle(actual); }
            Check(ResumeThread(process.Thread) != uint.MaxValue, "Start reduced fixture");
            Check(WaitForSingleObject(process.Process, uint.MaxValue) == 0, "Wait for reduced fixture");
            uint exitCode;
            Check(GetExitCodeProcess(process.Process, out exitCode), "Read fixture exit code");
            return unchecked((int)exitCode);
        }
        finally
        {
            if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 2); CloseHandle(process.Process); }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(source);
        }
    }

    private static ProcessInfo StartChild(IntPtr token, string[] args)
    {
        var handles = new[] { GetStdHandle(-10), GetStdHandle(-11), GetStdHandle(-12) };
        var oldFlags = new uint[3];
        var inherited = 0;
        IntPtr list = IntPtr.Zero;
        IntPtr values = IntPtr.Zero;
        var initialized = false;
        try
        {
            for (var index = 0; index < handles.Length; index++)
            {
                Check(GetHandleInformation(handles[index], out oldFlags[index]), "Read fixture pipe handle");
                Check(SetHandleInformation(handles[index], 1, 1), "Inherit fixture pipe handle");
                inherited++;
            }
            var size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == IntPtr.Zero) throw new InvalidOperationException("Cannot size fixture handle list");
            list = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list, 1, 0, ref size), "Create fixture handle list");
            initialized = true;
            values = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
            Marshal.Copy(handles, 0, values, handles.Length);
            Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), values, new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero), "Restrict fixture inherited handles");
            var startup = new StartupInfoEx { Attributes = list, Startup = new StartupInfo {
                Size = Marshal.SizeOf(typeof(StartupInfoEx)), Desktop = "WinSta0\\Default", Flags = 0x100,
                Input = handles[0], Output = handles[1], Error = handles[2] } };
            var executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
            var command = new StringBuilder(Quote(executable));
            foreach (var argument in args) command.Append(' ').Append(Quote(argument));
            command.Append(' ').Append(ChildMarker);
            ProcessInfo process;
            Check(CreateProcessAsUser(token, executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004,
                IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out process), "Launch reduced fixture");
            return process;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (values != IntPtr.Zero) Marshal.FreeHGlobal(values);
            for (var index = 0; index < inherited; index++) SetHandleInformation(handles[index], 1, oldFlags[index] & 1);
        }
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }
}
