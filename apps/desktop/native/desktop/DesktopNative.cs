using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;

internal static class DesktopNative
{
    [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct Rectangle { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct KeyboardHook { internal uint Key, Scan, Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct MouseHook { internal Point Point; internal uint Data, Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct MouseInput { internal int X, Y; internal uint Data, Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct KeyInput { internal ushort Key, Scan; internal uint Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputUnion
    {
        [FieldOffset(0)] internal MouseInput Mouse;
        [FieldOffset(0)] internal KeyInput Key;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Input { internal uint Type; internal InputUnion Value; }
    internal delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    private delegate bool EnumWindow(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetWindowsHookEx(int type, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] internal static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr hwnd, out Rectangle rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rectangle rect, int size);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetModuleHandle(string name);

    internal static void Dpi()
    {
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) throw new InvalidOperationException("Physical desktop coordinate support is unavailable");
    }
    internal static Rect Bounds(IntPtr window)
    {
        Rectangle rect;
        if (!GetWindowRect(window, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top)
            throw new InvalidOperationException("The selected window has no current visible bounds");
        return new Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }
    internal static Rect VisualBounds(IntPtr window)
    {
        Rectangle rect;
        if (DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(Rectangle))) != 0 || rect.Right <= rect.Left || rect.Bottom <= rect.Top)
            return Bounds(window);
        return new Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }
    internal static bool AtTarget(IntPtr window, int x, int y)
    {
        return GetForegroundWindow() == window && GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), 2) == window;
    }
    internal static void Foreground(DesktopTarget target)
    {
        if (GetForegroundWindow() != target.Handle) throw new InvalidOperationException("The selected application is no longer in the foreground");
    }
    internal static void AwaitForeground(DesktopTarget target)
    {
        UIntPtr result;
        // Cross-thread activation completes when the target services its queue.
        if (SendMessageTimeout(target.Handle, 0, UIntPtr.Zero, IntPtr.Zero, 2, 250, out result) == IntPtr.Zero)
            throw new InvalidOperationException("The app did not acknowledge foreground activation");
        var started = unchecked((uint)Environment.TickCount);
        while (GetForegroundWindow() != target.Handle && unchecked((uint)Environment.TickCount - started) < 250)
            System.Threading.Thread.Sleep(10);
        Foreground(target);
    }
    internal static void IdleKeys()
    {
        for (var key = 1; key < 255; key++)
            if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new InvalidOperationException("Release your keyboard and mouse before allowing control");
    }
    internal static List<object> List(WindowGuard guard)
    {
        var result = new List<object>();
        EnumWindow callback = delegate(IntPtr handle, IntPtr unused)
        {
            try
            {
                if (!guard.ListCandidate(handle)) return true;
                var target = guard.Resolve(handle.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture), 0);
                if (!string.IsNullOrWhiteSpace(target.Title))
                    result.Add(new { window = target.Id, pid = target.Pid, title = target.Title, minimized = target.Minimized, foreground = handle == GetForegroundWindow() });
            }
            catch (InvalidOperationException) { }
            catch (ArgumentException) { }
            catch (System.ComponentModel.Win32Exception) { }
            catch (System.Windows.Automation.ElementNotAvailableException) { }
            catch (COMException) { }
            return result.Count < 40;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return result;
    }
}
