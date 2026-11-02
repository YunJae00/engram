using System;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

internal sealed partial class QuietAccess
{
    private static bool VisibleInViewport(DesktopTarget target, AutomationElement element)
    {
        var info = element.Current;
        var bounds = info.BoundingRectangle;
        if (info.IsOffscreen || bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0 || !DesktopNative.Bounds(target.Handle).Contains(bounds)) return false;
        var parent = TreeWalker.ControlViewWalker.GetParent(element);
        for (var depth = 0; parent != null && depth < 32; depth++) {
            object scroll;
            if (parent.TryGetCurrentPattern(ScrollPattern.Pattern, out scroll) && !parent.Current.BoundingRectangle.Contains(bounds)) return false;
            if (parent.Current.NativeWindowHandle == unchecked((int)target.Handle.ToInt64())) return true;
            parent = TreeWalker.ControlViewWalker.GetParent(parent);
        }
        return false;
    }
    private object ScrollProvider(DesktopTarget target, string snapshot, string control, AutomationElement element, string action, Action check)
    {
        if (action != "scroll_into_view" && action != "scroll_up" && action != "scroll_down" && action != "scroll_left" && action != "scroll_right")
            throw new ArgumentException("Unsupported provider scroll action");
        object pattern;
        var intoView = action == "scroll_into_view";
        if (!element.TryGetCurrentPattern(intoView ? ScrollItemPattern.Pattern : ScrollPattern.Pattern, out pattern))
            throw new InvalidOperationException("This control does not support this background scroll action; choose a scrollable ancestor or request a deliberate foreground handover. No action was sent");
        var horizontal = action == "scroll_left" || action == "scroll_right";
        var before = intoView ? (VisibleInViewport(target, element) ? 0.0 : 1.0)
            : horizontal ? ((ScrollPattern)pattern).Current.HorizontalScrollPercent : ((ScrollPattern)pattern).Current.VerticalScrollPercent;
        if (double.IsNaN(before) || double.IsInfinity(before)) throw new InvalidOperationException("The provider returned an invalid scroll position; no action was sent");
        if (!intoView && before < 0) throw new InvalidOperationException("This control cannot scroll on that axis; no action was sent");
        if (intoView && before == 0) return new { pressed = "none", control = control, satisfied = true, changed = false, foregroundChanged = false };
        var foreground = GetForegroundWindow();
        QuietPatterns.Scroll(target, element, action, delegate { check(); RequireIdle(target); Validate(target); Control(target, snapshot, control); });
        var watch = Stopwatch.StartNew();
        var after = before;
        do {
            check();
            after = intoView ? (VisibleInViewport(target, element) ? 0.0 : 1.0)
                : horizontal ? ((ScrollPattern)pattern).Current.HorizontalScrollPercent : ((ScrollPattern)pattern).Current.VerticalScrollPercent;
            if (double.IsNaN(after) || double.IsInfinity(after)) throw new InvalidOperationException("The provider returned an invalid scroll position after dispatch; read the app before retrying");
            if (after != before) break;
            Thread.Sleep(50);
        } while (watch.ElapsedMilliseconds < 800);
        Guard.Same(target);
        return new { pressed = action, control = control, before = before, after = after, satisfied = intoView ? after == 0 : after != before,
            foregroundChanged = ForegroundChanged(foreground), requiresVerification = true };
    }
}
