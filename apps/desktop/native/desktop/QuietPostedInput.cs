using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;

internal static class QuietPostedInput
{
    [StructLayout(LayoutKind.Sequential)] private struct Point { internal int X, Y; }
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

    internal static IntPtr ClientPoint(Rect bounds, double originX, double originY)
    {
        if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidOperationException("The control has no background input bounds");
        var x = Math.Floor(bounds.X + bounds.Width / 2 - originX);
        var y = Math.Floor(bounds.Y + bounds.Height / 2 - originY);
        if (double.IsNaN(x) || double.IsNaN(y) || x < short.MinValue || x > short.MaxValue || y < short.MinValue || y > short.MaxValue)
            throw new InvalidOperationException("The control has invalid client coordinates");
        return new IntPtr(unchecked((int)(((uint)(ushort)(short)y << 16) | (ushort)(short)x)));
    }
    private static IntPtr Destination(DesktopTarget target, AutomationElement element, Action check)
    {
        check();
        if (IsIconic(target.Handle)) throw new InvalidOperationException("The window is minimized; no action was sent");
        var info = element.Current;
        if (info.IsPassword || !info.IsEnabled || info.IsOffscreen || !DesktopNative.Bounds(target.Handle).Contains(info.BoundingRectangle))
            throw new InvalidOperationException("The control is unavailable or protected");
        var window = new IntPtr(unchecked((long)(uint)info.NativeWindowHandle));
        if (window == IntPtr.Zero) window = ChromiumAccessibility.RendererWindow(target.Handle);
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid != target.Pid || DesktopNative.GetAncestor(window, 2) != target.Handle)
            throw new InvalidOperationException("The background input window changed");
        return window;
    }
    private static void Post(IntPtr window, uint message, IntPtr wparam, IntPtr lparam)
    {
        if (!PostMessage(window, message, wparam, lparam)) throw new InvalidOperationException("Background input could not be posted; read the app before retrying");
    }
    internal static IntPtr Click(DesktopTarget target, AutomationElement element, Action check)
    {
        var window = Destination(target, element, check);
        var origin = new Point();
        if (!ScreenToClient(window, ref origin)) throw new InvalidOperationException("Background client coordinates are unavailable");
        var point = ClientPoint(element.Current.BoundingRectangle, -origin.X, -origin.Y);
        if (Destination(target, element, check) != window) throw new InvalidOperationException("The background input window changed");
        Post(window, 0x0201, new IntPtr(1), point);
        Post(window, 0x0202, IntPtr.Zero, point);
        return window;
    }
    internal static void Text(DesktopTarget target, AutomationElement element, string text, Action check)
    {
        var window = Click(target, element, check);
        foreach (var character in text) {
            if (Destination(target, element, check) != window) throw new InvalidOperationException("The background input window changed");
            Post(window, 0x0102, new IntPtr(character), new IntPtr(1));
        }
    }
}
