using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows;
using System.Windows.Automation;

internal sealed class ObservedElement
{
    internal AutomationElement Element;
    internal string Runtime;
    internal string Name;
    internal string AutomationId;
    internal int ControlType;
    internal Rect Bounds;
    internal string ReplaceValue;
}

internal sealed class DesktopObservation
{
    internal string Id;
    internal DesktopTarget Target;
    internal Rect Bounds;
    internal long Created;
    internal Rect CaptureBounds;
    internal long Epoch;
    internal string FocusedRuntime;
    internal bool Partial;
    internal bool FocusedOnly;
    internal readonly Dictionary<string, ObservedElement> Elements = new Dictionary<string, ObservedElement>();
}

internal sealed class AutomationSession : IDisposable
{
    private readonly WindowGuard Guard;
    private readonly PasswordScan Passwords = new PasswordScan();
    private static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;
    private const int MaxNodes = 160;
    private const int DeadlineMs = 1800;
    private DesktopObservation Observation;

    internal AutomationSession(WindowGuard guard) { Guard = guard; }
    public void Dispose() { Passwords.Dispose(); }
    internal void Invalidate() { Observation = null; }
    internal static string RuntimeId(AutomationElement element)
    {
        return RuntimeId(element.GetRuntimeId());
    }
    private static string RuntimeId(int[] id)
    {
        if (id == null || id.Length == 0) throw new InvalidOperationException("The control has no stable accessibility identity");
        return string.Join(".", id.Select(part => part.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray());
    }
    private static CacheRequest PropertyCache(params AutomationProperty[] properties)
    {
        var cache = new CacheRequest { TreeScope = TreeScope.Element, TreeFilter = Automation.RawViewCondition };
        foreach (var property in properties) cache.Add(property);
        return cache;
    }
    private static string TextBudget(string value, int limit, ref int remaining)
    {
        var text = value == null ? "" : value.Substring(0, Math.Min(value.Length, Math.Min(limit, remaining)));
        remaining -= text.Length;
        return text;
    }
    internal static object Bounds(Rect value)
    {
        return value.IsEmpty ? new { x = 0.0, y = 0.0, width = 0.0, height = 0.0 }
            : new { x = value.X, y = value.Y, width = value.Width, height = value.Height };
    }
    private static bool Editable(AutomationElement element)
    {
        if (element == null) return false;
        var cache = PropertyCache(AutomationElement.IsPasswordProperty, AutomationElement.IsEnabledProperty,
            AutomationElement.IsOffscreenProperty, AutomationElement.NameProperty, AutomationElement.AutomationIdProperty,
            AutomationElement.ControlTypeProperty, AutomationElement.IsKeyboardFocusableProperty, ValuePattern.IsReadOnlyProperty);
        cache.Add(ValuePattern.Pattern);
        cache.Add(TextPattern.Pattern);
        var fresh = element.GetUpdatedCache(cache);
        var info = fresh.Cached;
        if (info.IsPassword || !info.IsEnabled || info.IsOffscreen || ControlPolicy.IsSensitive(info.Name) || ControlPolicy.IsSensitive(info.AutomationId)) return false;
        object pattern;
        if (fresh.TryGetCachedPattern(ValuePattern.Pattern, out pattern)) return !((ValuePattern)pattern).Cached.IsReadOnly;
        if ((info.ControlType == ControlType.Edit || info.ControlType == ControlType.Document) && fresh.TryGetCachedPattern(TextPattern.Pattern, out pattern))
            return info.IsKeyboardFocusable && object.Equals(((TextPattern)pattern).DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute), false);
        return info.ControlType == ControlType.Edit && info.IsKeyboardFocusable;
    }
    private static object Node(AutomationElement element, string id, string runtime, int depth, ref int remaining, out string replaceValue)
    {
        replaceValue = null;
        var current = element.Current;
        string value = null;
        var valueTruncated = false;
        object pattern;
        if (!current.IsPassword && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            var text = ((ValuePattern)pattern).Current.Value;
            value = TextBudget(text, 4096, ref remaining);
            valueTruncated = text != null && text.Length > value.Length;
            if (!valueTruncated && text != null && text.Length <= 2000 && Editable(element)) replaceValue = text;
        }
        else if (!current.IsPassword && (current.ControlType == ControlType.Edit || current.ControlType == ControlType.Document)
            && element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
        {
            var text = ((TextPattern)pattern).DocumentRange.GetText(Math.Min(4096, remaining) + 1);
            value = TextBudget(text, 4096, ref remaining);
            valueTruncated = text != null && text.Length > value.Length;
        }
        return new
        {
            id = id, runtimeId = runtime, name = current.IsPassword ? "Password field" : TextBudget(current.Name, 512, ref remaining),
            controlType = current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
            value = value, valueTruncated = valueTruncated, bounds = Bounds(current.BoundingRectangle), enabled = current.IsEnabled,
            password = current.IsPassword, isPassword = current.IsPassword, offscreen = current.IsOffscreen, depth = depth,
            actions = new { click = current.IsEnabled && !current.IsPassword && !current.IsOffscreen,
                type = Editable(element), replace = replaceValue != null, scroll = element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern) }
        };
    }
    internal object Observe(DesktopTarget target, LeaseState lease, bool focusedOnly = false)
    {
        if (target.Minimized) throw new InvalidOperationException("Restore this window before reading its contents");
        var root = AutomationElement.FromHandle(target.Handle);
        var rootId = RuntimeId(root);
        var observation = new DesktopObservation { Id = Guid.NewGuid().ToString("N"), Target = target, FocusedOnly = focusedOnly,
            Bounds = DesktopNative.Bounds(target.Handle), CaptureBounds = DesktopCapture.Bounds(target.Handle), Created = Stopwatch.GetTimestamp(), Epoch = lease == null ? 0 : lease.Epoch };
        var nodes = new List<object>();
        var protectedBounds = new List<object>();
        var pending = new Queue<Tuple<AutomationElement, int>>();
        var seen = new HashSet<string>();
        pending.Enqueue(Tuple.Create(root, 0));
        var watch = Stopwatch.StartNew();
        try
        {
            var initialFocus = AutomationElement.FocusedElement;
            if (initialFocus != null)
            {
                SafeAncestors(initialFocus, rootId);
                pending.Enqueue(Tuple.Create(initialFocus, 1));
            }
        }
        catch (ElementNotAvailableException) { /* Traverse the remaining controls when focus disappears. */ }
        catch (InvalidOperationException) { /* Do not prioritize controls inside protected or foreign paths. */ }
        var limited = false;
        var remaining = 32768;
        while (pending.Count > 0 && nodes.Count < MaxNodes && watch.ElapsedMilliseconds < DeadlineMs)
        {
            var item = pending.Dequeue();
            var element = item.Item1;
            try
            {
                var runtime = RuntimeId(element);
                if (!seen.Add(runtime)) continue;
                var id = "e" + nodes.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
                string replaceValue;
                nodes.Add(Node(element, id, runtime, item.Item2, ref remaining, out replaceValue));
                var info = element.Current;
                observation.Elements.Add(id, new ObservedElement { Element = element, Runtime = runtime, Name = info.Name,
                    AutomationId = info.AutomationId, ControlType = info.ControlType.Id, Bounds = info.BoundingRectangle, ReplaceValue = replaceValue });
                if (element.Current.IsPassword)
                {
                    if (!element.Current.IsOffscreen) protectedBounds.Add(Bounds(element.Current.BoundingRectangle));
                    continue;
                }
                if (focusedOnly) continue;
                if (item.Item2 >= 32) { limited = true; continue; }
                var child = Walker.GetFirstChild(element);
                while (child != null && nodes.Count + pending.Count < MaxNodes && watch.ElapsedMilliseconds < DeadlineMs)
                {
                    pending.Enqueue(Tuple.Create(child, item.Item2 + 1));
                    child = Walker.GetNextSibling(child);
                }
                if (child != null) limited = true;
            }
            catch (ElementNotAvailableException) { limited = true; }
        }
        Guard.Same(target);
        if (RuntimeId(AutomationElement.FromHandle(target.Handle)) != rootId || DesktopNative.Bounds(target.Handle) != observation.Bounds)
            throw new InvalidOperationException("The window changed while reading. Observe it again.");
        if (nodes.Count == 0) throw new InvalidOperationException("This window does not expose readable accessibility controls");
        var focused = AutomationElement.FocusedElement;
        var focusedInside = Inside(focused, rootId);
        var focusedEditable = focusedInside && Editable(focused);
        observation.FocusedRuntime = focusedInside ? RuntimeId(focused) : null;
        Observation = observation;
        observation.Partial = focusedOnly || limited || remaining == 0 || pending.Count > 0 || watch.ElapsedMilliseconds >= DeadlineMs;
        return new
        {
            window = target.Id, pid = target.Pid, title = target.Title, snapshot = observation.Id,
            expiresInMs = 15000, bounds = Bounds(observation.Bounds), captureBounds = Bounds(observation.CaptureBounds), nodes = nodes, protectedBounds = protectedBounds,
            focusedEditable = focusedEditable,
            focusedControl = observation.FocusedRuntime,
            truncated = observation.Partial, scope = focusedOnly ? "focus" : "window",
            captureSafe = !focusedOnly && (!observation.Partial || CanCapturePartial(target))
        };
    }
    internal void RequireCapture(string snapshot, DesktopTarget target)
    {
        var value = Observation;
        if (value == null || value.Id != snapshot || value.Target.Id != target.Id || value.Target.Pid != target.Pid
            || (Stopwatch.GetTimestamp() - value.Created) * 1000.0 / Stopwatch.Frequency > 15000)
            throw new InvalidOperationException("Observe this app before requesting an image");
        if (value.FocusedOnly) throw new InvalidOperationException("Observe the full window before requesting an image");
        Guard.Same(target);
        if (value.Partial && !CanCapturePartial(target)) throw new InvalidOperationException("The incomplete view could not be cleared for capture");
        if (DesktopNative.Bounds(target.Handle) != value.Bounds || DesktopCapture.Bounds(target.Handle) != value.CaptureBounds)
            throw new InvalidOperationException("The app geometry changed. Observe it again");
    }
    private bool CanCapturePartial(DesktopTarget target)
    {
        try
        {
            Guard.Same(target);
            var root = AutomationElement.FromHandle(target.Handle);
            if (ControlPolicy.IsSensitive(target.Title) || ControlPolicy.IsSensitive(root.Current.Name)) return false;
            return !Passwords.HasVisiblePassword(target.Handle, root, target.Pid);
        }
        catch (ElementNotAvailableException) { return false; }
    }
    private static bool Inside(AutomationElement element, string rootId)
    {
        for (var depth = 0; element != null && depth < 48; depth++, element = TreeWalker.RawViewWalker.GetParent(element))
            if (RuntimeId(element) == rootId) return true;
        return false;
    }
    private static void SafeAncestors(AutomationElement element, string rootId)
    {
        var cache = PropertyCache(AutomationElement.IsPasswordProperty, AutomationElement.NameProperty,
            AutomationElement.AutomationIdProperty, AutomationElement.RuntimeIdProperty);
        if (element != null) element = element.GetUpdatedCache(cache);
        for (var depth = 0; element != null && depth < 48; depth++, element = TreeWalker.RawViewWalker.GetParent(element, cache))
        {
            var info = element.Cached;
            if (info.IsPassword || ControlPolicy.IsSensitive(info.Name) || ControlPolicy.IsSensitive(info.AutomationId))
                throw new InvalidOperationException("Authentication, password, terminal, and security surfaces require manual control");
            if (RuntimeId(element.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty) as int[]) == rootId) return;
        }
        throw new InvalidOperationException("The control is outside the selected application window");
    }
    internal DesktopObservation Require(string snapshot, LeaseState lease)
    {
        var value = Observation;
        if (value == null || value.Id != snapshot || value.Epoch != lease.Epoch || value.Target.Id != lease.Target.Id
            || value.Target.Pid != lease.Target.Pid || (Stopwatch.GetTimestamp() - value.Created) * 1000.0 / Stopwatch.Frequency > 15000)
            throw new InvalidOperationException("Observe this application again before sending input");
        Validate(lease.Target);
        if (DesktopNative.Bounds(lease.Target.Handle) != value.Bounds || DesktopCapture.Bounds(lease.Target.Handle) != value.CaptureBounds)
            throw new InvalidOperationException("The window moved or resized. Observe it again before sending input");
        return value;
    }
    internal void Validate(DesktopTarget target)
    {
        Guard.Same(target);
        DesktopNative.Foreground(target);
        if (ControlPolicy.IsSensitive(target.Title)) throw new InvalidOperationException("This application surface requires manual control");
        var root = AutomationElement.FromHandle(target.Handle);
        if (Passwords.HasVisiblePassword(target.Handle, root, target.Pid)) throw new InvalidOperationException("Password and authentication entry must be completed manually");
        if (ControlPolicy.IsSensitive(root.Current.Name)) throw new InvalidOperationException("This application surface requires manual control");
        var focused = AutomationElement.FocusedElement;
        if (focused != null && Inside(focused, RuntimeId(root))) SafeAncestors(focused, RuntimeId(root));
    }
    internal Point ClickPoint(DesktopObservation observation, string id, int? x, int? y)
    {
        AutomationElement element;
        Point point;
        if (id != null)
        {
            ObservedElement observed;
            if (!observation.Elements.TryGetValue(id, out observed) || RuntimeId(observed.Element) != observed.Runtime)
                throw new InvalidOperationException("This control is no longer available. Observe the application again");
            element = observed.Element;
            var info = element.Current;
            var bounds = info.BoundingRectangle;
            if (info.Name != observed.Name || info.AutomationId != observed.AutomationId || info.ControlType.Id != observed.ControlType || bounds != observed.Bounds)
                throw new InvalidOperationException("The selected control changed. Observe the application again");
            if (bounds.IsEmpty || !info.IsEnabled || info.IsOffscreen) throw new InvalidOperationException("This control is not currently clickable");
            point = new Point(Math.Floor(bounds.X + bounds.Width / 2), Math.Floor(bounds.Y + bounds.Height / 2));
        }
        else
        {
            if (!x.HasValue || !y.HasValue) throw new ArgumentException("A control or both screen coordinates are required");
            point = new Point(x.Value, y.Value);
            element = AutomationElement.FromPoint(point);
        }
        if (!observation.Bounds.Contains(point) || !DesktopNative.AtTarget(observation.Target.Handle, (int)point.X, (int)point.Y))
            throw new InvalidOperationException("The input position is covered or outside the chosen window");
        SafeAncestors(element, RuntimeId(AutomationElement.FromHandle(observation.Target.Handle)));
        return point;
    }
    internal AutomationElement RequireFocus(DesktopObservation observation)
    {
        var focused = AutomationElement.FocusedElement;
        if (focused == null || observation.FocusedRuntime == null || RuntimeId(focused) != observation.FocusedRuntime)
            throw new InvalidOperationException("Keyboard focus changed. Observe the application again");
        SafeAncestors(focused, RuntimeId(AutomationElement.FromHandle(observation.Target.Handle)));
        return focused;
    }
    internal void RequireEditable(DesktopObservation observation)
    {
        // Prepare already validates this window for each input packet.
        var focused = RequireFocus(observation);
        if (!Editable(focused)) throw new InvalidOperationException("Select a non-password editable field before typing");
    }
    internal ValuePattern RequireReplacement(DesktopObservation observation, string id, string expected)
    {
        ClickPoint(observation, id, null, null);
        RequireEditable(observation);
        var observed = observation.Elements[id];
        if (observed.Runtime != observation.FocusedRuntime || observed.ReplaceValue == null || observed.ReplaceValue != expected)
            throw new InvalidOperationException("Replacement requires the complete observed value of the focused field");
        object pattern;
        if (!observed.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
            throw new InvalidOperationException("This field does not support writable value replacement");
        var value = (ValuePattern)pattern;
        if (value.Current.Value != expected)
            throw new InvalidOperationException("The field value changed. Observe it again before replacing its contents");
        return value;
    }
}
