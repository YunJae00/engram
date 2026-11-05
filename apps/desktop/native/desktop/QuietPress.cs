using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

internal sealed partial class QuietAccess
{
    private static Dictionary<string, object> ReadState(AutomationElement element, bool cached = false)
    {
        var result = new Dictionary<string, object>();
        object pattern;
        if ((!cached || Has(element, AutomationElement.IsTogglePatternAvailableProperty)) && element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
            result["checked"] = ((TogglePattern)pattern).Current.ToggleState.ToString().ToLowerInvariant();
        if ((!cached || Has(element, AutomationElement.IsSelectionItemPatternAvailableProperty)) && element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            result["selected"] = ((SelectionItemPattern)pattern).Current.IsSelected;
        if ((!cached || Has(element, AutomationElement.IsExpandCollapsePatternAvailableProperty)) && element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
            result["expanded"] = ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState.ToString().ToLowerInvariant();
        return result;
    }
    private static bool Satisfied(Dictionary<string, object> state, string desired)
    {
        object value;
        if (desired == "checked" || desired == "unchecked") return state.TryGetValue("checked", out value) && Equals(value, desired == "checked" ? "on" : "off");
        if (desired == "selected") return state.TryGetValue("selected", out value) && Equals(value, true);
        return state.TryGetValue("expanded", out value) && Equals(value, desired);
    }
    internal object Press(DesktopTarget target, string snapshot, string control, Action check, string desired = null, string action = null)
    {
        RequireOperable(target);
        Validate(target);
        var element = Control(target, snapshot, control).Element;
        Priorities[target.Id] = element;
        if (!element.Current.IsEnabled) throw new InvalidOperationException("This control is disabled right now");
        check();
        RequireIdle(target);
        var foreground = GetForegroundWindow();
        if (action != null) {
            if (desired != null) throw new ArgumentException("Choose a scroll action or desired state, not both");
            return ScrollProvider(target, snapshot, control, element, action, check);
        }
        var before = ReadState(element);
        if (desired != null && desired != "checked" && desired != "unchecked" && desired != "selected" && desired != "expanded" && desired != "collapsed")
            throw new ArgumentException("Unsupported desired control state");
        if (desired != null && Satisfied(before, desired)) return new { pressed = "none", control = control, before = before, after = before,
            satisfied = true, changed = false, foregroundChanged = false, requiresVerification = false };
        object pattern;
        string how;
        if (desired == "checked" || desired == "unchecked") {
            if (!before.ContainsKey("checked")) throw new InvalidOperationException("This control does not expose a checked state; no action was sent");
            how = "toggle";
        }
        else if (desired == "selected") {
            if (!before.ContainsKey("selected")) throw new InvalidOperationException("This control does not expose selection; no action was sent");
            how = "select";
        }
        else if (desired != null) {
            if (!before.ContainsKey("expanded")) throw new InvalidOperationException("This control does not expose expansion; no action was sent");
            if (Equals(before["expanded"], "leafnode")) throw new InvalidOperationException("This control does not expose expansion; no action was sent");
            how = desired == "expanded" ? "expand" : "collapse";
        }
        else if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) how = "invoke";
        else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) how = "toggle";
        else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) how = "select";
        else if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
            how = ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState == ExpandCollapseState.Expanded ? "collapse" : "expand";
        else how = "posted";
        Action current = delegate { check(); RequireIdle(target); Validate(target); Control(target, snapshot, control); };
        if (how == "posted") QuietPostedInput.Click(target, element, current);
        else QuietPatterns.Press(target, element, how, current);
        var after = ReadState(element);
        var watch = Stopwatch.StartNew();
        while (desired != null && !Satisfied(after, desired) && watch.ElapsedMilliseconds < 600) {
            check(); Thread.Sleep(50); after = ReadState(element);
        }
        Guard.Same(target);
        var changedForeground = ForegroundChanged(foreground);
        var restoredForeground = false;
        if (changedForeground) {
            try { restoredForeground = DesktopNative.RestoreForeground(foreground); }
            catch { }
        }
        return new { pressed = how, control = control, before = before, after = after,
            satisfied = desired == null ? (bool?)null : Satisfied(after, desired), foregroundChanged = changedForeground, foregroundRestored = restoredForeground, requiresVerification = true };
    }
}
