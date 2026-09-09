using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class DesktopRequest
{
    internal Dictionary<string, object> Value;
    internal long Intervention;
    internal long StopEpoch;
}

internal static class Program
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 524288, RecursionLimit = 16 };
    private static readonly object OutputLock = new object();
    private static long StopEpoch;
    private static int Closed;

    internal static string Text(Dictionary<string, object> request, string key, int limit)
    {
        object raw;
        if (!request.TryGetValue(key, out raw) || !(raw is string)) throw new ArgumentException("Missing or invalid " + key);
        var value = (string)raw;
        if (value.Length > limit || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid " + key + " length or content");
        return value;
    }
    private static int Number(Dictionary<string, object> request, string key, int minimum, int maximum)
    {
        object raw;
        if (!request.TryGetValue(key, out raw) || !(raw is int) || (int)raw < minimum || (int)raw > maximum)
            throw new ArgumentException("Missing or invalid " + key);
        return (int)raw;
    }
    private static void Send(object response)
    {
        lock (OutputLock) { Console.WriteLine(Json.Serialize(response)); Console.Out.Flush(); }
    }
    private static void Error(int id, Exception error)
    {
        var message = error is System.Windows.Automation.ElementNotAvailableException
            ? "The window or control is no longer available. Observe the window again." : error.Message;
        Send(new { id = id, error = message.Length > 500 ? message.Substring(0, 500) : message });
    }

    private static void Receive(DesktopRequest queued, AutomationSession automation, WindowGuard guard,
        ControlLease lease, InputMonitor monitor, DesktopActions actions)
    {
        var id = 0;
        var mutation = false;
        var method = "";
        try
        {
            var request = queued.Value;
            id = Number(request, "id", 1, int.MaxValue);
            method = Text(request, "method", 32);
            mutation = method == "openApp" || method == "prepare" || method == "bind" || method == "work" || method == "idle" || method == "click" || method == "type" || method == "scroll" || method == "key";
            if (Volatile.Read(ref Closed) != 0 || (mutation && queued.StopEpoch != Interlocked.Read(ref StopEpoch)))
                throw new InvalidOperationException("The desktop request was cancelled");
            if (method == "listWindows") { Send(new { id = id, result = new { windows = DesktopNative.List(guard) } }); return; }
            if (method == "listApps") { Send(new { id = id, result = DesktopApps.List() }); return; }
            if (method == "openApp")
            {
                Send(new { id = id, result = DesktopApps.Open(Text(request, "app", 64), delegate
                { return Volatile.Read(ref Closed) == 0 && queued.StopEpoch == Interlocked.Read(ref StopEpoch) && !monitor.Escaped; }) });
                return;
            }
            if (method == "inputState") { Send(new { id = id, result = new { idleMs = monitor.IdleMilliseconds, escaped = monitor.Escaped, working = monitor.Working, intervention = monitor.Intervention.ToString(CultureInfo.InvariantCulture) } }); return; }
            var window = Text(request, "window", 32);
            var pid = Number(request, "pid", method == "inspectWindow" ? 0 : 1, int.MaxValue);
            var target = guard.Resolve(window, pid);
            if (method == "inspectWindow")
            { Send(new { id = id, result = new { window = target.Id, pid = target.Pid, title = target.Title, minimized = target.Minimized } }); return; }
            if (method == "bind" || method == "prepare")
            {
                if (request.ContainsKey("intervention") && Text(request, "intervention", 20) != queued.Intervention.ToString(CultureInfo.InvariantCulture))
                    throw new InvalidOperationException(monitor.Escaped ? "Escape pressed" : "User input changed during foreground delegation");
                if (queued.Intervention != monitor.Intervention) throw new InvalidOperationException("User input changed after approval. Request new approval");
                if (ControlPolicy.IsSensitive(target.Title)) throw new InvalidOperationException("This application surface requires manual control");
                Func<bool> permitted = delegate { return Volatile.Read(ref Closed) == 0 && queued.StopEpoch == Interlocked.Read(ref StopEpoch); };
                if (method == "prepare")
                {
                    monitor.Prepare(target, Text(request, "grant", 64), queued.Intervention, permitted, Overlay(request));
                    Send(new { id = id, result = new { intervention = monitor.Intervention.ToString(CultureInfo.InvariantCulture) } });
                    return;
                }
                var active = monitor.Bind(target, Text(request, "grant", 64), queued.Intervention, permitted);
                automation.Validate(target);
                if (!permitted()) throw new InvalidOperationException("Desktop approval was cancelled while validating the application");
                lease.Require(active);
                Send(new { id = id, result = new { lease = active.Id, epoch = active.Epoch, window = target.Id, pid = target.Pid, expiresInMs = 600000 } });
                return;
            }
            LeaseState state = null;
            if (request.ContainsKey("lease"))
            {
                state = lease.Require(Text(request, "lease", 100));
                if (state.Target.Id != target.Id || state.Target.Pid != target.Pid) throw new InvalidOperationException("This lease belongs to a different application");
            }
            if (method == "work" || method == "idle")
            {
                lease.Require(state);
                if (method == "work") monitor.Work(state, Overlay(request));
                else monitor.Idle(state);
                Send(new { id = id, result = new { working = method == "work" } });
                return;
            }
            if (method == "observe")
            {
                if (state != null) { DesktopNative.Foreground(target); lease.Require(state); }
                var observation = automation.Observe(target, state);
                if (state != null) lease.Require(state);
                Send(new { id = id, result = observation });
                return;
            }
            if (method == "capture")
            {
                var observed = Text(request, "snapshot", 100);
                automation.RequireCapture(observed, target);
                var captured = DesktopCapture.Read(target, delegate
                {
                    return Volatile.Read(ref Closed) == 0 && queued.StopEpoch == Interlocked.Read(ref StopEpoch)
                        && (state == null || lease.Valid(state));
                });
                automation.RequireCapture(observed, target);
                Send(new { id = id, result = captured });
                return;
            }
            if (!mutation || state == null) throw new ArgumentException("A valid desktop control lease is required for this method");
            var snapshot = Text(request, "snapshot", 100);
            monitor.PointerAction = method == "click" || method == "scroll";
            if (method == "click")
            {
                string element = request.ContainsKey("element") ? Text(request, "element", 32) : null;
                if (element != null && (request.ContainsKey("x") || request.ContainsKey("y"))) throw new ArgumentException("Choose a control or coordinates, not both");
                int? x = request.ContainsKey("x") ? (int?)Number(request, "x", -100000, 100000) : null;
                int? y = request.ContainsKey("y") ? (int?)Number(request, "y", -100000, 100000) : null;
                actions.Click(state, snapshot, element, x, y);
            }
            else if (method == "type") actions.Type(state, snapshot, Text(request, "text", 2000));
            else if (method == "scroll") actions.Scroll(state, snapshot, Number(request, "delta", -10, 10));
            else if (method == "key") actions.Key(state, snapshot, Text(request, "key", 32));
            else throw new ArgumentException("Unsupported desktop method");
            Send(new { id = id, result = new { sent = true, window = target.Id, pid = target.Pid,
                requiresObservation = true, controlActive = lease.Valid(state) } });
        }
        catch (Exception error)
        {
            if (mutation) lease.Revoke(error.Message);
            Error(id, error);
        }
        finally { monitor.PointerAction = false; if (mutation && method != "bind" && method != "work" && method != "idle") automation.Invalidate(); }
    }

    private static IntPtr Overlay(Dictionary<string, object> request)
    {
        if (!request.ContainsKey("overlay")) return IntPtr.Zero;
        long value;
        if (!long.TryParse(Text(request, "overlay", 20), NumberStyles.None, CultureInfo.InvariantCulture, out value) || value <= 0)
            throw new ArgumentException("Invalid desktop stop overlay");
        return new IntPtr(value);
    }

    [MTAThread]
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test") return DesktopSelfTest.Run();
        int owner;
        if ((args.Length != 2 && args.Length != 4) || args[0] != "--owner-pid" || !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out owner) || owner <= 0)
        { Send(new { type = "fatal", error = "A valid --owner-pid is required" }); return 2; }
        if (args.Length == 4)
        {
            int helper;
            if (args[2] != "--grant-foreground" || !int.TryParse(args[3], out helper) || helper <= 0) return 2;
            try { using (var guard = new WindowGuard(owner)) return guard.GrantForeground(helper) ? 0 : 1; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        InputMonitor monitor = null;
        ControlLease lease = null;
        try
        {
            DesktopNative.Dpi();
            using (var guard = new WindowGuard(owner))
            using (var requests = new BlockingCollection<DesktopRequest>(16))
            {
                lease = new ControlLease(delegate(LeaseState state, string reason)
                {
                    if (monitor != null) monitor.Revoked();
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        try { Send(new { type = "revoked", lease = state.Id, epoch = state.Epoch, reason = reason }); }
                        catch (System.IO.IOException) { Interlocked.Exchange(ref Closed, 1); }
                    });
                });
                using (monitor = new InputMonitor(lease, guard))
                {
                    var automation = new AutomationSession(guard);
                    var actions = new DesktopActions(lease, monitor, automation);
                    var worker = new Thread(delegate()
                    {
                        foreach (var request in requests.GetConsumingEnumerable())
                        {
                            if (Volatile.Read(ref Closed) != 0) break;
                            Receive(request, automation, guard, lease, monitor, actions);
                        }
                    }) { IsBackground = true, Name = "Desktop accessibility worker" };
                    worker.SetApartmentState(ApartmentState.MTA);
                    worker.Start();
                    Send(new { type = "ready", protocol = 2, control = true });
                    string input;
                    while ((input = Console.ReadLine()) != null)
                    {
                        var id = 0;
                        try
                        {
                            if (input.Length > 65536) throw new ArgumentException("Desktop request exceeds 65536 characters");
                            var reader = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 };
                            var request = reader.Deserialize<Dictionary<string, object>>(input);
                            id = Number(request, "id", 1, int.MaxValue);
                            if (Text(request, "method", 32) == "stop")
                            {
                                Interlocked.Increment(ref StopEpoch);
                                lease.Revoke("Stopped by the user");
                                Send(new { id = id, result = new { stopped = true } });
                                continue;
                            }
                            if (!requests.TryAdd(new DesktopRequest { Value = request, Intervention = monitor.Intervention, StopEpoch = Interlocked.Read(ref StopEpoch) }))
                                throw new InvalidOperationException("Desktop request queue is full");
                        }
                        catch (Exception error) { Error(id, error); }
                    }
                    Interlocked.Exchange(ref Closed, 1);
                    Interlocked.Increment(ref StopEpoch);
                    lease.Revoke("Desktop control connection closed");
                    requests.CompleteAdding();
                    worker.Join(1000);
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            if (lease != null) lease.Revoke("Desktop control connection failed");
            Send(new { type = "fatal", error = error.Message });
            return 2;
        }
    }
}
