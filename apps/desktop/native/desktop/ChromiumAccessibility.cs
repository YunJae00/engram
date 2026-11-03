using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

internal static class ChromiumAccessibility
{
    private delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr id, IntPtr objectId, uint flags, uint timeout, out UIntPtr result);

    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr window, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible result);

    internal static bool IsCold(string className, ObservationTree tree)
    {
        if (className != "Chrome_WidgetWin_1" || tree.Truncated || tree.Nodes.Count > 32) return false;
        foreach (var node in tree.Nodes) {
            var type = node.Element.Current.ControlType;
            if (type == ControlType.Document || type == ControlType.Text) return false;
        }
        return true;
    }
    internal static void Wake(IntPtr window)
    {
        var renderer = IntPtr.Zero;
        EnumChildWindows(window, delegate(IntPtr child, IntPtr data) {
            var name = new StringBuilder(64);
            GetClassName(child, name, name.Capacity);
            if (name.ToString() != "Chrome_RenderWidgetHostHWND") return true;
            renderer = child;
            return false;
        }, IntPtr.Zero);
        UIntPtr result;
        var target = renderer == IntPtr.Zero ? window : renderer;
        // Chromium compares lParam with its screen-reader honeypot id.
        SendMessageTimeout(target, 0x003d, UIntPtr.Zero, new IntPtr(1), 2, 250, out result);
        var iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        Accessibility.IAccessible accessible;
        if (AccessibleObjectFromWindow(target, 0xfffffffc, ref iid, out accessible) != 0 || accessible == null) return;
        try {
            try { accessible.get_accName(0); } catch (COMException) { }
            try { int count = accessible.accChildCount; } catch (COMException) { }
        } finally { Marshal.ReleaseComObject(accessible); }
    }
}
