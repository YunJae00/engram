using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Windows.Automation;

internal sealed class ObservationNode
{
    internal AutomationElement Element;
    internal int Depth;
    internal int ChildCount;
    internal bool Truncated;
    internal bool Transparent;
}

internal sealed class ObservationTree
{
    internal readonly List<ObservationNode> Nodes = new List<ObservationNode>();
    internal bool Truncated;
    internal static bool Skeleton(string mode, string root, string snapshot)
    {
        if (mode != null && mode != "full" && mode != "skeleton" || (root == null) != (snapshot == null) || mode == "skeleton" && root != null)
            throw new ArgumentException("Invalid observation mode or root");
        return mode == "skeleton";
    }
    internal static bool EmptyContainer(AutomationElement element)
    {
        var info = element.Current;
        if (info.IsPassword || !string.IsNullOrEmpty(info.Name) || !string.IsNullOrEmpty(info.AutomationId)
            || info.ControlType != ControlType.Group && info.ControlType != ControlType.Pane && info.ControlType != ControlType.Custom) return false;
        object pattern;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return false;
        foreach (var supported in element.GetSupportedPatterns())
        {
            if (supported.Id != 10018) return false;
            foreach (var id in new[] { 30093, 30100 })
            {
                var property = AutomationProperty.LookupById(id);
                if (property == null) return false;
                var value = element.GetCurrentPropertyValue(property, true);
                if (!(value is string) || !string.IsNullOrEmpty((string)value)) return false;
            }
        }
        return true;
    }
    internal static ObservationTree Read(AutomationElement root, int cap, int depthLimit, int milliseconds, bool web = false, AutomationElement priority = null, Action<ObservationNode> visit = null)
    {
        var result = new ObservationTree();
        var pending = new Queue<ObservationNode>();
        var seen = new HashSet<string>();
        var watch = Stopwatch.StartNew();
        var queuedNodes = 1;
        pending.Enqueue(new ObservationNode { Element = root });
        if (priority != null) { pending.Enqueue(new ObservationNode { Element = priority, Depth = 1 }); queuedNodes++; }
        while (pending.Count > 0 && result.Nodes.Count < cap && watch.ElapsedMilliseconds < milliseconds)
        {
            var node = pending.Dequeue();
            if (!node.Transparent) queuedNodes--;
            try
            {
                if (!seen.Add(AutomationSession.RuntimeId(node.Element))) continue;
                var skip = web && EmptyContainer(node.Element);
                if (!skip) result.Nodes.Add(node);
                if (node.Element.Current.IsPassword) { if (visit != null && !skip) visit(node); continue; }
                var walker = TreeWalker.ControlViewWalker;
                var child = walker.GetFirstChild(node.Element);
                while (child != null && watch.ElapsedMilliseconds < milliseconds)
                {
                    node.ChildCount++;
                    if (skip || node.Depth < depthLimit)
                    {
                        var transparent = web && EmptyContainer(child);
                        if (!transparent && result.Nodes.Count + queuedNodes >= cap) { node.Truncated = true; break; }
                        pending.Enqueue(new ObservationNode { Element = child, Depth = node.Depth + (skip ? 0 : 1), Transparent = transparent });
                        if (!transparent) queuedNodes++;
                    }
                    else node.Truncated = true;
                    child = walker.GetNextSibling(child);
                }
                if (child != null) node.Truncated = true;
                result.Truncated |= node.Truncated;
                if (visit != null && !skip) visit(node);
            }
            catch (ElementNotAvailableException) { node.Truncated = result.Truncated = true; }
        }
        if (pending.Count > 0)
        {
            result.Truncated = true;
            foreach (var node in result.Nodes) if (node.ChildCount > 0) node.Truncated = true;
        }
        return result;
    }
}
