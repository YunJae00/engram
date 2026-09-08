using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class FixtureDefaultDacl
{
    private const uint All = 0x001F0003;
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr value, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr value, int length);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AccessCheck(IntPtr descriptor, IntPtr token, uint desired, ref Mapping mapping, IntPtr privileges, ref uint size, out uint granted, out bool allowed);
    [DllImport("advapi32.dll")] private static extern void MapGenericMask(ref uint mask, ref Mapping mapping);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] private struct Mapping { internal uint Read, Write, Execute, All; }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    private static void Native(bool condition, string operation)
    {
        if (!condition) throw new InvalidOperationException(operation + " failed (" + Marshal.GetLastWin32Error() + ")");
    }
    private static byte[] Read(IntPtr token)
    {
        int needed;
        GetTokenInformation(token, 6, IntPtr.Zero, 0, out needed);
        Require(needed >= IntPtr.Size && needed <= 131072, "Default token DACL is unavailable");
        var value = Marshal.AllocHGlobal(needed);
        try
        {
            Native(GetTokenInformation(token, 6, value, needed, out needed), "GetTokenInformation(default DACL)");
            var acl = Marshal.ReadIntPtr(value);
            if (acl == IntPtr.Zero) return null;
            var offset = acl.ToInt64() - value.ToInt64();
            Require(offset >= IntPtr.Size && offset <= needed - 8, "Default token DACL pointer is invalid");
            var length = (ushort)Marshal.ReadInt16(acl, 2);
            Require(length >= 8 && offset + length <= needed, "Default token DACL length is invalid");
            var bytes = new byte[length];
            Marshal.Copy(acl, bytes, 0, length);
            return bytes;
        }
        finally { Marshal.FreeHGlobal(value); }
    }
    private static uint ModeledRights(IntPtr primary, SecurityIdentifier user, byte[] bytes)
    {
        var mapping = new Mapping { Read = 0x00020001, Write = 0x00020002, Execute = 0x00120000, All = All };
        var acl = bytes == null ? null : new RawAcl(bytes, 0);
        if (acl != null)
        {
            foreach (GenericAce entry in acl)
            {
                var known = entry as KnownAce;
                Require(known != null, "Unsupported default token DACL entry");
                var mask = unchecked((uint)known.AccessMask);
                MapGenericMask(ref mask, ref mapping);
                known.AccessMask = unchecked((int)mask);
            }
        }
        var descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent | ControlFlags.SelfRelative, user, user, null, acl);
        var serialized = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(serialized, 0);
        var buffer = Marshal.AllocHGlobal(serialized.Length);
        var privileges = Marshal.AllocHGlobal(4096);
        IntPtr token = IntPtr.Zero;
        try
        {
            Marshal.Copy(serialized, 0, buffer, serialized.Length);
            Native(DuplicateTokenEx(primary, 8, IntPtr.Zero, 2, 2, out token), "DuplicateTokenEx(default DACL probe)");
            uint length = 4096, granted;
            bool allowed;
            Native(AccessCheck(buffer, token, 0x02000000, ref mapping, privileges, ref length, out granted, out allowed), "AccessCheck(default DACL probe)");
            return allowed ? granted : 0;
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            Marshal.FreeHGlobal(privileges);
            Marshal.FreeHGlobal(buffer);
        }
    }
    private static void SetOwnedDefault(IntPtr restricted, SecurityIdentifier user)
    {
        var acl = new RawSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;" + user.Value + ")").DiscretionaryAcl;
        var bytes = new byte[acl.BinaryLength];
        acl.GetBinaryForm(bytes, 0);
        var buffer = Marshal.AllocHGlobal(IntPtr.Size + bytes.Length);
        try
        {
            var address = IntPtr.Add(buffer, IntPtr.Size);
            Marshal.Copy(bytes, 0, address, bytes.Length);
            Marshal.WriteIntPtr(buffer, address);
            Native(SetTokenInformation(restricted, 6, buffer, IntPtr.Size), "SetTokenInformation(new restricted default DACL)");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static void EnsureOwnedDefaults(IntPtr source, IntPtr restricted, string userSid, string[] deniedGroups, string logs)
    {
        Require(Environment.GetEnvironmentVariable("CI") == "true" && Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true", "Default fixture token setup requires isolated CI");
        Require(source != restricted && source != IntPtr.Zero && restricted != IntPtr.Zero, "A distinct restricted token is required");
        RestrictedFixtureToken.Verify(restricted, deniedGroups);
        var user = new SecurityIdentifier(userSid);
        var original = Read(source);
        var before = ModeledRights(restricted, user, Read(restricted));
        var tailored = (before & All) != All;
        if (tailored) SetOwnedDefault(restricted, user);
        var after = ModeledRights(restricted, user, Read(restricted));
        var sourceAfter = Read(source);
        var unchanged = original == null ? sourceAfter == null : sourceAfter != null && original.SequenceEqual(sourceAfter);
        RestrictedFixtureToken.Verify(restricted, deniedGroups);
        var result = "{\"scope\":\"modeled-self-owned-event-default-dacl\",\"includesMandatoryIntegrityPolicy\":false,\"requiredMask\":\"0x001F0003\",\"beforeMask\":\"0x" + before.ToString("X8") + "\",\"afterMask\":\"0x" + after.ToString("X8") + "\",\"newRestrictedDefaultTailored\":" + (tailored ? "true" : "false") + ",\"originalCallerDefaultUnchanged\":" + (unchanged ? "true" : "false") + "}\n";
        File.WriteAllText(Path.Combine(logs, "token-default-access.json"), result, new UTF8Encoding(false));
        Require(unchanged, "The caller default token DACL changed unexpectedly");
        Require((after & All) == All, "The restricted default DACL does not grant modeled self access");
    }
}
