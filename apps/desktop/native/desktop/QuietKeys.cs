using System;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

internal sealed partial class QuietAccess
{
    private static string KeyEffect(AutomationElement element)
    {
        object pattern;
        var value = element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) ? ((ValuePattern)pattern).Current.Value : "";
        var focus = AutomationElement.FocusedElement;
        return value + "|" + (focus == null ? "" : AutomationSession.RuntimeId(focus)) + "|" + string.Join(",", ReadState(element).Values);
    }
    private object PressKey(DesktopTarget target, string snapshot, string control, AutomationElement element, string key, Action check)
    {
        QuietPostedInput.KeyCodes(key);
        var before = KeyEffect(element);
        var foreground = GetForegroundWindow();
        QuietPostedInput.Key(target, element, key, delegate { check(); RequireIdle(target); Validate(target); Control(target, snapshot, control); });
        var watch = Stopwatch.StartNew();
        var changed = false;
        while (watch.ElapsedMilliseconds < 700 && !changed) {
            check(); Thread.Sleep(50);
            try { changed = KeyEffect(element) != before; }
            catch (ElementNotAvailableException) { changed = true; }
        }
        Guard.Same(target);
        var activated = ForegroundChanged(foreground);
        return new { pressed = "posted", key = key, control = control, landed = changed,
            delivery = changed ? "delivered_unverified" : "not_delivered", retry = "unsafe",
            message = changed ? "" : "This app does not accept background keys, or no effect could be verified. Read the app before continuing.",
            foregroundChanged = activated, foregroundRestored = activated && DesktopNative.RestoreForeground(foreground), requiresVerification = true };
    }
}
