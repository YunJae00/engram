using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class RestrictedFixtureToken
{
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr value, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr disabled, uint deleteCount, IntPtr deleted, uint restrictedCount, IntPtr restricted, out IntPtr created);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr value, int length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeValue(string system, string name, out Luid value);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] private struct SidEntry { internal IntPtr Sid; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct Luid { internal uint Low; internal int High; }
    [StructLayout(LayoutKind.Sequential)] private struct PrivilegeEntry { internal Luid Id; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct GroupHeader { internal uint Count; internal SidEntry First; }
    [StructLayout(LayoutKind.Sequential)] private struct PrivilegeHeader { internal uint Count; internal PrivilegeEntry First; }
    private sealed class Group { internal SidEntry Entry; internal string Name; }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    private static void Native(bool condition, string operation)
    {
        if (!condition) throw new InvalidOperationException(operation + " failed (" + Marshal.GetLastWin32Error() + ")");
    }
    private static IntPtr Information(IntPtr token, int kind)
    {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        Require(needed > 0 && needed <= 65536, "Restricted token information is unavailable");
        var value = Marshal.AllocHGlobal(needed);
        try { Native(GetTokenInformation(token, kind, value, needed, out needed), "GetTokenInformation(restricted)"); return value; }
        catch { Marshal.FreeHGlobal(value); throw; }
    }
    private static int Scalar(IntPtr token, int kind)
    {
        var value = Information(token, kind);
        try { return Marshal.ReadInt32(value); }
        finally { Marshal.FreeHGlobal(value); }
    }
    private static List<Group> Groups(IntPtr buffer)
    {
        var count = Marshal.ReadInt32(buffer);
        Require(count > 0 && count <= 1024, "Restricted token group count is invalid");
        var result = new List<Group>();
        var offset = Marshal.OffsetOf(typeof(GroupHeader), "First").ToInt32();
        var size = Marshal.SizeOf(typeof(SidEntry));
        for (var index = 0; index < count; index++)
        {
            var entry = (SidEntry)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + size * index), typeof(SidEntry));
            result.Add(new Group { Entry = entry, Name = new SecurityIdentifier(entry.Sid).Value });
        }
        return result;
    }
    private static List<PrivilegeEntry> Privileges(IntPtr token)
    {
        var buffer = Information(token, 3);
        try
        {
            var count = Marshal.ReadInt32(buffer);
            Require(count >= 0 && count <= 128, "Restricted token privilege count is invalid");
            var result = new List<PrivilegeEntry>();
            var offset = Marshal.OffsetOf(typeof(PrivilegeHeader), "First").ToInt32();
            var size = Marshal.SizeOf(typeof(PrivilegeEntry));
            for (var index = 0; index < count; index++) result.Add((PrivilegeEntry)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + index * size), typeof(PrivilegeEntry)));
            return result;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    private static bool Administrative(Group group)
    {
        if ((group.Entry.Attributes & 8) != 0) return true;
        var name = group.Name;
        if (name.StartsWith("S-1-5-32-", StringComparison.Ordinal))
        {
            var rid = name.Substring(9);
            return rid == "544" || rid == "547" || rid == "548" || rid == "549" || rid == "550" || rid == "551" || rid == "552";
        }
        if (!name.StartsWith("S-1-5-21-", StringComparison.Ordinal)) return false;
        var last = name.Substring(name.LastIndexOf('-') + 1);
        return last == "512" || last == "518" || last == "519" || last == "520";
    }
    private static bool SamePrivilege(Luid left, Luid right) { return left.Low == right.Low && left.High == right.High; }
    private static void MediumOnly(IntPtr token)
    {
        var current = Information(token, 25);
        try
        {
            var name = new SecurityIdentifier(Marshal.ReadIntPtr(current)).Value;
            var level = 0;
            Require(name.StartsWith("S-1-16-", StringComparison.Ordinal) && int.TryParse(name.Substring(7), out level), "Restricted fixture integrity cannot be identified");
            Require(level >= 8192, "Restricted fixture integrity cannot be increased");
            if (level == 8192) return;
        }
        finally { Marshal.FreeHGlobal(current); }
        var identity = new SecurityIdentifier("S-1-16-8192");
        var sid = new byte[identity.BinaryLength];
        identity.GetBinaryForm(sid, 0);
        var labelSize = Marshal.SizeOf(typeof(SidEntry));
        var buffer = Marshal.AllocHGlobal(labelSize + sid.Length);
        try
        {
            var address = IntPtr.Add(buffer, labelSize);
            Marshal.Copy(sid, 0, address, sid.Length);
            Marshal.StructureToPtr(new SidEntry { Sid = address, Attributes = 0x20 }, buffer, false);
            Native(SetTokenInformation(token, 25, buffer, labelSize + sid.Length), "SetTokenInformation(restricted medium integrity)");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static void Verify(IntPtr token, string[] requiredDeniedGroups)
    {
        Require(Scalar(token, 8) == 1, "Restricted fixture token is not primary");
        Require(Scalar(token, 20) == 0, "Restricted fixture token remains elevated");
        Require(Scalar(token, 26) == 0, "Restricted fixture token retains UIAccess");
        Require(Scalar(token, 15) == 0, "Restricted fixture token cannot bypass application policy");
        Luid notify;
        Native(LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out notify), "LookupPrivilegeValue");
        foreach (var privilege in Privileges(token)) Require(SamePrivilege(privilege.Id, notify), "Restricted fixture token retains an extra privilege");
        var buffer = Information(token, 2);
        try
        {
            var denied = new HashSet<string>(StringComparer.Ordinal);
            foreach (var group in Groups(buffer))
            {
                var attributes = group.Entry.Attributes;
                if ((attributes & 0x10) != 0 && (attributes & 6) == 0) denied.Add(group.Name);
                if (Administrative(group)) Require(denied.Contains(group.Name), "Restricted fixture token retains an administrative group");
            }
            foreach (var name in requiredDeniedGroups) Require(denied.Contains(name), "Restricted fixture token lost an expected deny-only group");
        }
        finally { Marshal.FreeHGlobal(buffer); }
        var integrity = Information(token, 25);
        try { Require(new SecurityIdentifier(Marshal.ReadIntPtr(integrity)).Value == "S-1-16-8192", "Restricted fixture token is not medium integrity"); }
        finally { Marshal.FreeHGlobal(integrity); }
    }
    internal static IntPtr Create(IntPtr source, string logs, out string[] requiredDeniedGroups)
    {
        Require(Environment.GetEnvironmentVariable("CI") == "true" && Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true", "Restricted fixture token creation requires isolated CI");
        Require(Scalar(source, 8) == 1 && Scalar(source, 18) == 1 && Scalar(source, 20) == 1 && Scalar(source, 26) == 0 && Scalar(source, 15) == 0, "Only an unsplit elevated CI token can be reduced");
        IntPtr groups = IntPtr.Zero, disabled = IntPtr.Zero, deleted = IntPtr.Zero, created = IntPtr.Zero;
        requiredDeniedGroups = new string[0];
        try
        {
            groups = Information(source, 2);
            var disable = Groups(groups).FindAll(Administrative);
            Require(disable.Exists(group => group.Name == "S-1-5-32-544"), "The source has no identifiable administrator group");
            requiredDeniedGroups = disable.ConvertAll(group => group.Name).ToArray();
            var groupSize = Marshal.SizeOf(typeof(SidEntry));
            disabled = Marshal.AllocHGlobal(groupSize * disable.Count);
            for (var index = 0; index < disable.Count; index++) Marshal.StructureToPtr(disable[index].Entry, IntPtr.Add(disabled, groupSize * index), false);
            Luid notify;
            Native(LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out notify), "LookupPrivilegeValue");
            var remove = Privileges(source).FindAll(privilege => !SamePrivilege(privilege.Id, notify));
            var privilegeSize = Marshal.SizeOf(typeof(PrivilegeEntry));
            if (remove.Count > 0)
            {
                deleted = Marshal.AllocHGlobal(privilegeSize * remove.Count);
                for (var index = 0; index < remove.Count; index++) Marshal.StructureToPtr(remove[index], IntPtr.Add(deleted, privilegeSize * index), false);
            }
            Native(CreateRestrictedToken(source, 4, (uint)disable.Count, disabled, (uint)remove.Count, deleted, 0, IntPtr.Zero, out created), "CreateRestrictedToken(LUA)");
            MediumOnly(created);
            Verify(created, requiredDeniedGroups);
            File.WriteAllText(Path.Combine(logs, "restricted-token.json"), "{\"adminGroupsDenyOnly\":true,\"deniedGroupCount\":" + disable.Count + ",\"deletedPrivilegeCount\":" + remove.Count + ",\"elevated\":0,\"uiAccess\":0,\"integrity\":8192,\"sandboxInert\":0}\n", new UTF8Encoding(false));
            var result = created;
            created = IntPtr.Zero;
            return result;
        }
        finally
        {
            if (created != IntPtr.Zero) CloseHandle(created);
            if (deleted != IntPtr.Zero) Marshal.FreeHGlobal(deleted);
            if (disabled != IntPtr.Zero) Marshal.FreeHGlobal(disabled);
            if (groups != IntPtr.Zero) Marshal.FreeHGlobal(groups);
        }
    }
}
