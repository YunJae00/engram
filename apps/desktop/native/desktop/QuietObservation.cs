using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows.Automation;

internal sealed partial class QuietAccess
{
    // What the app shows and offers: editable fields and pressable items first, then the text on screen.
    // A Chromium app exposes its tree only once a client has asked, and re-lays it out after a press, so a
    // sparse or faltering first read is tried again a moment later rather than reported as the app.
    internal object Scan(DesktopTarget target, string find, string mode = null, string rootId = null, string previous = null)
    {
        ObservationTree.Skeleton(mode, rootId, previous);
        object result = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            int nodes;
            try { result = ScanOnce(target, find, mode, rootId, previous, out nodes); }
            catch (ElementNotAvailableException) { if (attempt == 2) throw; System.Threading.Thread.Sleep(300); continue; }
            catch (System.Runtime.InteropServices.COMException) { if (attempt == 2) throw; System.Threading.Thread.Sleep(300); continue; }
            if (mode == "skeleton" || rootId != null || nodes >= SparseNodes || attempt == 2) break;
            System.Threading.Thread.Sleep(400);
        }
        return result;
    }
    private object ScanOnce(DesktopTarget target, string find, string mode, string rootId, string previous, out int nodes)
    {
        if (target.Minimized) throw new InvalidOperationException("Restore this window before reading it");
        var root = Validate(target);
        var snapshot = new QuietSnapshot { Id = Guid.NewGuid().ToString("N"), Target = target, RootRuntime = AutomationSession.RuntimeId(root) };
        var wanted = string.IsNullOrWhiteSpace(find) ? null : find.Trim();
        var watch = Stopwatch.StartNew();
        var readingRoot = rootId == null ? root : Control(target, previous, rootId).Element;
        var tree = ObservationTree.Read(readingRoot, MaxControls + MaxTexts, mode == "skeleton" ? 3 : 32, 1800, root.Current.ClassName == "Chrome_WidgetWin_1");
        var metadata = tree.Nodes.ToDictionary(node => AutomationSession.RuntimeId(node.Element));
        var cached = tree.Nodes.Select(node => node.Element.GetUpdatedCache(Cache())).ToList();
        var interactive = cached.Where(element => element.Cached.ControlType != ControlType.Text).ToList();
        var textual = cached.Where(element => element.Cached.ControlType == ControlType.Text).ToList();
        var controls = new List<object>();
        var texts = new List<object>();
        var remaining = ReadLimit;
        var seen = new HashSet<string>();
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
            object pattern;
            if (editable && element.TryGetCachedPattern(ValuePattern.Pattern, out pattern))
            {
                try { value = Clip(((ValuePattern)pattern).Current.Value, Math.Min(ValueLimit, remaining)); } catch (ElementNotAvailableException) { value = null; }
            }
            if (wanted != null && !editable && (name.IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) < 0) && (value == null || value.IndexOf(wanted, StringComparison.CurrentCultureIgnoreCase) < 0)) continue;
            if (controls.Count >= MaxControls || remaining <= 0) { skippedControls++; continue; }
            var id = Register(snapshot, element, seen, "c", controls.Count);
            if (id == null) continue;
            var placeholder = value != null && value.Trim().Length > 0 && Flat(value) == Flat(info.Name);
            var meta = metadata[AutomationSession.RuntimeId(element)];
            controls.Add(new
            {
                depth = meta.Depth, childCount = meta.ChildCount, subtreeTruncated = meta.Truncated,
                id = id, type = info.ControlType.ProgrammaticName.Replace("ControlType.", ""), name = name,
                value = value, placeholder = placeholder ? name : null,
                can = new
                {
                    set = editable, press = Has(element, AutomationElement.IsInvokePatternAvailableProperty) || Has(element, AutomationElement.IsTogglePatternAvailableProperty)
                        || Has(element, AutomationElement.IsSelectionItemPatternAvailableProperty) || Has(element, AutomationElement.IsExpandCollapsePatternAvailableProperty),
                    text = Has(element, AutomationElement.IsTextPatternAvailableProperty),
                },
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
            var id = Register(snapshot, element, seen, "t", texts.Count);
            if (id == null) continue;
            var text = Clip(element.Cached.Name, Math.Min(NameLimit, remaining));
            texts.Add(new { id = id, text = text });
            remaining = Math.Max(0, remaining - text.Length);
        }
        Guard.Same(target);
        Remember(snapshot);
        nodes = controls.Count + texts.Count;
        return new
        {
            window = target.Id, pid = target.Pid, title = target.Title, snapshot = snapshot.Id, controls = controls, texts = texts,
            bounds = AutomationSession.Bounds(DesktopNative.Bounds(target.Handle)), mode = mode ?? "full", root = rootId,
            truncated = tree.Truncated || skippedControls > 0 || skippedTexts > 0 || remaining <= 0,
            skippedControls = skippedControls, skippedTexts = skippedTexts, ms = watch.ElapsedMilliseconds, state = State(target),
        };
    }

}
