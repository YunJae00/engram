using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows.Automation;

internal sealed partial class QuietAccess
{
    private readonly Dictionary<string, AutomationElement> Priorities = new Dictionary<string, AutomationElement>();

    private static AutomationElement Neighborhood(AutomationElement element, AutomationElement root)
    {
        var current = element;
        for (var i = 0; i < 3 && AutomationSession.RuntimeId(current) != AutomationSession.RuntimeId(root); i++) {
            var parent = TreeWalker.ControlViewWalker.GetParent(current);
            if (parent == null) break;
            current = parent;
        }
        AutomationSession.SafeAncestors(current, AutomationSession.RuntimeId(root));
        return current;
    }
    private AutomationElement Priority(DesktopTarget target, AutomationElement root)
    {
        AutomationElement element;
        if (Priorities.TryGetValue(target.Id, out element)) Priorities.Remove(target.Id);
        else element = AutomationElement.FocusedElement;
        try { return element == null ? null : Neighborhood(element, root); }
        catch (ElementNotAvailableException) { Priorities.Remove(target.Id); return null; }
        catch (InvalidOperationException) { Priorities.Remove(target.Id); return null; }
    }
    private static ObservationTree Search(AutomationElement root, string wanted, out bool textsTruncated)
    {
        var tree = new ObservationTree();
        var cache = new CacheRequest { TreeScope = TreeScope.Element };
        cache.Add(AutomationElement.NameProperty);
        cache.Add(ValuePattern.ValueProperty);
        var watch = Stopwatch.StartNew();
        // Controls decide completeness; text matches are best effort in the remaining budget, since legacy
        // providers answer each text node slowly and a send button must still be found behind them.
        tree.Truncated = Collect(root, Interactive, wanted, cache, watch, tree.Nodes);
        textsTruncated = tree.Truncated || Collect(root, Textual, wanted, cache, watch, tree.Nodes);
        return tree;
    }
    private static bool Collect(AutomationElement root, IEnumerable<ControlType> types, string wanted, CacheRequest cache, Stopwatch watch, List<ObservationNode> nodes)
    {
        if (SearchLimit(0, watch.ElapsedMilliseconds)) return true;
        var condition = new AndCondition(Automation.ControlViewCondition, TypeCondition(types), new PropertyCondition(AutomationElement.IsPasswordProperty, false));
        AutomationElementCollection found;
        using (cache.Activate()) found = root.FindAll(TreeScope.Descendants, condition);
        for (var index = 0; index < found.Count; index++) {
            if (SearchLimit(index, watch.ElapsedMilliseconds)) return true;
            var element = found[index];
            var name = element.GetCachedPropertyValue(AutomationElement.NameProperty, true) as string;
            var value = element.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string;
            if (Matches(name, value, wanted)) nodes.Add(new ObservationNode { Element = element });
        }
        return SearchLimit(found.Count, watch.ElapsedMilliseconds);
    }
    // A targeted find may take longer than the 1800 ms broad read: legacy providers answer a few hundred
    // nodes in several seconds, and the host waits 30 s for any single request.
    internal static bool SearchLimit(int candidates, long milliseconds) { return candidates >= 20000 || milliseconds >= 5000; }
    internal static List<object> OptionalNearby(Func<List<object>> read)
    {
        try { return read(); }
        catch (ElementNotAvailableException) { return null; }
        catch (InvalidOperationException) { return null; }
        catch (System.Runtime.InteropServices.COMException) { return null; }
    }
    internal static bool Matches(string name, string value, string wanted)
    {
        return wanted == null || (name ?? "").IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) >= 0
            || (value ?? "").IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) >= 0;
    }
    internal static bool HoldsText(string value) { return !string.IsNullOrWhiteSpace(value); }
    private List<object> Nearby(DesktopTarget target, string snapshot, AutomationElement element, HashSet<string> before)
    {
        // The write just revalidated this window; the receipt only reads button names, so no second password scan.
        Guard.Same(target);
        var root = AutomationElement.FromHandle(target.Handle);
        var area = Neighborhood(element, root);
        var held = Snapshots.First(one => one.Id == snapshot);
        var result = new List<object>();
        foreach (AutomationElement button in area.FindAll(TreeScope.Descendants, TypeCondition(new[] { ControlType.Button, ControlType.SplitButton }))) {
            try { AutomationSession.SafeAncestors(button, held.RootRuntime); }
            catch (InvalidOperationException) { continue; }
            var runtime = AutomationSession.RuntimeId(button);
            var id = held.Controls.FirstOrDefault(one => one.Value.Runtime == runtime).Key;
            if (id == null) {
                id = "c" + (10000 + held.Controls.Count);
                held.Controls.Add(id, new QuietControl { Element = button, Runtime = runtime, Name = button.Current.Name, ControlType = button.Current.ControlType.Id });
            }
            result.Add(new { name = Clip(button.Current.Name, NameLimit), runtimeId = runtime, id = id, enabled = button.Current.IsEnabled, appeared = !before.Contains(runtime) });
        }
        Guard.Same(target);
        return result;
    }
    private HashSet<string> NearbyIds(AutomationElement element, AutomationElement root)
    {
        return new HashSet<string>(Neighborhood(element, root).FindAll(TreeScope.Descendants,
            TypeCondition(new[] { ControlType.Button, ControlType.SplitButton })).Cast<AutomationElement>().Select(AutomationSession.RuntimeId));
    }
}
