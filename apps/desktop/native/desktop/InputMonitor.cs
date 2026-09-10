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
    private long LastInput = Environment.TickCount;
    private int EscapeSeen;
    private readonly System.Threading.Timer Watchdog;
    private readonly WindowGuard Guard;
    private volatile bool Preparing;
    private long PrepareUntil;
    private string PreparedGrant;
    internal volatile bool PointerAction;
    private IntPtr Overlay;

    internal InputMonitor(ControlLease lease, WindowGuard guard)
    {
        Lease = lease;
        Guard = guard;
        Packets = new PacketGate(lease, target => Armed && Guard.FastCurrent(target));
        KeyboardCallback = OnKeyboard;
        MouseCallback = OnMouse;
        Loop = new Thread(Run) { IsBackground = true, Name = "Desktop input monitor" };
        Loop.SetApartmentState(ApartmentState.STA);
        Loop.Start();
        if (!Ready.Wait(3000) || StartupError != null)
            throw new InvalidOperationException("Desktop stop monitoring is unavailable", StartupError);
        Watchdog = new System.Threading.Timer(delegate
        {
            var state = Lease.State;
            if (state == null) return;
            if (unchecked((uint)Environment.TickCount - (uint)Interlocked.Read(ref Beat)) > 500) Lease.Revoke(state, "Desktop stop monitoring stalled");
            if (!Guard.OwnerAlive()) Lease.Revoke(state, "The desktop owner exited");
            if (!Lease.Valid(state)) Lease.Revoke(state, "Desktop control expired");
            if (Preparing) {
                if (unchecked((int)((uint)Interlocked.Read(ref PrepareUntil) - (uint)Environment.TickCount)) <= 0) Lease.Revoke(state, "Computer control preparation timed out");
            } else if (Armed && Lease.Valid(state) && !Guard.FastCurrent(state.Target)) Lease.Revoke(state, "The selected window or desktop changed");
            if (Armed && Overlay != IntPtr.Zero && !Guard.OwnerOverlay(Overlay)) Lease.Revoke(state, "The desktop stop overlay closed");
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
            Indicator = new ControlIndicator(delegate { Interlocked.Exchange(ref EscapeSeen, 1); Interlocked.Increment(ref InterventionCount); Lease.Revoke("Stopped by the user"); });
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
            try { Interlocked.Exchange(ref Beat, Environment.TickCount); if (Volatile.Read(ref cancelled) == 0) action(); }
            catch (Exception caught) { error = caught; }
            finally { Interlocked.Exchange(ref Beat, Environment.TickCount); if (Volatile.Read(ref cancelled) != 0) Lease.Revoke("Desktop input monitor timed out"); done.Set(); }
        });
        if (!done.Wait(1500)) { Interlocked.Exchange(ref cancelled, 1); Lease.Revoke("Desktop input monitor timed out"); throw new InvalidOperationException("Desktop input monitor timed out"); }
        done.Dispose();
        if (error != null) throw error;
    }

    internal long Intervention { get { return Interlocked.Read(ref InterventionCount); } }
    internal uint IdleMilliseconds { get { return unchecked((uint)Environment.TickCount - (uint)Interlocked.Read(ref LastInput)); } }
    internal bool Escaped { get { return Volatile.Read(ref EscapeSeen) != 0; } }
    internal bool Working { get { return Armed && Lease.Valid(Lease.State); } }

    // Native Stop remains available independently of the renderer overlay.
    private volatile bool Armed;
    private bool IndicatorVisible { get { return Overlay == IntPtr.Zero ? Indicator.Visible : Guard.OwnerOverlay(Overlay); } }
    private bool Controlling { get { return Armed && IndicatorVisible && Lease.Valid(Lease.State); } }

    internal void Prepare(DesktopTarget target, string grant, long intervention, Func<bool> permitted, IntPtr overlay)
    {
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
                if (!current()) throw new InvalidOperationException("User input changed before computer control started");
                Overlay = overlay;
                if (Overlay == IntPtr.Zero) Indicator.Start(target);
                else Indicator.Hide();
                if (!IndicatorVisible) throw new InvalidOperationException("The desktop stop control could not be displayed");
                if (!current()) throw new InvalidOperationException("Desktop approval was cancelled while control started");
                Interlocked.Exchange(ref Beat, Environment.TickCount);
                Interlocked.Exchange(ref PrepareUntil, unchecked((uint)Environment.TickCount + 5000U));
                Preparing = true;
                Lease.Bind(target, grant, current);
                PreparedGrant = grant;
                Interlocked.Exchange(ref EscapeSeen, 0);
                Armed = true;
            }
            catch { Armed = false; Preparing = false; Lease.Revoke("Desktop control could not start"); Indicator.Paused(); if (OwnMutex) { GlobalLease.ReleaseMutex(); OwnMutex = false; } throw; }
        });
    }

    internal LeaseState Bind(DesktopTarget target, string grant, long intervention, Func<bool> permitted)
    {
        LeaseState state = null;
        OnLoop(delegate
        {
            state = Lease.State;
            if (Escaped) throw new InvalidOperationException("Escape pressed");
            Lease.Require(state);
            if (!Preparing || PreparedGrant != grant || state.Target.Id != target.Id || state.Target.Pid != target.Pid)
                throw new InvalidOperationException("Prepare the selected application before taking control");
            Guard.Same(state.Target);
            Func<bool> current = delegate { return intervention == Intervention && permitted() && Lease.Valid(state); };
            if (!current()) throw new InvalidOperationException("Desktop approval was cancelled before focus changed");
            if (DesktopNative.GetForegroundWindow() != target.Handle && !DesktopNative.SetForegroundWindow(target.Handle))
                throw new InvalidOperationException("Bring the chosen application to the foreground and grant control again");
            DesktopNative.AwaitForeground(target);
            if (!current()) throw new InvalidOperationException("Desktop approval was cancelled while the app was becoming active");
            Preparing = false;
            PreparedGrant = null;
        });
        return state;
    }

    internal void BeforeInput(LeaseState state)
    {
        OnLoop(delegate { Lease.Require(state); Rearm(); if (!Armed || !IndicatorVisible) throw new InvalidOperationException("The desktop stop control is not visible"); });
        Lease.Require(state);
    }

    internal void Work(LeaseState state, IntPtr overlay)
    {
        OnLoop(delegate
        {
            Lease.Require(state);
            if (!Guard.FastCurrent(state.Target)) throw new InvalidOperationException("The selected window or desktop changed");
            DesktopNative.IdleKeys();
            Overlay = overlay;
            if (Overlay == IntPtr.Zero) Indicator.Start(state.Target);
            if (!IndicatorVisible) throw new InvalidOperationException("The desktop stop overlay is unavailable");
            Lease.Require(state);
            Armed = true;
        });
    }

    internal void Idle(LeaseState state)
    {
        OnLoop(delegate { Lease.Require(state); Armed = false; PointerAction = false; Indicator.Hide(); });
    }

    internal void Revoked(LeaseState state)
    {
        if (Indicator == null || Volatile.Read(ref Disposed) != 0) return;
        try
        {
            Indicator.BeginInvoke((Action)delegate
            {
                if (!ReferenceEquals(Lease.State, state)) return;
                Armed = false;
                Preparing = false;
                PointerAction = false;
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
            else
            {
                if (ControlPolicy.HoldKeyboard(Controlling, value.Key, (value.Flags & 0x10) != 0)) return new IntPtr(1);
                Interlocked.Exchange(ref LastInput, Environment.TickCount);
                if (value.Key == 27) Interlocked.Exchange(ref EscapeSeen, 1);
                Interlocked.Increment(ref InterventionCount);
                Lease.Revoke(value.Key == 27 ? "Escape pressed" : "Keyboard input returned control to the user");
            }
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
                var state = Packets.Active(marker);
                if (!release && (state == null || !DesktopNative.AtTarget(state.Target.Handle, value.Point.X, value.Point.Y)))
                { if (state != null) Lease.Revoke(state, "The pointer target changed"); return new IntPtr(1); }
                if (!Packets.Admit(marker, 0x20001, release, down)) return new IntPtr(1);
            }
            else
            {
                var kind = message.ToInt32();
                var injected = (value.Flags & 1) != 0;
                var controlling = Controlling;
                var stopped = kind == 0x201 && (Indicator.StopAt(value.Point.X, value.Point.Y)
                    || (controlling && !Preparing && !injected && !DesktopNative.AtTarget(Lease.State.Target.Handle, value.Point.X, value.Point.Y)));
                if (!stopped && ControlPolicy.HoldMouse(controlling, Preparing || PointerAction, kind, injected)) return new IntPtr(1);
                if (ControlPolicy.PassivePointer(kind, injected)) return DesktopNative.CallNextHookEx(Mouse, code, message, data);
                Interlocked.Exchange(ref LastInput, Environment.TickCount);
                Interlocked.Increment(ref InterventionCount);
                if (stopped) Interlocked.Exchange(ref EscapeSeen, 1);
                Lease.Revoke(stopped ? "Stopped by the user" : "Mouse input returned control to the user");
            }
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
