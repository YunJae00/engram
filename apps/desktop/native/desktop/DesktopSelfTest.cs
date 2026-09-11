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
            foreach (var chord in new[] { "Shift+Tab", "Control+Tab", "Control+Shift+Tab", "F6", "Shift+F6", "Control+L", "Control+N", "Control+H" })
                Check(ControlPolicy.Chord(chord).Length <= 3, "Navigation chords are bounded and release every modifier");
            Check(LiveDocument.Replacement("Old title", "Old", "New") == "New title", "Document replacements preserve unrelated text");
            Check(LiveDocument.Replacement("", "", "한글") == "한글", "Empty document insertion supports Unicode");
            Reject(delegate { LiveDocument.Replacement("same same", "same", "new"); }, "Ambiguous document replacements are rejected");
            Reject(delegate { LiveDocument.Replacement("old", "missing", "new"); }, "Missing fragments are rejected");
            Reject(delegate { LiveDocument.Replacement("old", "", "new"); }, "Empty fragments cannot overwrite existing text");
            foreach (var formula in new[] { "=SUM(A1:A3)", "=B2*C2", "=ROUNDUP(A1,2)" }) { LiveDocument.SafeFormula(formula); Assertions++; }
            Check((string)LiveDocument.CellInput("007") == "'007", "Leading zeros are literal text");
            Check((double)LiveDocument.CellInput("3") == 3, "Canonical numeric input remains numeric");
            Check(LiveDocument.CellAddress(20, 27) == "$AA$20" && LiveDocument.CellAddress(1, 16384) == "$XFD$1", "Bulk cell addresses span column boundaries");
            var cellMatrix = Array.CreateInstance(typeof(object), new[] { 2, 2 }, new[] { 1, 1 });
            cellMatrix.SetValue("=A1", 2, 1);
            Check((string)LiveDocument.CellValue(cellMatrix, 1, 0) == "=A1" && (string)LiveDocument.CellValue("single", 0, 0) == "single", "Bulk reads handle native one-based arrays and single cells");
            dynamic conflict = LiveDocument.Result(new System.Collections.Generic.List<object>(), "Changed before editing", "b0");
            Check(conflict.reobserveRequired && !conflict.completeReadback && conflict.completed.Count == 0, "A preflight conflict reports zero writes and requests observation, not cancellation");
            dynamic documentPartial = LiveDocument.Result(new System.Collections.Generic.List<object> { new { id = "b0" } }, "Changed during editing", "b1");
            Check(documentPartial.reobserveRequired && documentPartial.completed.Count == 1 && documentPartial.failedBlock == "b1", "A failed batch preserves its verified prefix");
            foreach (var formula in new[] { "=WEBSERVICE(A1)", "=CMD|' /c calc'!A0", "=[other.xlsx]Sheet1!A1", "=DDE(A1)", "=HYPERLINK(A1)", "=SecretNamedFormula" })
                Reject(delegate { LiveDocument.SafeFormula(formula); }, "External/executable formulas are rejected natively");
            Check(DesktopApps.Allowed("Example", "Example.App_123!App", ""), "Registered packaged apps are discoverable");
            Check(DesktopApps.Allowed("Example", "Example", @"C:\Apps\Example.exe"), "Registered desktop executables are discoverable");
            Check(!DesktopApps.Allowed("Example", "Example", @"C:\Windows\System32\cmd.exe"), "Terminal targets are excluded regardless of display name");
            Check(!DesktopApps.Allowed("Example", "Microsoft.WindowsTerminal_123!App", ""), "Packaged terminals are excluded");
            Check(!DesktopApps.Allowed("Example", "Example", @"C:\Apps\example.bat"), "Scripts are not app launchers");
            Reject(delegate { DesktopApps.Open("../calc.exe", delegate { return true; }); }, "Model paths cannot be launched");
            Check(DesktopApps.Id("Example") == DesktopApps.Id("Example") && DesktopApps.Id("Example").Length == 64, "Catalog IDs are stable and opaque");
            Check(ControlPolicy.PassivePointer(0x200, false), "Physical pointer motion is not cancellation");
            Check(!ControlPolicy.PassivePointer(0x201, false), "A button press is not passive motion");
            Check(!ControlPolicy.PassivePointer(0x200, true), "Other automation still interrupts control");
            Check(ControlPolicy.HoldKeyboard(true, 65, false), "Physical typing cannot mix with agent typing");
            Check(!ControlPolicy.HoldKeyboard(true, 27, false), "Escape must always release control");
            Check(!ControlPolicy.HoldKeyboard(false, 65, false), "Normal keyboard input is untouched outside control");
            Check(!ControlPolicy.HoldKeyboard(true, 65, true), "Foreign injected keys remain an interruption");
            Check(ControlPolicy.HoldMouse(true, true, 0x200, false), "Pointer actions cannot race physical motion");
            Check(!ControlPolicy.HoldMouse(true, false, 0x200, false), "The stop control stays reachable between pointer actions");
            Check(ControlPolicy.HoldMouse(true, false, 0x201, false), "Physical clicks cannot change the agent target");
            Check(!ControlPolicy.HoldMouse(false, true, 0x201, false), "Expired control cannot hold mouse input");
            Check(!ControlPolicy.HoldMouse(true, true, 0x200, true), "Foreign pointer automation is not swallowed");
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
            Check(ReferenceEquals(gate.Active(packet.Marker), state), "An active marker identifies its own lease");
            Check(gate.Own(packet.Marker), "Own packet must be recognizable");
            Check(packet.Marker > 0 && packet.Marker <= uint.MaxValue, "Input markers must survive 32-bit mouse transport");
            Check(!gate.Own(packet.Marker | 0x100000000UL), "Unrelated high bits cannot match an owned marker");
            Check(!gate.Own(0), "Foreign packet cannot be treated as owned");
            Check(gate.Admit(packet.Marker, 65, false, true), "Active press must be admitted");
            lease.Revoke("Physical input");
            Check(gate.Active(packet.Marker) == null, "A cancelled marker cannot target another lease");
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
            Check(gate.Active(packet.Marker) == null, "A retired marker cannot attach to a new approval");
            Check(next.Epoch > state.Epoch && next.Id != state.Id, "New approval must create a new epoch");
            lease.Revoke(state, "A delayed watchdog observed the previous lease");
            lease.Revoke(null, "A delayed observer saw no active lease");
            Check(lease.Valid(next), "A stale watchdog must not revoke a new approval");
            Check(revocations == 1, "A stale watchdog must not emit another revocation");
            var scopedLease = new ControlLease(delegate { });
            var scopedState = scopedLease.Bind(target, Guid.NewGuid().ToString("N"));
            scopedLease.Revoke(scopedState, "The current watchdog detected a stop");
            Check(!scopedLease.Valid(scopedState), "A current watchdog must still stop control");
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
            foreach (var key in new[] { "Control+A", "Control+B", "Control+I", "Control+U", "Control+F", "Control+Home", "Control+End", "Control+ArrowLeft", "Control+ArrowRight", "Shift+Home", "Shift+End", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown", "Control+Shift+Home", "Control+Shift+End", "Control+Shift+ArrowLeft", "Control+Shift+ArrowRight" })
                Check(ControlPolicy.Chord(key).Length >= 2 && ControlPolicy.Chord(key).Length <= 3, "Editing chords have bounded modifiers");
            foreach (var key in new[] { "Control+V", "Control+C", "Alt+Tab", "Win+R", "Escape", "F12", "Control+Alt+Delete" })
                Reject(delegate { ControlPolicy.Chord(key); }, "System and clipboard chords must be rejected");
            Check(ControlPolicy.IsSensitive("Sign in to account") && ControlPolicy.IsSensitive("비밀번호") && ControlPolicy.IsSensitive("Windows PowerShell"), "Sensitive surfaces must be recognized");
            Check(ControlPolicy.IsSensitive("Windows Security") && ControlPolicy.IsSensitive("User Account Control"), "Security application titles must require manual control");
            Console.WriteLine("Desktop pure safety tests passed: " + Assertions);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Desktop pure safety test failed: " + error.Message); return 1; }
    }
}
