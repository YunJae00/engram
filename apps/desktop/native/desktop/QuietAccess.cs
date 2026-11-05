using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;

// Background input uses providers or messages to the app process. Providers may activate
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

internal sealed partial class QuietAccess : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { internal uint Size; internal uint Time; }
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    // The desktop shell window: its icons are launchers, so it is read but never operated.
    private static void RequireOperable(DesktopTarget target)
    {
        var name = new StringBuilder(64);
        GetClassName(target.Handle, name, name.Capacity);
        var cls = name.ToString();
        if (cls == "Progman" || cls == "WorkerW") throw new InvalidOperationException("The desktop itself is only read; open apps with open_app.");
    }

    private const int MaxControls = 320;
    private const int MaxTexts = 160;
    // Fewer nodes than this from a window with a real page means the provider has not woken yet.
    private const int SparseNodes = 12;
    private const int NameLimit = 300;
    private const int ValueLimit = 600;
    private const int ReadLimit = 12000;
    private const double SnapshotMs = 300000;
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
        DesktopNative.RequireResponsive(target);
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
            AutomationElement.IsScrollPatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty, AutomationElement.IsTextPatternAvailableProperty, AutomationElement.RuntimeIdProperty, AutomationElement.IsKeyboardFocusableProperty, ValuePattern.IsReadOnlyProperty }) cache.Add(property);
        cache.Add(ValuePattern.Pattern);
        return cache;
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
        // A snapshot outlives a slow thought and other chats listing windows; each control is still checked to be the same one below.
        if (held.Target.Started != target.Started
            || (Stopwatch.GetTimestamp() - held.Created) * 1000.0 / Stopwatch.Frequency > SnapshotMs
            || AutomationSession.RuntimeId(AutomationElement.FromHandle(target.Handle)) != held.RootRuntime)
            throw new InvalidOperationException("Read the app again before acting. This snapshot is stale.");
        QuietControl found;
        if (!held.Controls.TryGetValue(control, out found)) throw new ArgumentException("Unknown control ID for this snapshot");
        try { if (AutomationSession.RuntimeId(found.Element) != found.Runtime) throw new InvalidOperationException("The control changed. Read the app again."); }
        catch (ElementNotAvailableException) { throw new InvalidOperationException("The control is no longer there. Read the app again."); }
        var current = found.Element.Current;
        if (current.Name != found.Name || current.ControlType.Id != found.ControlType)
            throw new InvalidOperationException("The control changed. Read the app again.");
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
        RequireOperable(target);
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
        // An empty field that reports its own hint as its value holds nothing anyone typed.
        var hint = before.Trim().Length > 0 && Flat(before) == Flat(element.Current.Name);
        if (HoldsText(before) && !hint && before != expected)
            throw new InvalidOperationException("The field already holds text this chat did not put there: \"" + Clip(before, 120) + "\". Leave it, or pass that exact text as expected to replace it.");
        var nearbyBefore = NearbyIds(element, AutomationElement.FromHandle(target.Handle));
        Priorities[target.Id] = element;
        var watch = Stopwatch.StartNew();
        check();
        RequireIdle(target);
        var foreground = GetForegroundWindow();
        QuietPatterns.Set(target, element, text, delegate {
            check(); RequireIdle(target); Validate(target); Control(target, snapshot, control);
            if ((value.Current.Value ?? "") != before) throw new InvalidOperationException("The field changed. Read the app again");
        });
        var landed = false;
        string after = null;
        while (watch.ElapsedMilliseconds < LandMs)
        {
            after = value.Current.Value ?? "";
            if (after == text) { landed = true; break; }
            System.Threading.Thread.Sleep(100);
        }
        var how = "ax";
        if (!landed) {
            how = "posted";
            QuietPostedInput.Text(target, element, text, delegate {
                check(); RequireIdle(target); Validate(target); Control(target, snapshot, control);
            });
            after = value.Current.Value ?? "";
            landed = after == text;
        }
        Guard.Same(target);
        // Landed says the text is in the field; exact says nothing else is. A field holding more carries text from elsewhere.
        var changedForeground = ForegroundChanged(foreground);
        var restoredForeground = false;
        if (changedForeground) {
            try { restoredForeground = DesktopNative.RestoreForeground(foreground); }
            catch { }
        }
        return new { snapshot = snapshot, nearby = OptionalNearby(delegate { return Nearby(target, snapshot, element, nearbyBefore); }), how = how, message = landed ? "" : "The app did not take background text; its own search or field may need the person", landed = landed, exact = landed, value = Clip(after, ValueLimit), ms = watch.ElapsedMilliseconds, control = control,
            foregroundChanged = changedForeground, foregroundRestored = restoredForeground, requiresVerification = true };
    }

}
