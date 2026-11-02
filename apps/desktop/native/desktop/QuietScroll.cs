using System;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

internal sealed partial class QuietAccess
{
    private object ScrollProvider(DesktopTarget target, string snapshot, string control, AutomationElement element, string action, Action check)
    {
        if (action != "scroll_into_view" && action != "scroll_up" && action != "scroll_down" && action != "scroll_left" && action != "scroll_right")
            throw new ArgumentException("Unsupported provider scroll action");
        object pattern;
        var intoView = action == "scroll_into_view";
        if (!element.TryGetCurrentPattern(intoView ? ScrollItemPattern.Pattern : ScrollPattern.Pattern, out pattern))
            throw new InvalidOperationException("This control does not support this background scroll action; choose a scrollable ancestor or request a deliberate foreground handover. No action was sent");
        var horizontal = action == "scroll_left" || action == "scroll_right";
        var before = intoView ? (element.Current.IsOffscreen ? 1.0 : 0.0)
            : horizontal ? ((ScrollPattern)pattern).Current.HorizontalScrollPercent : ((ScrollPattern)pattern).Current.VerticalScrollPercent;
        if (!intoView && before < 0) throw new InvalidOperationException("This control cannot scroll on that axis; no action was sent");
        if (intoView && before == 0) return new { pressed = "none", control = control, satisfied = true, changed = false, foregroundChanged = false };
        var foreground = GetForegroundWindow();
        QuietPatterns.Scroll(target, element, action, delegate { check(); RequireIdle(target); Validate(target); Control(target, snapshot, control); });
        var watch = Stopwatch.StartNew();
        var after = before;
        do {
            check();
            after = intoView ? (element.Current.IsOffscreen ? 1.0 : 0.0)
                : horizontal ? ((ScrollPattern)pattern).Current.HorizontalScrollPercent : ((ScrollPattern)pattern).Current.VerticalScrollPercent;
            if (after != before) break;
            Thread.Sleep(50);
        } while (watch.ElapsedMilliseconds < 800);
        Guard.Same(target);
        return new { pressed = action, control = control, before = before, after = after, satisfied = intoView ? after == 0 : after != before,
            foregroundChanged = ForegroundChanged(foreground), requiresVerification = true };
    }
}
