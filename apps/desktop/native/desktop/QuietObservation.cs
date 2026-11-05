using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows.Automation;

internal sealed partial class QuietAccess
{
    internal object Scan(DesktopTarget target, string find, string mode = null, string rootId = null, string previous = null)
    {
        ObservationTree.Skeleton(mode, rootId, previous);
        object result = null;
        var activationAttempted = false;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            int nodes;
            bool cold;
            try { result = ScanOnce(target, find, mode, rootId, previous, activationAttempted, out nodes, out cold); }
            catch (ElementNotAvailableException) { if (attempt == 2) throw; System.Threading.Thread.Sleep(300); continue; }
            catch (System.Runtime.InteropServices.COMException) { if (attempt == 2) throw; System.Threading.Thread.Sleep(300); continue; }
            if (!string.IsNullOrWhiteSpace(find) || mode == "skeleton" || rootId != null || attempt == 2) break;
            if (cold && !activationAttempted && string.IsNullOrWhiteSpace(find)) {
                Guard.Same(target);
                ChromiumAccessibility.Wake(target.Handle);
                activationAttempted = true;
                System.Threading.Thread.Sleep(1500);
                continue;
            } else if (nodes >= SparseNodes || activationAttempted) break;
            System.Threading.Thread.Sleep(400);
        }
        return result;
    }
    private object ScanOnce(DesktopTarget target, string find, string mode, string rootId, string previous, bool activationAttempted, out int nodes, out bool cold)
    {
        if (target.Minimized) throw new InvalidOperationException("Restore this window before reading it");
        var root = Validate(target);
        var snapshot = new QuietSnapshot { Id = Guid.NewGuid().ToString("N"), Target = target, RootRuntime = AutomationSession.RuntimeId(root) };
        var wanted = string.IsNullOrWhiteSpace(find) ? null : find.Trim();
        var watch = Stopwatch.StartNew();
        var readingRoot = rootId == null ? root : Control(target, previous, rootId).Element;
        var tree = wanted != null ? Search(readingRoot) : ObservationTree.Read(readingRoot, MaxControls + MaxTexts, mode == "skeleton" ? 3 : 32, 1800, root.Current.ClassName == "Chrome_WidgetWin_1", rootId == null ? Priority(target, root) : null);
        cold = ChromiumAccessibility.IsCold(root.Current.ClassName, tree);
        var metadata = tree.Nodes.ToDictionary(node => AutomationSession.RuntimeId(node.Element));
        var cached = new List<AutomationElement>();
        foreach (var node in tree.Nodes) {
            if (wanted != null && SearchLimit(cached.Count, watch.ElapsedMilliseconds)) { tree.Truncated = true; break; }
            cached.Add(node.Element.GetUpdatedCache(Cache()));
        }
        var interactive = cached.Where(element => element.Cached.ControlType != ControlType.Text).ToList();
        var textual = cached.Where(element => element.Cached.ControlType == ControlType.Text).ToList();
        var controls = new List<object>();
        var texts = new List<object>();
        var remaining = ReadLimit;
        var seen = new HashSet<string>();
        var ids = new Dictionary<string, string>();
        var order = new Dictionary<string, int>();
        for (var index = 0; index < cached.Count; index++)
        {
            var element = cached[index];
            var runtime = AutomationSession.RuntimeId(element);
            ids[runtime] = Register(snapshot, element, seen, element.Cached.ControlType == ControlType.Text ? "t" : "c", index);
            order[runtime] = index;
        }
        var skippedControls = 0;
        var ordered = new List<AutomationElement>();
        foreach (AutomationElement element in interactive)
            if (Has(element, AutomationElement.IsValuePatternAvailableProperty) && (element.Cached.ControlType == ControlType.Edit || element.Cached.ControlType == ControlType.Document)) ordered.Add(element);
        foreach (AutomationElement element in interactive)
            if (!(Has(element, AutomationElement.IsValuePatternAvailableProperty) && (element.Cached.ControlType == ControlType.Edit || element.Cached.ControlType == ControlType.Document))) ordered.Add(element);
        foreach (var element in ordered)
        {
            var info = element.Cached;
            // A field the person could type into: links and radio buttons carry a value too, but take none.
            var editable = Has(element, AutomationElement.IsValuePatternAvailableProperty) && !info.IsPassword && !ReadOnly(element)
                && (info.ControlType == ControlType.Edit || (info.ControlType == ControlType.Document && info.IsKeyboardFocusable));
            var name = Clip(info.Name, Math.Min(NameLimit, remaining));
            string value = null;
            string rawValue = null;
            object pattern;
            if (!info.IsPassword && element.TryGetCachedPattern(ValuePattern.Pattern, out pattern))
            {
                try { rawValue = ((ValuePattern)pattern).Current.Value; value = Clip(rawValue, Math.Min(ValueLimit, remaining)); }
                catch (ElementNotAvailableException) { value = null; }
                catch (InvalidOperationException) { value = null; }
                catch (System.Runtime.InteropServices.COMException) { value = null; }
            }
            if (!Matches(info.Name, rawValue, wanted)) continue;
            if (controls.Count >= MaxControls || remaining <= 0) { skippedControls++; continue; }
            var runtime = AutomationSession.RuntimeId(element);
            var id = ids[runtime];
            if (id == null) continue;
            var placeholder = value != null && value.Trim().Length > 0 && Flat(value) == Flat(info.Name);
            var meta = metadata[runtime];
            controls.Add(new
            {
                depth = meta.Depth, childCount = meta.ChildCount, subtreeTruncated = meta.Truncated,
                parent = meta.Parent == null ? null : ids[AutomationSession.RuntimeId(meta.Parent.Element)], order = order[runtime],
                runtimeId = runtime, id = id, type = info.ControlType.ProgrammaticName.Replace("ControlType.", ""), name = name,
                value = value, placeholder = placeholder ? name : null,
                can = new
                {
                    set = editable, press = Has(element, AutomationElement.IsInvokePatternAvailableProperty) || Has(element, AutomationElement.IsTogglePatternAvailableProperty)
                        || Has(element, AutomationElement.IsSelectionItemPatternAvailableProperty) || Has(element, AutomationElement.IsExpandCollapsePatternAvailableProperty) || !element.Current.BoundingRectangle.IsEmpty,
                    scroll = Has(element, AutomationElement.IsScrollPatternAvailableProperty), scrollIntoView = Has(element, AutomationElement.IsScrollItemPatternAvailableProperty),
                    text = Has(element, AutomationElement.IsTextPatternAvailableProperty),
                },
                state = ReadState(element, true),
                enabled = info.IsEnabled, offscreen = info.IsOffscreen, focused = info.HasKeyboardFocus, secret = info.IsPassword,
            });
            remaining = Math.Max(0, remaining - name.Length - (value == null ? 0 : value.Length));
        }
        var lines = new List<AutomationElement>();
        foreach (AutomationElement element in textual)
        {
            var name = element.Cached.Name;
            if (string.IsNullOrWhiteSpace(name)) continue;
            if (wanted != null && name.IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) < 0) continue;
            lines.Add(element);
        }
        // The end of a conversation is what matters most; keep the tail when there is too much.
        var skippedTexts = Math.Max(0, lines.Count - MaxTexts);
        foreach (var element in lines.Skip(skippedTexts))
        {
            if (remaining <= 0) { skippedTexts++; continue; }
            var runtime = AutomationSession.RuntimeId(element);
            var id = ids[runtime];
            if (id == null) continue;
            var text = Clip(element.Cached.Name, Math.Min(NameLimit, remaining));
            var meta = metadata[runtime];
            texts.Add(new { id = id, text = text, parent = meta.Parent == null ? null : ids[AutomationSession.RuntimeId(meta.Parent.Element)], order = order[runtime] });
            remaining = Math.Max(0, remaining - text.Length);
        }
        Guard.Same(target);
        Remember(snapshot);
        nodes = controls.Count + texts.Count;
        return new
        {
            accessibilityRescanned = activationAttempted, window = target.Id, pid = target.Pid, title = target.Title, snapshot = snapshot.Id, controls = controls, texts = texts,
            bounds = AutomationSession.Bounds(DesktopNative.Bounds(target.Handle)), mode = mode ?? "full", root = rootId,
            searchComplete = wanted == null ? (bool?)null : !tree.Truncated && skippedControls == 0 && skippedTexts == 0 && remaining > 0,
            truncated = tree.Truncated || skippedControls > 0 || skippedTexts > 0 || remaining <= 0,
            skippedControls = skippedControls, skippedTexts = skippedTexts, ms = watch.ElapsedMilliseconds, state = State(target),
        };
    }

}
