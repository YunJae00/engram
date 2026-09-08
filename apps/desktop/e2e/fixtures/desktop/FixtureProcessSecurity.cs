using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

internal sealed class FixtureProcessSecurity : IDisposable
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    private struct Attributes { internal int Length; internal IntPtr Descriptor; internal int Inherit; }
    private IntPtr Descriptor;
    private IntPtr Buffer;
    internal IntPtr Pointer { get { return Buffer; } }

    internal FixtureProcessSecurity(string user)
    {
        if (Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true")
            throw new InvalidOperationException("Owned fixture object creation requires isolated CI");
        var sid = new SecurityIdentifier(user).Value;
        var text = "O:" + sid + "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")";
        try
        {
            uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(text, 1, out Descriptor, out size))
                throw new InvalidOperationException("Owned fixture security descriptor failed (" + Marshal.GetLastWin32Error() + ")");
            var attributes = new Attributes { Length = Marshal.SizeOf(typeof(Attributes)), Descriptor = Descriptor, Inherit = 0 };
            Buffer = Marshal.AllocHGlobal(attributes.Length);
            Marshal.StructureToPtr(attributes, Buffer, false);
        }
        catch { Dispose(); throw; }
    }
    public void Dispose()
    {
        if (Buffer != IntPtr.Zero) { Marshal.FreeHGlobal(Buffer); Buffer = IntPtr.Zero; }
        if (Descriptor != IntPtr.Zero) { LocalFree(Descriptor); Descriptor = IntPtr.Zero; }
    }
}
