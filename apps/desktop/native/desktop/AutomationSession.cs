using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows;
using System.Windows.Automation;

internal sealed class AutomationSession
{
    private readonly WindowGuard Guard;
    private static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;
    private const int MaxNodes = 160;
    private const int DeadlineMs = 1800;

    internal AutomationSession(WindowGuard guard) { Guard = guard; }

    private static string RuntimeId(AutomationElement element)
    {
        var id = element.GetRuntimeId();
        if (id == null || id.Length == 0) throw new InvalidOperationException("The control has no stable accessibility identity");
        return string.Join(".", id.Select(part => part.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray());
    }

    private static string TextBudget(string value, int limit, ref int remaining)
    {
        var text = value == null ? "" : value.Substring(0, Math.Min(value.Length, Math.Min(limit, remaining)));
        remaining -= text.Length;
        return text;
    }

    private static object Bounds(Rect value)
    {
        return value.IsEmpty ? new { x = 0.0, y = 0.0, width = 0.0, height = 0.0 }
            : new { x = value.X, y = value.Y, width = value.Width, height = value.Height };
    }

    private static object Node(AutomationElement element, string id, int depth, ref int remaining)
    {
        var current = element.Current;
        string value = null;
        object pattern;
        if (!current.IsPassword && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            value = TextBudget(((ValuePattern)pattern).Current.Value, 4096, ref remaining);
        return new
        {
            id = id, name = current.IsPassword ? "Password field" : TextBudget(current.Name, 512, ref remaining),
            controlType = current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
            value = value, bounds = Bounds(current.BoundingRectangle), enabled = current.IsEnabled,
            password = current.IsPassword, offscreen = current.IsOffscreen, depth = depth
        };
    }

    internal object Observe(DesktopTarget target)
    {
        if (target.Minimized) throw new InvalidOperationException("Restore this window before reading its contents");
        var root = AutomationElement.FromHandle(target.Handle);
        var rootId = RuntimeId(root);
        var nodes = new List<object>();
        var pending = new Queue<Tuple<AutomationElement, int>>();
        var seen = new HashSet<string>();
        pending.Enqueue(Tuple.Create(root, 0));
        var watch = Stopwatch.StartNew();
        var limited = false;
        var remaining = 32768;
        while (pending.Count > 0 && nodes.Count < MaxNodes && watch.ElapsedMilliseconds < DeadlineMs)
        {
            var item = pending.Dequeue();
            var element = item.Item1;
            try
            {
                if (!seen.Add(RuntimeId(element))) continue;
                var id = "e" + nodes.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
                nodes.Add(Node(element, id, item.Item2, ref remaining));
                if (element.Current.IsPassword) continue;
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
        var current = Guard.Resolve(target.Id, target.Pid);
        if (current.Started != target.Started || current.Generation != target.Generation || RuntimeId(AutomationElement.FromHandle(target.Handle)) != rootId)
            throw new InvalidOperationException("The window changed while reading. Select it again.");
        if (nodes.Count == 0) throw new InvalidOperationException("This window does not expose readable accessibility controls");
        return new
        {
            window = target.Id, pid = target.Pid, title = target.Title, snapshot = Guid.NewGuid().ToString("N"),
            expiresInMs = 120000, bounds = Bounds(root.Current.BoundingRectangle), nodes = nodes,
            truncated = limited || remaining == 0 || pending.Count > 0 || watch.ElapsedMilliseconds >= DeadlineMs
        };
    }
}
