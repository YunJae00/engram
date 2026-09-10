using System;
using System.Runtime.InteropServices;

internal sealed class RemotePasswordScan : IDisposable
{
    private static readonly Guid OperationId = new Guid("3ac656f4-e2bc-5c6e-b8e7-b224fb74b060");
    private static readonly Guid ElementId = new Guid("a1898370-2c07-56fd-993f-61a72a08058c");
    private static readonly Guid ResultId = new Guid("e0f80c42-4a67-5534-bf5a-09e8a99b36b1");
    private static readonly Guid PropertyId = new Guid("4bd682dd-7554-40e9-9a9b-82654ede7e62");
    private bool Initialized;
    internal string Diagnostic = "start";

    [DllImport("combase.dll")] private static extern int RoInitialize(uint type);
    [DllImport("combase.dll")] private static extern void RoUninitialize();
    [DllImport("combase.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int WindowsCreateString(string value, uint length, out IntPtr text);
    [DllImport("combase.dll")] private static extern int WindowsDeleteString(IntPtr text);
    [DllImport("combase.dll")] private static extern int RoActivateInstance(IntPtr name, out IntPtr instance);

    // WinRT interfaces have six IUnknown/IInspectable slots. Native delegates avoid
    // a Windows SDK metadata or runtime projection dependency in the packaged helper.
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int Supported(IntPtr self, uint opcode, out byte supported);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int Import(IntPtr self, int operand, IntPtr element);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int AddResult(IntPtr self, int operand);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int Execute(IntPtr self, uint length,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] byte[] code, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ReadInt(IntPtr self, out int value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int HasOperand(IntPtr self, int operand, out byte present);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetOperand(IntPtr self, int operand, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ReadBool(IntPtr self, out byte value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ReadUInt(IntPtr self, out uint value);

    private static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
    private static void Release(IntPtr value) { if (value != IntPtr.Zero) Marshal.Release(value); }
    private static T Method<T>(IntPtr instance, int slot) where T : class
    {
        if (instance == IntPtr.Zero) throw new InvalidOperationException("Remote scan interface is unavailable");
        var method = Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(method, typeof(T));
    }
    private static IntPtr Query(IntPtr instance, Guid id)
    {
        IntPtr value;
        var status = Marshal.QueryInterface(instance, ref id, out value);
        if (status < 0) { Release(value); Check(status); }
        if (value == IntPtr.Zero) throw new InvalidOperationException("Remote scan interface is unavailable");
        return value;
    }

    private static uint Value(IntPtr result, RemoteScanProgram.Operand operand, bool boolean)
    {
        byte present;
        Check(Method<HasOperand>(result, 9)(result, (int)operand, out present));
        if (present != 1) throw new InvalidOperationException("Remote scan result is incomplete");
        var boxed = IntPtr.Zero;
        var property = IntPtr.Zero;
        try
        {
            Check(Method<GetOperand>(result, 10)(result, (int)operand, out boxed));
            if (boxed == IntPtr.Zero) throw new InvalidOperationException("Remote scan result is unavailable");
            property = Query(boxed, PropertyId);
            int type;
            Check(Method<ReadInt>(property, 6)(property, out type));
            if (type != (boolean ? 11 : 5)) throw new InvalidOperationException("Remote scan result type is invalid");
            if (boolean)
            {
                byte value;
                Check(Method<ReadBool>(property, 18)(property, out value));
                if (value > 1) throw new InvalidOperationException("Remote scan boolean is invalid");
                return value;
            }
            uint number;
            Check(Method<ReadUInt>(property, 12)(property, out number));
            return number;
        }
        finally { Release(property); Release(boxed); }
    }

    internal bool TryScan(object root, int pid, out bool password)
    {
        password = false;
        var name = IntPtr.Zero;
        var instance = IntPtr.Zero;
        var operation = IntPtr.Zero;
        var unknown = IntPtr.Zero;
        var element = IntPtr.Zero;
        var returned = IntPtr.Zero;
        var result = IntPtr.Zero;
        try
        {
            Diagnostic = "initialize";
            if (!Initialized) { Check(RoInitialize(1)); Initialized = true; }
            const string runtimeClass = "Windows.UI.UIAutomation.Core.CoreAutomationRemoteOperation";
            Check(WindowsCreateString(runtimeClass, (uint)runtimeClass.Length, out name));
            Diagnostic = "activate";
            Check(RoActivateInstance(name, out instance));
            if (instance == IntPtr.Zero) return false;
            operation = Query(instance, OperationId);
            Diagnostic = "rootIUnknown";
            unknown = Marshal.GetIUnknownForObject(root);
            Diagnostic = "rootWinRTQuery";
            element = Query(unknown, ElementId);
            Diagnostic = "importElement";
            Check(Method<Import>(operation, 7)(operation, (int)RemoteScanProgram.Operand.Root, element));
            foreach (var opcode in RemoteScanProgram.Opcodes)
            {
                byte supported;
                Check(Method<Supported>(operation, 6)(operation, opcode, out supported));
                if (supported != 1) { Diagnostic = "opcode." + opcode; return false; }
            }
            foreach (var operand in new[] { RemoteScanProgram.Operand.Found, RemoteScanProgram.Operand.Complete,
                RemoteScanProgram.Operand.Reason, RemoteScanProgram.Operand.Nodes, RemoteScanProgram.Operand.MaxDepth })
                Check(Method<AddResult>(operation, 9)(operation, (int)operand));
            var code = RemoteScanProgram.Build(pid);
            Diagnostic = "execute";
            Check(Method<Execute>(operation, 10)(operation, (uint)code.Length, code, out returned));
            if (returned == IntPtr.Zero) return false;
            result = Query(returned, ResultId);
            int status;
            Check(Method<ReadInt>(result, 6)(result, out status));
            if (status != 0) { Diagnostic = "status." + status; return false; }
            Diagnostic = "coverage";
            var complete = Value(result, RemoteScanProgram.Operand.Complete, true);
            var reason = Value(result, RemoteScanProgram.Operand.Reason, false);
            if (complete != 1 || reason != 0) { Diagnostic = "coverage." + reason; return false; }
            var nodes = Value(result, RemoteScanProgram.Operand.Nodes, false);
            var depth = Value(result, RemoteScanProgram.Operand.MaxDepth, false);
            var found = Value(result, RemoteScanProgram.Operand.Found, true) == 1;
            if (nodes > RemoteScanProgram.NodeLimit || depth > RemoteScanProgram.DepthLimit
                || (nodes == 0 ? depth != 0 || found : depth == 0 || depth > nodes)) return false;
            password = found;
            return true;
        }
        // Failure only selects the fresh full native query; it never clears protection.
        catch (COMException error) { Diagnostic += ".hr." + error.ErrorCode.ToString("X8"); return false; }
        catch (InvalidCastException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (EntryPointNotFoundException) { return false; }
        catch (DllNotFoundException) { return false; }
        finally
        {
            Release(result); Release(returned); Release(element); Release(unknown);
            Release(operation); Release(instance);
            if (name != IntPtr.Zero) WindowsDeleteString(name);
        }
    }

    public void Dispose()
    {
        if (Initialized) { RoUninitialize(); Initialized = false; }
    }
}
