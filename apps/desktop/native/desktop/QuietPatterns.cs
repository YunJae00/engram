using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

internal static class QuietPatterns
{
    // UIAutomationClient.h: IUIAutomation has 55 methods before IUIAutomation2's focus setting.
    [ComImport, Guid("34723aff-0c9d-49d0-9896-7ab52df8cd8a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Client2
    {
        void _VtblGap1_55();
        [PreserveSig] int GetAutoSetFocus(out int enabled);
        [PreserveSig] int SetAutoSetFocus(int enabled);
    }
    [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Element
    {
        void _VtblGap1_7();
        [PreserveSig] int GetCurrentPropertyValue(int property, [MarshalAs(UnmanagedType.Struct)] out object value);
        void _VtblGap2_5();
        [PreserveSig] int GetCurrentPattern(int pattern, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    }
    [ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Value { [PreserveSig] int SetValue([MarshalAs(UnmanagedType.LPWStr)] string text); }
    [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Invoke { [PreserveSig] int Press(); }
    [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Toggle { [PreserveSig] int Press(); }
    [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Selection { [PreserveSig] int Select(); }
    [ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Fold { [PreserveSig] int Expand(); [PreserveSig] int Collapse(); }

    private static void Release(object value)
    { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }

    private static void Run(DesktopTarget target, AutomationElement observed, int patternId, Func<object, int> act, Action check)
    {
        object client = null, element = null, pattern = null;
        PasswordScan.Element root = null;
        IntPtr condition = IntPtr.Zero, found = IntPtr.Zero;
        try
        {
            client = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true));
            var options = (Client2)client;
            Marshal.ThrowExceptionForHR(options.SetAutoSetFocus(0));
            int enabled;
            Marshal.ThrowExceptionForHR(options.GetAutoSetFocus(out enabled));
            if (enabled != 0) throw new InvalidOperationException("Background provider focus could not be disabled");
            var automation = (PasswordScan.Client)client;
            Marshal.ThrowExceptionForHR(automation.ElementFromHandle(target.Handle, out root));
            Marshal.ThrowExceptionForHR(automation.CreatePropertyCondition(AutomationElement.RuntimeIdProperty.Id, observed.GetRuntimeId(), out condition));
            Marshal.ThrowExceptionForHR(root.FindFirst((int)TreeScope.Subtree, condition, out found));
            if (found == IntPtr.Zero) throw new InvalidOperationException("The control changed. Read the app again");
            element = Marshal.GetObjectForIUnknown(found);
            var current = (Element)element;
            object password, name, type;
            Marshal.ThrowExceptionForHR(current.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty.Id, out password));
            Marshal.ThrowExceptionForHR(current.GetCurrentPropertyValue(AutomationElement.NameProperty.Id, out name));
            Marshal.ThrowExceptionForHR(current.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty.Id, out type));
            if (!(password is bool) || (bool)password || !Equals(name, observed.Current.Name) || !Equals(type, observed.Current.ControlType.Id))
                throw new InvalidOperationException("The control changed or is protected. Read the app again");
            Marshal.ThrowExceptionForHR(current.GetCurrentPattern(patternId, out pattern));
            if (pattern == null) throw new InvalidOperationException("This control does not support background input");
            check();
            Marshal.ThrowExceptionForHR(act(pattern));
        }
        finally
        {
            Release(pattern); Release(element); Release(root);
            if (found != IntPtr.Zero) Marshal.Release(found);
            if (condition != IntPtr.Zero) Marshal.Release(condition);
            Release(client);
        }
    }

    internal static void Set(DesktopTarget target, AutomationElement element, string text, Action check)
    { Run(target, element, ValuePattern.Pattern.Id, pattern => ((Value)pattern).SetValue(text), check); }

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);

    private static bool PressNativeButton(DesktopTarget target, AutomationElement element, Action check)
    {
        if (element.Current.ControlType != ControlType.Button) return false;
        var window = new IntPtr(unchecked((long)(uint)element.Current.NativeWindowHandle));
        if (window == IntPtr.Zero) return false;
        var name = new StringBuilder(256);
        if (GetClassName(window, name, name.Capacity) == 0) return false;
        var cls = name.ToString();
        if (cls != "Button" && !cls.StartsWith("WindowsForms10.BUTTON.", StringComparison.Ordinal)) return false;
        check();
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid != target.Pid || DesktopNative.GetAncestor(window, 2) != target.Handle || element.Current.NativeWindowHandle != unchecked((int)window.ToInt64()))
            throw new InvalidOperationException("The button changed. Read the app again");
        // Legacy button accessibility providers focus explicitly; BM_CLICK invokes that same button without synthetic keyboard or pointer input.
        UIntPtr result;
        if (SendMessageTimeout(window, 0x00F5, UIntPtr.Zero, IntPtr.Zero, 2, 1500, out result) == IntPtr.Zero)
            throw new InvalidOperationException("The button did not acknowledge its action. Read the app before any further action");
        return true;
    }

    internal static void Press(DesktopTarget target, AutomationElement element, string how, Action check)
    {
        if (how == "invoke" && PressNativeButton(target, element, check)) return;
        if (how == "invoke") Run(target, element, InvokePattern.Pattern.Id, pattern => ((Invoke)pattern).Press(), check);
        else if (how == "toggle") Run(target, element, TogglePattern.Pattern.Id, pattern => ((Toggle)pattern).Press(), check);
        else if (how == "select") Run(target, element, SelectionItemPattern.Pattern.Id, pattern => ((Selection)pattern).Select(), check);
        else Run(target, element, ExpandCollapsePattern.Pattern.Id, pattern => how == "collapse" ? ((Fold)pattern).Collapse() : ((Fold)pattern).Expand(), check);
    }
}
