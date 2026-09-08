using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal sealed class WorkerInput
{
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput
    {
        internal int X;
        internal int Y;
        internal uint Data;
        internal uint Flags;
        internal uint Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput
    {
        internal ushort Key;
        internal ushort Scan;
        internal uint Flags;
        internal uint Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit)] private struct InputData
    {
        [FieldOffset(0)] internal MouseInput Mouse;
        [FieldOffset(0)] internal KeyboardInput Keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Input
    {
        internal uint Type;
        internal InputData Data;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Rect
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);

    private readonly int ParentSession;
    private readonly int ChildSession;
    private readonly int ProcessId;
    private readonly Form Window;

    internal static void RequireSession(int parentSession, int expectedChildSession)
    {
        using (var process = Process.GetCurrentProcess())
        {
            if (parentSession < 0 || expectedChildSession <= 0 || expectedChildSession == parentSession || process.SessionId != expectedChildSession)
                throw new InvalidOperationException("Fixture input requires the verified child session, separate from the parent session");
        }
    }

    internal WorkerInput(Form window, int parentSession, int childSession)
    {
        RequireSession(parentSession, childSession);
        Window = window;
        ParentSession = parentSession;
        ChildSession = childSession;
        using (var process = Process.GetCurrentProcess()) ProcessId = process.Id;
    }

    private static string DesktopName(IntPtr desktop)
    {
        var value = new StringBuilder(256);
        int needed;
        if (desktop == IntPtr.Zero || !GetUserObjectInformation(desktop, 2, value, value.Capacity * 2, out needed))
            throw new InvalidOperationException("Cannot verify the worker input desktop");
        return value.ToString();
    }

    private void RequireOwnedDesktop()
    {
        RequireSession(ParentSession, ChildSession);
        if (Window.IsDisposed || !Window.IsHandleCreated || !Window.Visible)
            throw new InvalidOperationException("The worker fixture window is not available");
        uint process;
        if (GetWindowThreadProcessId(Window.Handle, out process) == 0 || process != ProcessId)
            throw new InvalidOperationException("The worker fixture window is not owned by this process");
        var input = OpenInputDesktop(0, false, 1);
        try
        {
            if (DesktopName(input) != "Default" || DesktopName(GetThreadDesktop(GetCurrentThreadId())) != "Default")
                throw new InvalidOperationException("Input is allowed only on the worker's normal desktop");
        }
        finally { if (input != IntPtr.Zero) CloseDesktop(input); }
    }

    internal void Activate()
    {
        RequireOwnedDesktop();
        if (GetForegroundWindow() != Window.Handle && !SetForegroundWindow(Window.Handle))
            throw new InvalidOperationException("The worker fixture could not become active");
    }

    internal void RequireForeground()
    {
        RequireOwnedDesktop();
        if (GetForegroundWindow() != Window.Handle)
            throw new InvalidOperationException("Input stopped because another worker window became active");
    }

    private void Send(params Input[] inputs)
    {
        RequireForeground();
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Worker input was not fully delivered");
    }

    private void Move(Point point)
    {
        RequireForeground();
        var client = Window.RectangleToScreen(Window.ClientRectangle);
        var screen = SystemInformation.VirtualScreen;
        if (!client.Contains(point) || !screen.Contains(point) || screen.Width < 2 || screen.Height < 2)
            throw new InvalidOperationException("Pointer input must remain inside the worker fixture");
        Send(new Input { Type = 0, Data = new InputData { Mouse = new MouseInput {
            X = (int)Math.Round((point.X - screen.Left) * 65535.0 / (screen.Width - 1)),
            Y = (int)Math.Round((point.Y - screen.Top) * 65535.0 / (screen.Height - 1)),
            Flags = 0x0001 | 0x4000 | 0x8000
        } } });
    }

    internal void Click(Point point)
    {
        Move(point);
        Send(new Input { Type = 0, Data = new InputData { Mouse = new MouseInput { Flags = 0x0002 } } },
            new Input { Type = 0, Data = new InputData { Mouse = new MouseInput { Flags = 0x0004 } } });
    }

    internal void Type(string text)
    {
        foreach (var character in text)
        {
            Send(new Input { Type = 1, Data = new InputData { Keyboard = new KeyboardInput { Scan = character, Flags = 0x0004 } } },
                new Input { Type = 1, Data = new InputData { Keyboard = new KeyboardInput { Scan = character, Flags = 0x0004 | 0x0002 } } });
        }
    }

    internal void Wheel(Point point, int delta)
    {
        Move(point);
        Send(new Input { Type = 0, Data = new InputData { Mouse = new MouseInput { Data = unchecked((uint)delta), Flags = 0x0800 } } });
    }

    internal Size ClientSize()
    {
        RequireForeground();
        Rect bounds;
        if (!GetClientRect(Window.Handle, out bounds)) throw new InvalidOperationException("Cannot read the worker window size");
        return new Size(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
    }
}
