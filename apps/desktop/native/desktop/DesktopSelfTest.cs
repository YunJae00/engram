using System;

internal static class DesktopSelfTest
{
    private static int Assertions;
    private static void Check(bool value, string label)
    { if (!value) throw new InvalidOperationException(label); Assertions++; }
    private static void Reject(Action action, string label)
    {
        try { action(); }
        catch (InvalidOperationException) { Assertions++; return; }
        catch (ArgumentException) { Assertions++; return; }
        throw new InvalidOperationException(label);
    }
    private static DesktopTarget Target()
    { return new DesktopTarget { Handle = new IntPtr(123), Pid = 456, Started = 7, Generation = 8, Title = "Owned fixture" }; }
    private static bool Deliver(PacketGate gate, DesktopNative.Input input)
    {
        var value = input.Value.Key;
        var identity = value.Key == 0 ? 0x10000U | value.Scan : value.Key;
        return gate.Admit(value.Extra.ToUInt64(), identity, (value.Flags & 2) != 0, true);
    }
    internal static int Run()
    {
        try
        {
            var from = new System.Windows.Point(-1200, 30);
            var to = new System.Windows.Point(-200, 630);
            Check(DesktopActions.MotionPoint(from, to, 0) == from, "Motion starts at the current pointer");
            Check(DesktopActions.MotionPoint(from, to, 1) == to, "Motion lands exactly at the target");
            var prior = from;
            for (var step = 1; step <= 20; step++)
            {
                var point = DesktopActions.MotionPoint(from, to, step / 20.0);
                Check(point.X >= prior.X && point.Y >= prior.Y && point.X <= to.X && point.Y <= to.Y, "Motion must not overshoot on negative-coordinate displays");
                prior = point;
            }
            var revocations = 0;
            var lease = new ControlLease(delegate { revocations++; });
            var target = Target();
            Reject(delegate { lease.Bind(target, Guid.NewGuid().ToString("N"), delegate { return false; }); }, "Stop before delayed bind must prevent activation");
            Check(lease.State == null, "A cancelled initial bind must not create a lease");
            var cancelledLease = new ControlLease(delegate { Check(true, "Late cancelled bind emits revocation"); });
            var checks = 0;
            Reject(delegate { cancelledLease.Bind(target, Guid.NewGuid().ToString("N"), delegate { return ++checks == 1; }); }, "Stop during lease publication must revoke the late grant");
            Check(!cancelledLease.Valid(cancelledLease.State), "Late cancelled grants cannot become active");
            var grant = Guid.NewGuid().ToString("N");
            var state = lease.Bind(target, grant);
            Check(lease.Valid(state), "New lease must be active");
            Reject(delegate { lease.Bind(target, Guid.NewGuid().ToString("N")); }, "Only one lease may be active");
            var current = true;
            var gate = new PacketGate(lease, delegate { return current; });
            var packet = gate.Begin(state);
            Check(gate.Own(packet.Marker), "Own packet must be recognizable");
            Check(packet.Marker > 0 && packet.Marker <= uint.MaxValue, "Input markers must survive 32-bit mouse transport");
            Check(!gate.Own(packet.Marker | 0x100000000UL), "Unrelated high bits cannot match an owned marker");
            Check(!gate.Own(0), "Foreign packet cannot be treated as owned");
            Check(gate.Admit(packet.Marker, 65, false, true), "Active press must be admitted");
            lease.Revoke("Physical input");
            Check(!gate.Admit(packet.Marker, 66, false, true), "Revoke must invalidate pending presses");
            Check(gate.Admit(packet.Marker, 65, true, true), "Own accepted press must be released after revoke");
            Check(!gate.Admit(packet.Marker, 66, true, true), "Unowned releases must be blocked");
            gate.End(packet);
            Check(!gate.Admit(packet.Marker, 65, false, true), "Expired own markers must remain blocked");
            lease.Revoke("Repeated stop");
            Check(revocations == 1, "Revocation event must be emitted once");
            Reject(delegate { lease.Require(state); }, "Revoked lease cannot resume");
            Reject(delegate { lease.Bind(target, grant); }, "Approval grants cannot be reused");
            var next = lease.Bind(target, Guid.NewGuid().ToString("N"));
            Check(next.Epoch > state.Epoch && next.Id != state.Id, "New approval must create a new epoch");
            Reject(delegate { gate.Begin(state); }, "Previous epochs cannot queue more input");
            var moved = gate.Begin(next);
            current = false;
            Check(!gate.Admit(moved.Marker, 65, false, true), "Changed targets must block input");
            gate.End(moved);
            current = true;
            var sent = 0;
            var dispatcher = new InputDispatcher(lease, gate, delegate(DesktopNative.Input[] batch)
            {
                foreach (var input in batch) { Check(Deliver(gate, input), "Complete synthetic input must pass the gate"); sent++; }
                return (uint)batch.Length;
            });
            dispatcher.Send(next, new[] { InputDispatcher.Key(0, '\ud55c', 4), InputDispatcher.Key(0, '\ud55c', 6) }, delegate { Check(lease.Valid(next), "Pre-dispatch lease validation"); });
            Check(sent == 2, "Unicode must use a complete press/release pair");
            var partial = new InputDispatcher(lease, gate, delegate(DesktopNative.Input[] batch)
            {
                if (batch.Length == 2) { Deliver(gate, batch[0]); return 1; }
                foreach (var input in batch) Check(Deliver(gate, input), "Partial dispatch must release only owned pressed keys");
                return (uint)batch.Length;
            });
            Reject(delegate { partial.Send(next, new[] { InputDispatcher.Key(65, 0, 0), InputDispatcher.Key(65, 0, 2) }, delegate { Check(true, "Pure dispatch validation"); }); }, "Partial SendInput must fail closed");
            Check(!lease.Valid(next), "Partial input must revoke control");
            ControlPolicy.Literal("한글 text \ud83d\ude80"); Assertions++;
            foreach (var invalid in new[] { "", "line\nnext", "\0", "\ud800", "\udc00", new string('x', 2001) })
                Reject(delegate { ControlPolicy.Literal(invalid); }, "Invalid text must be rejected");
            foreach (var key in new[] { "Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space" })
                Check(ControlPolicy.Chord(key).Length == 1, "Allowed keys must not hold modifiers");
            foreach (var key in new[] { "Control+V", "Control+C", "Alt+Tab", "Win+R", "Escape", "F12", "Control+A" })
                Reject(delegate { ControlPolicy.Chord(key); }, "System and clipboard chords must be rejected");
            Check(ControlPolicy.IsSensitive("Sign in to account") && ControlPolicy.IsSensitive("비밀번호") && ControlPolicy.IsSensitive("Windows PowerShell"), "Sensitive surfaces must be recognized");
            Check(ControlPolicy.IsSensitive("Windows Security") && ControlPolicy.IsSensitive("User Account Control"), "Security application titles must require manual control");
            Console.WriteLine("Desktop pure safety tests passed: " + Assertions);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Desktop pure safety test failed: " + error.Message); return 1; }
    }
}
