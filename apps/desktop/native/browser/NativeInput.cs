using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal sealed class NativeInput : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint Size; public uint Tick; }
    [StructLayout(LayoutKind.Sequential)] private struct GuiInfo
    {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public int Left, Top, Right, Bottom;
    }
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
    private readonly Timer timer = new Timer { Interval = 200 };
    private uint tick;

    internal NativeInput(Dictionary<string, NativeView> views, Action<string> touched)
    {
        timer.Tick += delegate
        {
            var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
            if (!GetLastInputInfo(ref input) || input.Tick == tick) return;
            tick = input.Tick;
            var info = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
            if (!GetGUIThreadInfo(0, ref info)) return;
            foreach (var pair in views)
            {
                if (pair.Value.IsDisposed) continue;
                if (info.Focus == pair.Value.Handle || IsChild(pair.Value.Handle, info.Focus))
                {
                    touched(pair.Key);
                    break;
                }
            }
        };
        timer.Start();
    }

    public void Dispose() { timer.Dispose(); }
}
