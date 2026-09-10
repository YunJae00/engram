using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;

internal sealed class PasswordScan : IDisposable
{
    [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Client
    {
        [PreserveSig] int CompareElements(IntPtr first, IntPtr second, out int same);
        [PreserveSig] int CompareRuntimeIds(IntPtr first, IntPtr second, out int same);
        [PreserveSig] int GetRootElement(out Element root);
        [PreserveSig] int ElementFromHandle(IntPtr window, out Element element);
        [PreserveSig] int ElementFromPoint(DesktopNative.Point point, out Element element);
        [PreserveSig] int GetFocusedElement(out Element element);
        [PreserveSig] int GetRootElementBuildCache(IntPtr cache, out Element root);
        [PreserveSig] int ElementFromHandleBuildCache(IntPtr window, IntPtr cache, out Element element);
        [PreserveSig] int ElementFromPointBuildCache(DesktopNative.Point point, IntPtr cache, out Element element);
        [PreserveSig] int GetFocusedElementBuildCache(IntPtr cache, out Element element);
        [PreserveSig] int CreateTreeWalker(IntPtr condition, out IntPtr walker);
        [PreserveSig] int GetControlViewWalker(out IntPtr walker);
        [PreserveSig] int GetContentViewWalker(out IntPtr walker);
        [PreserveSig] int GetRawViewWalker(out IntPtr walker);
        [PreserveSig] int GetRawViewCondition(out IntPtr condition);
        [PreserveSig] int GetControlViewCondition(out IntPtr condition);
        [PreserveSig] int GetContentViewCondition(out IntPtr condition);
        [PreserveSig] int CreateCacheRequest(out IntPtr cache);
        [PreserveSig] int CreateTrueCondition(out IntPtr condition);
        [PreserveSig] int CreateFalseCondition(out IntPtr condition);
        [PreserveSig] int CreatePropertyCondition(int property, [MarshalAs(UnmanagedType.Struct)] object value, out IntPtr condition);
        [PreserveSig] int CreatePropertyConditionEx(int property, [MarshalAs(UnmanagedType.Struct)] object value, int flags, out IntPtr condition);
        [PreserveSig] int CreateAndCondition(IntPtr first, IntPtr second, out IntPtr condition);
    }

    [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Element
    {
        [PreserveSig] int SetFocus();
        [PreserveSig] int GetRuntimeId(out IntPtr runtime);
        [PreserveSig] int FindFirst(int scope, IntPtr condition, out IntPtr found);
    }

    private Client Automation;
    private IntPtr Condition;
    private bool Unavailable;
    private readonly RemotePasswordScan Remote = new RemotePasswordScan();

    private static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
    private static void Release(object value)
    { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }

    private bool Initialize()
    {
        if (Unavailable) return false;
        if (Condition != IntPtr.Zero) return true;
        object instance = null;
        IntPtr password = IntPtr.Zero, visible = IntPtr.Zero, condition = IntPtr.Zero;
        try
        {
            try { instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true)); }
            catch (COMException error)
            {
                if (error.ErrorCode != unchecked((int)0x80040154)) throw;
                Unavailable = true;
                return false;
            }
            var client = (Client)instance;
            Check(client.CreatePropertyCondition(AutomationElement.IsPasswordProperty.Id, true, out password));
            Check(client.CreatePropertyCondition(AutomationElement.IsOffscreenProperty.Id, false, out visible));
            if (password == IntPtr.Zero || visible == IntPtr.Zero) throw new InvalidOperationException("Password scan conditions are unavailable");
            Check(client.CreateAndCondition(password, visible, out condition));
            if (condition == IntPtr.Zero) throw new InvalidOperationException("The password scan condition is unavailable");
            Automation = client;
            Condition = condition;
            condition = IntPtr.Zero;
            instance = null;
            return true;
        }
        finally
        {
            if (password != IntPtr.Zero) Marshal.Release(password);
            if (visible != IntPtr.Zero) Marshal.Release(visible);
            if (condition != IntPtr.Zero) Marshal.Release(condition);
            Release(instance);
        }
    }

    internal bool HasVisiblePassword(IntPtr window, AutomationElement fallbackRoot, int expectedPid)
    {
        if (!Initialize()) return fallbackRoot.FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.IsPasswordProperty, true),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false))) != null;
        Element root = null;
        var found = IntPtr.Zero;
        try
        {
            Check(Automation.ElementFromHandle(window, out root));
            if (root == null) throw new InvalidOperationException("The password scan window is unavailable");
            bool password;
            if (Remote.TryScan(root, expectedPid, out password)) return password;
            Check(root.FindFirst((int)TreeScope.Descendants, Condition, out found));
            return found != IntPtr.Zero;
        }
        finally
        {
            if (found != IntPtr.Zero) Marshal.Release(found);
            Release(root);
        }
    }

    public void Dispose()
    {
        if (Condition != IntPtr.Zero) { Marshal.Release(Condition); Condition = IntPtr.Zero; }
        Release(Automation);
        Automation = null;
        Remote.Dispose();
    }
}
