using System;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal sealed partial class QuietAccess
{
    internal object Read(DesktopTarget target, string snapshot, string control)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { return ReadOnce(target, snapshot, control); }
            catch (ElementNotAvailableException) { if (attempt == 1) throw; }
            catch (System.Runtime.InteropServices.COMException) { if (attempt == 1) throw; }
            Thread.Sleep(300);
        }
    }
    private object ReadOnce(DesktopTarget target, string snapshot, string control)
    {
        if (target.Minimized) throw new InvalidOperationException("Restore this window before reading it");
        var foreground = GetForegroundWindow();
        var root = Validate(target);
        var element = control == null ? root : Control(target, snapshot, control).Element;
        string text;
        var truncated = false;
        var headClipped = false;
        object pattern;
        if (control != null && element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
        {
            var range = ((TextPattern)pattern).DocumentRange;
            range.MoveEndpointByRange(TextPatternRangeEndpoint.Start, range, TextPatternRangeEndpoint.End);
            range.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -(ReadLimit + 1));
            text = range.GetText(ReadLimit + 1);
        }
        else if (control != null && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            text = ((ValuePattern)pattern).Current.Value;
        else
        {
            var tail = ReadTail(element, control != null);
            text = tail.Item1;
            headClipped = tail.Item2;
            truncated = headClipped && string.IsNullOrWhiteSpace(text);
        }
        text = (text ?? "").Replace("\r\n", "\n").Trim();
        var clipped = text.Length > ReadLimit;
        if (clipped) text = text.Substring(text.Length - ReadLimit);
        Guard.Same(target);
        var changedForeground = ForegroundChanged(foreground);
        var restoredForeground = false;
        if (changedForeground) {
            try { restoredForeground = DesktopNative.RestoreForeground(foreground); }
            catch { }
        }
        return new { foregroundChanged = changedForeground, foregroundRestored = restoredForeground, text = text, chars = text.Length, headClipped = headClipped || clipped, truncated = truncated,
            scope = control ?? "window", continuation = truncated || headClipped || clipped
                ? "Read app_read mode:skeleton, then app_read root with its snapshot; use app_text on the required smaller container. This text is partial." : null };
    }
    private static Tuple<string, bool> ReadTail(AutomationElement root, bool fallbackName)
    {
        var builder = new StringBuilder();
        var watch = Stopwatch.StartNew();
        var remaining = MaxControls + MaxTexts;
        var clipped = false;
        var walker = TreeWalker.ControlViewWalker;
        Func<AutomationElement, int, bool> visit = null;
        visit = delegate(AutomationElement element, int depth) {
            if (remaining-- <= 0 || watch.ElapsedMilliseconds >= 1800 || depth > 32) { clipped = true; return false; }
            var info = element.Current;
            if (info.IsPassword) return true;
            if (info.ControlType == ControlType.Text) {
                if (!string.IsNullOrWhiteSpace(info.Name)) builder.Insert(0, info.Name.Trim() + "\n");
                if (builder.Length > ReadLimit + 1) { builder.Remove(0, builder.Length - ReadLimit - 1); clipped = true; return false; }
                return true;
            }
            var child = walker.GetLastChild(element);
            if (child == null && depth == 0 && fallbackName) builder.Append(info.Name);
            while (child != null) {
                if (!visit(child, depth + 1)) return false;
                child = walker.GetPreviousSibling(child);
            }
            return true;
        };
        visit(root, 0);
        return Tuple.Create(builder.ToString(), clipped);
    }

}
