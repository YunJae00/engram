using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

internal sealed class FixtureTokenSecurity : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] internal struct Attributes
    {
        internal int Size; internal IntPtr Descriptor; internal int Inherit;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr data, int size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr token, uint access, ref Attributes attributes, int level, int kind, out IntPtr copy);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    private IntPtr Descriptor;

    internal FixtureTokenSecurity(string user)
    {
        uint size;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor("O:" + user + "D:P(A;;GA;;;SY)(A;;GA;;;" + user + ")", 1, out Descriptor, out size), "Create fixture object security");
    }

    internal IntPtr CopyWithDefaults(IntPtr source)
    {
        var attributes = ForChild();
        IntPtr token;
        Check(DuplicateTokenEx(source, 0, ref attributes, 2, 1, out token), "Copy reduced fixture token");
        var defaults = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            bool present, defaulted;
            IntPtr dacl;
            Check(GetSecurityDescriptorDacl(Descriptor, out present, out dacl, out defaulted), "Read fixture object security");
            if (!present || dacl == IntPtr.Zero) throw new InvalidOperationException("Fixture object security requires an explicit DACL");
            Marshal.WriteIntPtr(defaults, dacl);
            // A reduced child still needs access to its own new kernel objects.
            Check(SetTokenInformation(token, 6, defaults, IntPtr.Size), "Set fixture default object security");
            return token;
        }
        catch { CloseHandle(token); throw; }
        finally { Marshal.FreeHGlobal(defaults); }
    }

    internal Attributes ForChild()
    {
        return new Attributes { Size = Marshal.SizeOf(typeof(Attributes)), Descriptor = Descriptor };
    }

    public void Dispose()
    {
        if (Descriptor != IntPtr.Zero) { LocalFree(Descriptor); Descriptor = IntPtr.Zero; }
    }

    private static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }
}
