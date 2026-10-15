using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;

// Reading and operating an app through its accessibility providers alone: no
// requested foreground change, injected input or capture. Providers may activate
// their own window when invoked; mutation receipts report that separately.
internal sealed class QuietControl
{
    internal AutomationElement Element;
    internal string Runtime;
    internal string Name;
    internal int ControlType;
}

internal sealed class QuietSnapshot
{
    internal string Id;
    internal DesktopTarget Target;
    internal string RootRuntime;
    internal long Created = Stopwatch.GetTimestamp();
    internal readonly Dictionary<string, QuietControl> Controls = new Dictionary<string, QuietControl>();
}

internal sealed class QuietAccess : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { internal uint Size; internal uint Time; }
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

    private const int MaxControls = 80;
    private const int MaxTexts = 80;
    private const int NameLimit = 300;
    private const int ValueLimit = 600;
    private const int ReadLimit = 12000;
    private const int LandMs = 1500;
    private readonly WindowGuard Guard;
    private readonly PasswordScan Passwords = new PasswordScan();
    private readonly List<QuietSnapshot> Snapshots = new List<QuietSnapshot>();
    private static readonly ControlType[] Interactive = { ControlType.Edit, ControlType.Document, ControlType.Button, ControlType.Hyperlink, ControlType.ListItem, ControlType.TreeItem,
        ControlType.TabItem, ControlType.RadioButton, ControlType.CheckBox, ControlType.MenuItem, ControlType.ComboBox, ControlType.SplitButton };
    private static readonly ControlType[] Textual = { ControlType.Text };

    internal QuietAccess(WindowGuard guard) { Guard = guard; }
    public void Dispose() { Passwords.Dispose(); }

    private AutomationElement Validate(DesktopTarget target)
    {
        Guard.Same(target);
        var root = AutomationElement.FromHandle(target.Handle);
        AutomationSession.SafeAncestors(root, AutomationSession.RuntimeId(root));
        if (ControlPolicy.IsSensitive(target.Title) || Passwords.HasVisiblePassword(target.Handle, root, target.Pid, target.Started))
            throw new InvalidOperationException("Authentication, password, terminal, and security surfaces require manual control");
        Guard.Same(target);
        return root;
    }

    private void RequireIdle(DesktopTarget target)
    {
        var state = InputState(target);
        if (state.Item1 && state.Item2 < 4000) throw new InvalidOperationException("The person is using this app. Read it again after they are done.");
    }

    private static string Clip(string value, int limit)
    {
        if (value == null) return "";
        var text = value.Replace("\r\n", "\n");
        return text.Length <= limit ? text : text.Substring(0, limit) + "…";
    }
    private static string Flat(string value) { return value == null ? "" : string.Join(" ", value.Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)); }
    private static bool Has(AutomationElement element, AutomationProperty available)
    {
        var value = element.GetCachedPropertyValue(available);
        return value is bool && (bool)value;
    }
    private static bool ReadOnly(AutomationElement element)
    {
        var value = element.GetCachedPropertyValue(ValuePattern.IsReadOnlyProperty, true);
        return value is bool && (bool)value;
    }
    private static Condition TypeCondition(IEnumerable<ControlType> types)
    {
        var conditions = types.Select(type => (Condition)new PropertyCondition(AutomationElement.ControlTypeProperty, type)).ToArray();
        return conditions.Length == 1 ? conditions[0] : new OrCondition(conditions);
    }
    private static CacheRequest Cache()
    {
        var cache = new CacheRequest { TreeScope = TreeScope.Element, TreeFilter = Automation.RawViewCondition };
        foreach (var property in new[] { AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty,
            AutomationElement.IsPasswordProperty, AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsInvokePatternAvailableProperty,
            AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
            AutomationElement.IsTextPatternAvailableProperty, AutomationElement.RuntimeIdProperty, AutomationElement.IsKeyboardFocusableProperty, ValuePattern.IsReadOnlyProperty }) cache.Add(property);
        cache.Add(ValuePattern.Pattern);
        return cache;
    }

    // What the app shows and offers: editable fields and pressable items first, then the text on screen.
    internal object Scan(DesktopTarget target, string find)
    {
        if (target.Minimized) throw new InvalidOperationException("Restore this window before reading it");
        var root = Validate(target);
        var snapshot = new QuietSnapshot { Id = Guid.NewGuid().ToString("N"), Target = target, RootRuntime = AutomationSession.RuntimeId(root) };
        var wanted = string.IsNullOrWhiteSpace(find) ? null : find.Trim();
        var watch = Stopwatch.StartNew();
        AutomationElementCollection interactive, textual;
        using (Cache().Activate())
        {
            interactive = root.FindAll(TreeScope.Descendants, TypeCondition(Interactive));
            textual = root.FindAll(TreeScope.Descendants, TypeCondition(Textual));
        }
        var controls = new List<object>();
        var texts = new List<object>();
        var remaining = ReadLimit;
        var seen = new HashSet<string>();
        var skippedControls = 0;
        foreach (AutomationElement element in interactive)
        {
            var info = element.Cached;
            // A field the person could type into: links and radio buttons carry a value too, but take none.
            var editable = Has(element, AutomationElement.IsValuePatternAvailableProperty) && !info.IsPassword && !ReadOnly(element)
                && (info.ControlType == ControlType.Edit || (info.ControlType == ControlType.Document && info.IsKeyboardFocusable));
            var name = Clip(info.Name, Math.Min(NameLimit, remaining));
            string value = null;
            object pattern;
            if (editable && element.TryGetCachedPattern(ValuePattern.Pattern, out pattern))
            {
                try { value = Clip(((ValuePattern)pattern).Current.Value, Math.Min(ValueLimit, remaining)); } catch (ElementNotAvailableException) { value = null; }
            }
            if (wanted != null && !editable && (name.IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) < 0) && (value == null || value.IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) < 0)) continue;
            if (controls.Count >= MaxControls || remaining <= 0) { skippedControls++; continue; }
            var id = Register(snapshot, element, seen, "c", controls.Count);
            if (id == null) continue;
            var placeholder = value != null && value.Trim().Length > 0 && Flat(value) == Flat(info.Name);
            controls.Add(new
            {
                id = id, type = info.ControlType.ProgrammaticName.Replace("ControlType.", ""), name = name,
                value = value, placeholder = placeholder ? name : null,
                can = new
                {
                    set = editable, press = Has(element, AutomationElement.IsInvokePatternAvailableProperty) || Has(element, AutomationElement.IsTogglePatternAvailableProperty)
                        || Has(element, AutomationElement.IsSelectionItemPatternAvailableProperty) || Has(element, AutomationElement.IsExpandCollapsePatternAvailableProperty),
                    text = Has(element, AutomationElement.IsTextPatternAvailableProperty),
                },
                enabled = info.IsEnabled, offscreen = info.IsOffscreen, focused = info.HasKeyboardFocus, secret = info.IsPassword,
            });
            remaining = Math.Max(0, remaining - name.Length - (value == null ? 0 : value.Length));
        }
        var lines = new List<AutomationElement>();
        foreach (AutomationElement element in textual)
        {
            var name = element.Cached.Name;
            if (string.IsNullOrWhiteSpace(name)) continue;
            if (wanted != null && name.IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) < 0) continue;
            lines.Add(element);
        }
        // The end of a conversation is what matters most; keep the tail when there is too much.
        var skippedTexts = Math.Max(0, lines.Count - MaxTexts);
        foreach (var element in lines.Skip(skippedTexts))
        {
            if (remaining <= 0) { skippedTexts++; continue; }
            var id = Register(snapshot, element, seen, "t", texts.Count);
            if (id == null) continue;
            var text = Clip(element.Cached.Name, Math.Min(NameLimit, remaining));
            texts.Add(new { id = id, text = text });
            remaining = Math.Max(0, remaining - text.Length);
        }
        Guard.Same(target);
        Remember(snapshot);
        return new
        {
            window = target.Id, pid = target.Pid, title = target.Title, snapshot = snapshot.Id, controls = controls, texts = texts,
            skippedControls = skippedControls, skippedTexts = skippedTexts, ms = watch.ElapsedMilliseconds, state = State(target),
        };
    }

    private static string Register(QuietSnapshot snapshot, AutomationElement element, HashSet<string> seen, string prefix, int index)
    {
        string runtime;
        try { runtime = AutomationSession.RuntimeId((int[])element.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty)); }
        catch (InvalidOperationException) { return null; }
        if (!seen.Add(runtime)) return null;
        var id = prefix + index.ToString(CultureInfo.InvariantCulture);
        snapshot.Controls.Add(id, new QuietControl { Element = element, Runtime = runtime, Name = element.Cached.Name, ControlType = element.Cached.ControlType.Id });
        return id;
    }
    private void Remember(QuietSnapshot snapshot)
    {
        Snapshots.Add(snapshot);
        while (Snapshots.Count > 6) Snapshots.RemoveAt(0);
    }
    private QuietControl Control(DesktopTarget target, string snapshot, string control)
    {
        var held = Snapshots.FirstOrDefault(one => one.Id == snapshot);
        if (held == null) throw new InvalidOperationException("Read the app again before acting. This snapshot is no longer held.");
        if (held.Target.Id != target.Id || held.Target.Pid != target.Pid) throw new InvalidOperationException("This snapshot belongs to a different window");
        if (held.Target.Started != target.Started || held.Target.Generation != target.Generation
            || (Stopwatch.GetTimestamp() - held.Created) * 1000.0 / Stopwatch.Frequency > 60000
            || AutomationSession.RuntimeId(AutomationElement.FromHandle(target.Handle)) != held.RootRuntime)
            throw new InvalidOperationException("Read the app again before acting. This snapshot is stale.");
        QuietControl found;
        if (!held.Controls.TryGetValue(control, out found)) throw new ArgumentException("Unknown control ID for this snapshot");
        try { if (AutomationSession.RuntimeId(found.Element) != found.Runtime) throw new InvalidOperationException("The control changed. Read the app again."); }
        catch (ElementNotAvailableException) { throw new InvalidOperationException("The control is no longer there. Read the app again."); }
        AutomationSession.SafeAncestors(found.Element, held.RootRuntime);
        return found;
    }

    // Whether the person is in this app right now: in front and touching the keyboard or mouse within a few seconds.
    private static Tuple<bool, uint> InputState(DesktopTarget target)
    {
        var info = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        var idle = GetLastInputInfo(ref info) ? unchecked((uint)Environment.TickCount - info.Time) : 0;
        uint pid;
        var front = GetForegroundWindow();
        GetWindowThreadProcessId(front, out pid);
        return Tuple.Create(front == target.Handle || (pid != 0 && pid == target.Pid), idle);
    }
    internal object State(DesktopTarget target)
    { var state = InputState(target); return new { foreground = state.Item1, idleMs = state.Item2, minimized = target.Minimized }; }

    private static bool ForegroundChanged(IntPtr before)
    {
        // Invoke can return before the provider dispatches its queued action.
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 250)
        {
            if (GetForegroundWindow() != before) return true;
            System.Threading.Thread.Sleep(25);
        }
        return GetForegroundWindow() != before;
    }

    // Set a field's whole value through the provider, never over text the person typed.
    internal object Set(DesktopTarget target, string snapshot, string control, string text, string expected, Action check)
    {
        ControlPolicy.Literal(text.Replace("\r", "").Replace("\n", "").Replace("\t", ""));
        Validate(target);
        var found = Control(target, snapshot, control);
        var element = found.Element;
        if (!element.Current.IsEnabled || (element.Current.ControlType != ControlType.Edit && element.Current.ControlType != ControlType.Document))
            throw new InvalidOperationException("This control is not an enabled editable field");
        if (element.Current.IsPassword) throw new InvalidOperationException("Password fields are the person's to fill");
        object pattern;
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) throw new InvalidOperationException("This control does not take text without the keyboard; use desktop_action for it");
        var value = (ValuePattern)pattern;
        if (value.Current.IsReadOnly) throw new InvalidOperationException("This field is read-only");
        var before = value.Current.Value ?? "";
        if (before.Length > 0 && before != expected)
            throw new InvalidOperationException("The field already holds text this chat did not put there: \"" + Clip(before, 120) + "\". Leave it, or pass that exact text as expected to replace it.");
        var watch = Stopwatch.StartNew();
        check();
        RequireIdle(target);
        var foreground = GetForegroundWindow();
        value.SetValue(text);
        var landed = false;
        string after = null;
        while (watch.ElapsedMilliseconds < LandMs)
        {
            after = value.Current.Value ?? "";
            if (after == text) { landed = true; break; }
            System.Threading.Thread.Sleep(100);
        }
        Guard.Same(target);
        // Landed says the text is in the field; exact says nothing else is. A field holding more carries text from elsewhere.
        return new { landed = landed, exact = landed, value = Clip(after, ValueLimit), ms = watch.ElapsedMilliseconds, control = control,
            foregroundChanged = ForegroundChanged(foreground), requiresVerification = true };
    }

    // Press through the provider: a button, a list or tab item, a toggle, a fold.
    internal object Press(DesktopTarget target, string snapshot, string control, Action check)
    {
        Validate(target);
        var element = Control(target, snapshot, control).Element;
        if (!element.Current.IsEnabled) throw new InvalidOperationException("This control is disabled right now");
        check();
        RequireIdle(target);
        var foreground = GetForegroundWindow();
        object pattern;
        string how;
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); how = "invoke"; }
        else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); how = "toggle"; }
        else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); how = "select"; }
        else if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
        {
            var fold = (ExpandCollapsePattern)pattern;
            if (fold.Current.ExpandCollapseState == ExpandCollapseState.Expanded) { fold.Collapse(); how = "collapse"; } else { fold.Expand(); how = "expand"; }
        }
        else throw new InvalidOperationException("This control cannot be pressed without the mouse; use desktop_action for it");
        Guard.Same(target);
        return new { pressed = how, control = control, foregroundChanged = ForegroundChanged(foreground), requiresVerification = true };
    }

    // The text of one control, or of the whole window: the tail when there is too much.
    internal object Read(DesktopTarget target, string snapshot, string control)
    {
        if (target.Minimized) throw new InvalidOperationException("Restore this window before reading it");
        Validate(target);
        string text;
        if (control != null)
        {
            var element = Control(target, snapshot, control).Element;
            object pattern;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
            {
                var range = ((TextPattern)pattern).DocumentRange;
                range.MoveEndpointByRange(TextPatternRangeEndpoint.Start, range, TextPatternRangeEndpoint.End);
                range.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -(ReadLimit + 1));
                text = range.GetText(ReadLimit + 1);
            }
            else if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) text = ((ValuePattern)pattern).Current.Value;
            else text = element.Current.Name;
        }
        else
        {
            var root = AutomationElement.FromHandle(target.Handle);
            var builder = new StringBuilder();
            using (Cache().Activate())
            {
                foreach (AutomationElement element in root.FindAll(TreeScope.Descendants, TypeCondition(Textual)))
                {
                    var name = element.Cached.Name;
                    if (string.IsNullOrWhiteSpace(name)) continue;
                    builder.Append(name.Trim()).Append('\n');
                    if (builder.Length > ReadLimit + 1) builder.Remove(0, builder.Length - ReadLimit - 1);
                }
            }
            text = builder.ToString();
        }
        text = (text ?? "").Replace("\r\n", "\n").Trim();
        var clipped = text.Length > ReadLimit;
        if (clipped) text = text.Substring(text.Length - ReadLimit);
        Guard.Same(target);
        return new { text = text, chars = text.Length, headClipped = clipped };
    }
}
