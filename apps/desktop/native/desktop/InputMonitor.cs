using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

internal sealed class InputMonitor : IDisposable
{
    private readonly ControlLease Lease;
    internal readonly PacketGate Packets;
    private readonly DesktopNative.Hook KeyboardCallback;
    private readonly DesktopNative.Hook MouseCallback;
    private readonly Thread Loop;
    private readonly ManualResetEventSlim Ready = new ManualResetEventSlim(false);
    private ControlIndicator Indicator;
    private Mutex GlobalLease;
    private IntPtr Keyboard, Mouse;
    private bool OwnMutex;
    private Exception StartupError;
    private long Beat;
    private int Disposed;
    private long InterventionCount;
    private readonly System.Threading.Timer Watchdog;
    private readonly WindowGuard Guard;

    internal InputMonitor(ControlLease lease, WindowGuard guard)
    {
        Lease = lease;
        Guard = guard;
        Packets = new PacketGate(lease, target => Guard.FastCurrent(target));
        KeyboardCallback = OnKeyboard;
        MouseCallback = OnMouse;
        Loop = new Thread(Run) { IsBackground = true, Name = "Desktop input monitor" };
        Loop.SetApartmentState(ApartmentState.STA);
        Loop.Start();
        if (!Ready.Wait(3000) || StartupError != null)
            throw new InvalidOperationException("Desktop stop monitoring is unavailable", StartupError);
        Watchdog = new System.Threading.Timer(delegate
        {
            if (unchecked((uint)Environment.TickCount - (uint)Interlocked.Read(ref Beat)) > 500) Lease.Revoke("Desktop stop monitoring stalled");
            if (!Guard.OwnerAlive()) Lease.Revoke("The desktop owner exited");
            var state = Lease.State;
            if (state != null && !Lease.Valid(state)) Lease.Revoke("Desktop control expired");
            if (Lease.Valid(state) && !Guard.FastCurrent(state.Target)) Lease.Revoke("The selected window or desktop changed");
        }, null, 100, 100);
    }

    private void Run()
    {
        try
        {
            string sid;
            using (var user = WindowsIdentity.GetCurrent()) sid = user.User.Value;
            var session = Process.GetCurrentProcess().SessionId;
            GlobalLease = new Mutex(false, "Local\\EngramDesktopControl-" + session + "-" + sid);
            Indicator = new ControlIndicator(delegate { Lease.Revoke("Stopped by the user"); });
            var unused = Indicator.Handle;
            Rearm();
            Interlocked.Exchange(ref Beat, Environment.TickCount);
            var timer = new System.Windows.Forms.Timer { Interval = 50 };
            timer.Tick += delegate { Interlocked.Exchange(ref Beat, Environment.TickCount); };
            timer.Start();
            Ready.Set();
            Application.Run();
            timer.Dispose();
        }
        catch (Exception error) { StartupError = error; Ready.Set(); Lease.Revoke("Desktop stop monitoring failed"); }
        finally
        {
            if (Keyboard != IntPtr.Zero) DesktopNative.UnhookWindowsHookEx(Keyboard);
            if (Mouse != IntPtr.Zero) DesktopNative.UnhookWindowsHookEx(Mouse);
            if (OwnMutex) GlobalLease.ReleaseMutex();
            if (GlobalLease != null) GlobalLease.Dispose();
            if (Indicator != null) Indicator.Dispose();
        }
    }

    private void Rearm()
    {
        var keyboard = DesktopNative.SetWindowsHookEx(13, KeyboardCallback, DesktopNative.GetModuleHandle(null), 0);
        var mouse = DesktopNative.SetWindowsHookEx(14, MouseCallback, DesktopNative.GetModuleHandle(null), 0);
        if (keyboard == IntPtr.Zero || mouse == IntPtr.Zero)
        {
            if (keyboard != IntPtr.Zero) DesktopNative.UnhookWindowsHookEx(keyboard);
            if (mouse != IntPtr.Zero) DesktopNative.UnhookWindowsHookEx(mouse);
            Lease.Revoke("Desktop input hooks are unavailable");
            throw new InvalidOperationException("Desktop input hooks are unavailable");
        }
        var oldKeyboard = Keyboard;
        var oldMouse = Mouse;
        Keyboard = keyboard;
        Mouse = mouse;
        if (oldKeyboard != IntPtr.Zero) DesktopNative.UnhookWindowsHookEx(oldKeyboard);
        if (oldMouse != IntPtr.Zero) DesktopNative.UnhookWindowsHookEx(oldMouse);
    }

    private void OnLoop(Action action)
    {
        if (Volatile.Read(ref Disposed) != 0 || Indicator == null || !Loop.IsAlive) throw new InvalidOperationException("Desktop input monitor is stopped");
        Exception error = null;
        var done = new ManualResetEventSlim(false);
        var cancelled = 0;
        Indicator.BeginInvoke((Action)delegate
        {
            try { if (Volatile.Read(ref cancelled) == 0) action(); }
            catch (Exception caught) { error = caught; }
            finally { if (Volatile.Read(ref cancelled) != 0) Lease.Revoke("Desktop input monitor timed out"); done.Set(); }
        });
        if (!done.Wait(1500)) { Interlocked.Exchange(ref cancelled, 1); Lease.Revoke("Desktop input monitor timed out"); throw new InvalidOperationException("Desktop input monitor timed out"); }
        done.Dispose();
        if (error != null) throw error;
    }

    internal long Intervention { get { return Interlocked.Read(ref InterventionCount); } }

    internal LeaseState Bind(DesktopTarget target, string grant, long intervention, Func<bool> permitted)
    {
        LeaseState state = null;
        OnLoop(delegate
        {
            Func<bool> current = delegate { return intervention == Intervention && permitted(); };
            if (!current()) throw new InvalidOperationException("Desktop approval was cancelled or user input changed");
            if (OwnMutex) throw new InvalidOperationException("Stop the current control session first");
            try { OwnMutex = GlobalLease.WaitOne(0); }
            catch (AbandonedMutexException) { OwnMutex = true; }
            if (!OwnMutex) throw new InvalidOperationException("Another application window already has desktop control");
            try
            {
                Rearm();
                DesktopNative.IdleKeys();
                if (!current()) throw new InvalidOperationException("Desktop approval was cancelled before focus changed");
                if (DesktopNative.GetForegroundWindow() != target.Handle && !DesktopNative.SetForegroundWindow(target.Handle))
                    throw new InvalidOperationException("Bring the chosen application to the foreground and grant control again");
                DesktopNative.Foreground(target);
                state = Lease.Bind(target, grant, current);
                Indicator.Start(target);
                if (!Indicator.Visible) throw new InvalidOperationException("The desktop stop control could not be displayed");
                if (!current()) throw new InvalidOperationException("Desktop approval was cancelled while control started");
            }
            catch { Lease.Revoke("Desktop control could not start"); if (OwnMutex) { GlobalLease.ReleaseMutex(); OwnMutex = false; } throw; }
        });
        return state;
    }

    internal void BeforeInput(LeaseState state)
    {
        OnLoop(delegate { Lease.Require(state); Rearm(); if (!Indicator.Visible) throw new InvalidOperationException("The desktop stop control is not visible"); });
        Lease.Require(state);
    }

    internal void Revoked()
    {
        if (Indicator == null || Volatile.Read(ref Disposed) != 0) return;
        try
        {
            Indicator.BeginInvoke((Action)delegate
            {
                if (OwnMutex) { GlobalLease.ReleaseMutex(); OwnMutex = false; }
                Indicator.Paused();
            });
        }
        catch (InvalidOperationException) { }
    }

    private IntPtr OnKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var value = (DesktopNative.KeyboardHook)Marshal.PtrToStructure(data, typeof(DesktopNative.KeyboardHook));
            var marker = value.Extra.ToUInt64();
            if (Packets.Own(marker) && (value.Flags & 0x10) != 0)
            {
                var identity = value.Key == 0xe7 ? 0x10000U | value.Scan : value.Key;
                if (!Packets.Admit(marker, identity, (value.Flags & 0x80) != 0, true)) return new IntPtr(1);
            }
            else { Interlocked.Increment(ref InterventionCount); Lease.Revoke(value.Key == 27 ? "Escape pressed" : "Keyboard input returned control to the user"); }
        }
        return DesktopNative.CallNextHookEx(Keyboard, code, message, data);
    }

    private IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var value = (DesktopNative.MouseHook)Marshal.PtrToStructure(data, typeof(DesktopNative.MouseHook));
            var marker = value.Extra.ToUInt64();
            if (Packets.Own(marker) && (value.Flags & 1) != 0)
            {
                var kind = message.ToInt32();
                var release = kind == 0x202;
                var down = kind == 0x201;
                var state = Lease.State;
                if (!release && (state == null || !DesktopNative.AtTarget(state.Target.Handle, value.Point.X, value.Point.Y)))
                { Lease.Revoke("The pointer target changed"); return new IntPtr(1); }
                if (!Packets.Admit(marker, 0x20001, release, down)) return new IntPtr(1);
            }
            else { Interlocked.Increment(ref InterventionCount); Lease.Revoke("Mouse input returned control to the user"); }
        }
        return DesktopNative.CallNextHookEx(Mouse, code, message, data);
    }

    public void Dispose()
    {
        Lease.Revoke("Desktop control connection closed");
        if (Interlocked.Exchange(ref Disposed, 1) != 0) return;
        if (Watchdog != null) Watchdog.Dispose();
        if (Indicator != null && Loop.IsAlive)
            try { Indicator.BeginInvoke((Action)delegate { Application.ExitThread(); }); } catch (InvalidOperationException) { }
        Loop.Join(1500);
        Ready.Dispose();
    }
}
