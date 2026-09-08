using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

internal sealed class WindowLifetime : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] private struct Point { internal int X; internal int Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Message
    {
        internal IntPtr Window;
        internal uint Id;
        internal UIntPtr WParam;
        internal IntPtr LParam;
        internal uint Time;
        internal Point Point;
        internal uint Private;
    }
    private delegate void WindowEvent(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint start, uint end, IntPtr module, WindowEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private readonly object Sync = new object();
    private readonly Dictionary<IntPtr, long> Selected = new Dictionary<IntPtr, long>();
    private readonly HashSet<IntPtr> Destroyed = new HashSet<IntPtr>();
    private readonly WindowEvent Callback;
    private long Generation;
    private Thread Thread;
    private uint ThreadId;
    private volatile bool Available;

    internal WindowLifetime()
    {
        Callback = OnWindowEvent;
        var ready = new ManualResetEventSlim(false);
        var available = false;
        var thread = new Thread(delegate()
        {
            ThreadId = GetCurrentThreadId();
            var hook = SetWinEventHook(0x8001, 0x8001, IntPtr.Zero, Callback, 0, 0, 2);
            available = hook != IntPtr.Zero;
            Available = available;
            ready.Set();
            if (!available) return;
            try
            {
                Message message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) DispatchMessage(ref message);
            }
            finally { Available = false; UnhookWinEvent(hook); }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.MTA);
        Thread = thread;
        thread.Start();
        if (!ready.Wait(2000) || !available) throw new InvalidOperationException("Window lifetime monitoring is unavailable");
    }

    private void OnWindowEvent(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint thread, uint time)
    {
        if (eventType != 0x8001 || objectId != 0 || childId != 0) return;
        lock (Sync) { if (Selected.ContainsKey(hwnd)) Destroyed.Add(hwnd); }
    }

    internal long Select(IntPtr window)
    {
        lock (Sync)
        {
            if (Selected.Count >= 64 && !Selected.ContainsKey(window)) throw new InvalidOperationException("Reconnect window sharing before selecting more windows");
            Selected[window] = ++Generation;
            Destroyed.Remove(window);
            return Generation;
        }
    }

    internal long Require(IntPtr window)
    {
        if (!Available || !Thread.IsAlive) throw new InvalidOperationException("Window lifetime monitoring is unavailable");
        lock (Sync)
        {
            long generation;
            if (!Selected.TryGetValue(window, out generation)) throw new InvalidOperationException("Select this window before reading it");
            if (Destroyed.Contains(window)) throw new InvalidOperationException("The selected window was closed or replaced. Select it again.");
            return generation;
        }
    }

    public void Dispose()
    {
        Available = false;
        if (ThreadId != 0) PostThreadMessage(ThreadId, 0x12, UIntPtr.Zero, IntPtr.Zero);
        if (Thread != null) Thread.Join(1000);
    }
}
