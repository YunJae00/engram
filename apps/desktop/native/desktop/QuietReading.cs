using System;
using System.Text;
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
        var root = Validate(target);
        var element = control == null ? root : Control(target, snapshot, control).Element;
        string text;
        var truncated = false;
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
            var tree = ObservationTree.Read(element, MaxControls + MaxTexts, 32, 1800, root.Current.ClassName == "Chrome_WidgetWin_1");
            truncated = tree.Truncated;
            var builder = new StringBuilder();
            foreach (var node in tree.Nodes)
            {
                var info = node.Element.Current;
                if (info.IsPassword) continue;
                if (info.ControlType != ControlType.Text && !(tree.Nodes.Count == 1 && control != null)) continue;
                if (string.IsNullOrWhiteSpace(info.Name)) continue;
                builder.Append(info.Name.Trim()).Append('\n');
                if (builder.Length > ReadLimit + 1) builder.Remove(0, builder.Length - ReadLimit - 1);
            }
            text = builder.ToString();
        }
        text = (text ?? "").Replace("\r\n", "\n").Trim();
        var clipped = text.Length > ReadLimit;
        if (clipped) text = text.Substring(text.Length - ReadLimit);
        Guard.Same(target);
        return new { text = text, chars = text.Length, headClipped = clipped, truncated = truncated || clipped,
            scope = control ?? "window", continuation = truncated || clipped
                ? "Read app_read mode:skeleton, then app_read root with its snapshot; use app_text on the required smaller container. This text is partial." : null };
    }
}
