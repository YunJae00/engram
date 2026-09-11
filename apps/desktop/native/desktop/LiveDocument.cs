using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

internal sealed class LiveBlock
{
    internal dynamic Range, Owner;
    internal string Id, Text, Label, Address;
}

internal sealed class LiveDocument : IDisposable
{
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumChild callback, IntPtr data);
    private delegate bool EnumChild(IntPtr window, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr window, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IDispatch)] out object result);
    private readonly List<object> References = new List<object>();
    private readonly Dictionary<string, LiveBlock> Blocks = new Dictionary<string, LiveBlock>();
    private dynamic NativeWindow, Document, Sheet, SingletonApplication;
    private string Kind, Snapshot, Target, SheetName;
    private int Pid, TextBudget;
    private bool Omitted;
    private long Created;

    private dynamic Keep(object value) { if (value != null && Marshal.IsComObject(value)) References.Add(value); return value; }
    private static string Text(object value) { return Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""; }
    private static string RequestText(Dictionary<string, object> request, string key) { return Program.Text(request, key, 8000); }
    private static int Number(Dictionary<string, object> request, string key, int fallback, int maximum)
    {
        object raw;
        if (!request.TryGetValue(key, out raw)) return fallback;
        if (!(raw is int) || (int)raw < 0 || (int)raw > maximum) throw new ArgumentException("Invalid " + key);
        return (int)raw;
    }
    private void Connect(DesktopTarget target)
    {
        Dispose();
        string process;
        using (var app = Process.GetProcessById(target.Pid)) process = app.ProcessName.ToLowerInvariant();
        Kind = process == "winword" ? "word" : process == "excel" ? "excel" : process == "powerpnt" ? "powerpoint" : "";
        if (Kind == "") throw new InvalidOperationException("This app has no supported live document API. Use desktop tools.");
        var expectedClass = Kind == "word" ? "_WwG" : Kind == "excel" ? "EXCEL7" : "paneClassDC";
        object found = null;
        EnumChildWindows(target.Handle, delegate(IntPtr child, IntPtr ignored)
        {
            var name = new StringBuilder(128);
            GetClassName(child, name, name.Capacity);
            if (name.ToString() != expectedClass) return true;
            var iid = new Guid("00020400-0000-0000-C000-000000000046");
            object native;
            if (AccessibleObjectFromWindow(child, 0xfffffff0, ref iid, out native) == 0 && native != null) { found = native; return false; }
            return true;
        }, IntPtr.Zero);
        if (found == null && Kind == "powerpoint")
        {
            // Some versions expose the document model only through the running object table.
            // Resolve an exact window; never fall back to a different active presentation.
            dynamic application = Keep(Marshal.GetActiveObject("PowerPoint.Application"));
            dynamic windows = Keep(application.Windows);
            for (var index = 1; index <= (int)windows.Count; index++)
            {
                dynamic candidate = Keep(windows[index]);
                IntPtr handle;
                try { handle = new IntPtr(Convert.ToInt64(candidate.HWND)); }
                catch (Exception)
                {
                    if ((int)windows.Count != 1) throw new InvalidOperationException("This version cannot identify one of multiple presentation windows. Use desktop tools.");
                    try { handle = new IntPtr(Convert.ToInt64(application.HWND)); }
                    catch (Exception)
                    {
                        RequireSingletonPresentation(target.Pid, application);
                        SingletonApplication = application;
                        handle = target.Handle;
                    }
                }
                if (handle == target.Handle || GetAncestor(handle, 2) == target.Handle) { found = candidate; break; }
            }
        }
        if (found == null) throw new InvalidOperationException("The selected window does not expose an editable document. Open a document, then read it again.");
        NativeWindow = Keep(found);
        if (Kind == "word") Document = Keep(NativeWindow.Document);
        else if (Kind == "powerpoint") Document = Keep(NativeWindow.Presentation);
        else { Sheet = Keep(NativeWindow.ActiveSheet); Document = Keep(Sheet.Parent); SheetName = Text(Sheet.Name); }
        if (Convert.ToBoolean(Document.ReadOnly) || Convert.ToBoolean(Document.HasVBProject)) throw new InvalidOperationException("Read-only and macro-enabled documents require manual control.");
        if (Kind == "word" && Convert.ToInt32(Document.ProtectionType) != -1) throw new InvalidOperationException("Protected documents require manual control.");
        if (Kind == "excel" && Convert.ToBoolean(Sheet.ProtectContents)) throw new InvalidOperationException("Protected worksheets require manual control.");
        Target = target.Id; Pid = target.Pid;
    }
    private string Value(LiveBlock block)
    {
        if (Kind == "excel" && block.Range == null) block.Range = Keep(Sheet.Range[block.Address]);
        if (Kind == "word")
        {
            block.Range = Keep(block.Owner.Range);
            var text = Text(block.Range.Text);
            int trim = text.EndsWith("\r\a", StringComparison.Ordinal) ? 2 : text.EndsWith("\r", StringComparison.Ordinal) ? 1 : 0;
            block.Range.End = (int)block.Range.End - trim;
        }
        else if (Kind == "powerpoint") block.Range = Keep(block.Owner.TextRange);
        return Kind == "excel" ? Text(block.Range.Formula) : Text(block.Range.Text);
    }
    private void Add(dynamic range, string label, List<object> output, dynamic owner = null, string input = null, string value = null, string address = null)
    {
        var block = new LiveBlock { Id = "b" + Blocks.Count, Range = Keep((object)range), Owner = owner, Label = label, Address = address };
        block.Text = input ?? Value(block);
        if (block.Text.Length > 8000 || TextBudget + block.Text.Length > 40000) { Omitted = true; output.Add(new { label = label, editable = false, reason = "Text budget exceeded; read a smaller range or use offset/desktop tools." }); return; }
        TextBudget += block.Text.Length;
        Blocks.Add(block.Id, block);
        output.Add(new { id = block.Id, label = label, text = block.Text, value = Kind == "excel" ? value ?? Text(block.Range.Value2) : null });
    }
    internal static string CellAddress(int row, int column)
    {
        string letters = "";
        while (column > 0) { column--; letters = (char)('A' + column % 26) + letters; column /= 26; }
        return "$" + letters + "$" + row.ToString(CultureInfo.InvariantCulture);
    }
    internal static object CellValue(object values, int row, int column)
    {
        var array = values as Array;
        return array == null ? values : array.GetValue(row + array.GetLowerBound(0), column + array.GetLowerBound(1));
    }
    internal object Read(DesktopTarget target, Dictionary<string, object> request, Action check)
    {
        check(); Connect(target); check();
        var output = new List<object>();
        int offset = Number(request, "offset", 0, 100000), count = 0, next = -1;
        if (Kind == "word")
        {
            dynamic paragraphs = Keep(Document.Paragraphs);
            count = (int)paragraphs.Count;
            for (var index = offset + 1; index <= count && index <= offset + 80; index++)
            {
                check(); dynamic paragraph = Keep(paragraphs[index]); dynamic range = Keep(paragraph.Range);
                var value = Text(range.Text);
                // Keep paragraph and table-cell boundaries outside replacements.
                int trim = value.EndsWith("\r\a", StringComparison.Ordinal) ? 2 : value.EndsWith("\r", StringComparison.Ordinal) ? 1 : 0;
                range.End = (int)range.End - trim;
                Add(range, "paragraph " + index, output, paragraph);
            }
            if (offset + 80 < count) next = offset + 80;
        }
        else if (Kind == "powerpoint")
        {
            dynamic slides = Keep(Document.Slides);
            var slideIndex = Number(request, "slide", 1, 10000);
            if (slideIndex < 1 || slideIndex > (int)slides.Count) throw new ArgumentException("Choose an existing slide.");
            dynamic slide = Keep(slides[slideIndex]); dynamic shapes = Keep(slide.Shapes);
            count = (int)shapes.Count;
            for (var index = offset + 1; index <= count && index <= offset + 80; index++)
            {
                check(); dynamic shape = Keep(shapes[index]);
                if (Convert.ToInt32(shape.HasTextFrame) == 0) continue;
                dynamic frame = Keep(shape.TextFrame);
                Add(Keep(frame.TextRange), "slide " + slideIndex + " shape " + Text(shape.Id) + " " + Text(shape.Name), output, frame);
            }
            if (offset + 80 < count) next = offset + 80;
        }
        else
        {
            var address = request.ContainsKey("range") ? RequestText(request, "range") : "A1:L20";
            if (!Regex.IsMatch(address, "^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$")) throw new ArgumentException("Use a local A1 range.");
            dynamic range = Keep(Sheet.Range[address]);
            count = Convert.ToInt32(range.CountLarge);
            if (count > 240) throw new ArgumentException("Read at most 240 cells per range.");
            dynamic rows = Keep(range.Rows), columns = Keep(range.Columns);
            int rowCount = (int)rows.Count, columnCount = (int)columns.Count, firstRow = (int)range.Row, firstColumn = (int)range.Column;
            object inputs = range.Formula, values = range.Value2;
            for (var row = 0; row < rowCount; row++)
            {
                check();
                for (var column = 0; column < columnCount; column++)
                {
                    var local = CellAddress(firstRow + row, firstColumn + column);
                    Add(null, SheetName + "!" + local, output, null, Text(CellValue(inputs, row, column)), Text(CellValue(values, row, column)), local);
                }
            }
        }
        check(); Snapshot = Guid.NewGuid().ToString("N"); Created = Stopwatch.GetTimestamp();
        return new { snapshot = Snapshot, application = Kind, document = Text(Document.Name), blocks = output, total = count, nextOffset = next < 0 ? (int?)null : next,
            truncated = next >= 0 || Omitted, live = true, verification = "Native document values, including unsaved edits. Visual layout is not verified." };
    }
    private void SameDocument(DesktopTarget target)
    {
        if (Target != target.Id || Pid != target.Pid) throw new InvalidOperationException("The document belongs to another window.");
        if (SingletonApplication != null) RequireSingletonPresentation(target.Pid, SingletonApplication);
        dynamic current = Kind == "word" ? Keep(NativeWindow.Document) : Kind == "powerpoint" ? Keep(NativeWindow.Presentation) : Keep(NativeWindow.ActiveSheet);
        object expected = Kind == "excel" ? (object)Sheet : (object)Document;
        IntPtr left = Marshal.GetIUnknownForObject((object)current), right = Marshal.GetIUnknownForObject(expected);
        try { if (left != right) throw new InvalidOperationException("The active document or sheet changed. Read it again."); }
        finally { Marshal.Release(left); Marshal.Release(right); }
    }
    private static void RequireSingletonPresentation(int targetPid, dynamic application)
    {
        int count = 0;
        using (var target = Process.GetProcessById(targetPid))
        {
            foreach (var process in Process.GetProcessesByName("POWERPNT")) using (process)
                if (process.SessionId == target.SessionId) { count++; if (process.Id != targetPid) throw new InvalidOperationException("Multiple presentation processes require desktop tools."); }
        }
        if (count != 1 || (int)application.Windows.Count != 1) throw new InvalidOperationException("Cannot uniquely bind this presentation. Use desktop tools.");
    }
    internal static string Replacement(string expected, string before, string after)
    {
        if (before.Length == 0) { if (expected.Length != 0) throw new ArgumentException("Empty before requires an empty block."); return after; }
        int first = expected.IndexOf(before, StringComparison.Ordinal);
        if (first < 0 || first != expected.LastIndexOf(before, StringComparison.Ordinal)) throw new ArgumentException("before must match exactly once.");
        return expected.Substring(0, first) + after + expected.Substring(first + before.Length);
    }
    internal static void SafeFormula(string text)
    {
        if (!text.StartsWith("=", StringComparison.Ordinal)) return;
        if (text.Length > 1000 || !Regex.IsMatch(text, "^=[A-Za-z0-9_ .,$():+*/^%<>=&!\"-]+$") || text.Contains("!") || text.Contains("\"") || text.Contains("_")) throw new ArgumentException("Use a local numeric formula without external references.");
        foreach (Match match in Regex.Matches(text, "([A-Za-z]+)\\s*\\("))
            if (!Regex.IsMatch(match.Groups[1].Value, "^(SUM|AVERAGE|MIN|MAX|COUNT|COUNTA|IF|ROUND|ROUNDUP|ROUNDDOWN|ABS|AND|OR|NOT)$", RegexOptions.IgnoreCase)) throw new ArgumentException("Unsupported formula function; use the app directly.");
        var literals = Regex.Replace(text, "[A-Za-z]+\\s*\\(", "(");
        literals = Regex.Replace(literals, @"\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}", "0");
        if (Regex.IsMatch(literals, "[A-Za-z]")) throw new ArgumentException("Named formulas require the application directly.");
    }
    internal static object CellInput(string text)
    {
        SafeFormula(text);
        if (text.StartsWith("=", StringComparison.Ordinal)) return text.ToUpperInvariant();
        double number;
        if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out number) && !double.IsNaN(number) && !double.IsInfinity(number)
            && number.ToString("G", CultureInfo.InvariantCulture) == text) return number;
        return "'" + text;
    }
    internal object Edit(DesktopTarget target, Dictionary<string, object> request, Action check)
    {
        check(); SameDocument(target);
        if (Snapshot == null || Snapshot != RequestText(request, "snapshot") || (Stopwatch.GetTimestamp() - Created) / (double)Stopwatch.Frequency > 180)
            return Result(new List<object>(), "Read this live document again before editing; no edits applied.", null);
        Snapshot = null; // Consume even failed batches; an uncertain edit cannot be replayed.
        var raw = request["edits"] as IList;
        if (raw == null || raw.Count < 1 || raw.Count > 100) throw new ArgumentException("Supply 1 to 100 edits.");
        var pending = new List<Tuple<LiveBlock, string, string, string>>(); var ids = new HashSet<string>();
        foreach (var item in raw)
        {
            check(); var edit = item as Dictionary<string, object>;
            if (edit == null || edit.Count != 4) throw new ArgumentException("Invalid edit.");
            var id = RequestText(edit, "id"); LiveBlock block;
            if (!ids.Add(id) || !Blocks.TryGetValue(id, out block)) throw new ArgumentException("Use unique observed block IDs.");
            var expected = RequestText(edit, "expected"); var before = RequestText(edit, "before"); var after = RequestText(edit, "after");
            if (block.Text != expected || Value(block) != expected)
                return Result(new List<object>(), "A document block changed. Read again; no edits applied.", block.Id);
            var result = Replacement(expected, before, after);
            if (result.Length > 8000 || result.IndexOf('\a') >= 0 || (Kind == "word" && result.IndexOf('\r') >= 0)) throw new ArgumentException("Do not replace document boundaries.");
            if (Kind == "excel") { if (before != expected) throw new ArgumentException("Replace the whole cell input."); SafeFormula(result); }
            pending.Add(Tuple.Create(block, before, after, result));
        }
        var completed = new List<object>(); string failure = null, attempted = null;
        foreach (var edit in pending)
        {
            try
            {
                check(); SameDocument(target); var block = edit.Item1; attempted = block.Id;
                if (Value(block) != block.Text) throw new InvalidOperationException("A block changed after preflight.");
                if (Kind == "excel")
                {
                    block.Range.Formula = CellInput(edit.Item4);
                }
                else
                {
                    int index = block.Text.IndexOf(edit.Item2, StringComparison.Ordinal);
                    dynamic fragment;
                    if (Kind == "word") { fragment = Keep(block.Range.Duplicate); fragment.Start = (int)block.Range.Start + index; fragment.End = (int)fragment.Start + edit.Item2.Length; }
                    else fragment = Keep(block.Range.Characters(index + 1, edit.Item2.Length));
                    fragment.Text = edit.Item3;
                }
                check(); var value = Value(block);
                var expectedResult = Kind == "excel" && edit.Item4.StartsWith("=", StringComparison.Ordinal) ? edit.Item4.ToUpperInvariant() : edit.Item4;
                if (value != expectedResult) throw new InvalidOperationException("Native readback differs; this block may already have changed. Re-read; do not replay.");
                completed.Add(new { id = block.Id, text = value, value = Kind == "excel" ? Text(block.Range.Value2) : null });
            }
            catch (Exception error) { failure = error.Message; break; }
        }
        return Result(completed, failure, failure == null ? null : attempted);
    }
    internal static object Result(List<object> completed, string failure, string failedBlock)
    {
        return new { live = true, completed = completed, completeReadback = failure == null, error = failure, failedBlock = failedBlock, reobserveRequired = failure != null, saved = false,
            verification = "Only returned native block values were verified. No file save/close was requested; app AutoSave may still apply. Layout and unrelated content require independent verification." };
    }
    public void Dispose()
    {
        Blocks.Clear(); Snapshot = null; TextBudget = 0; Omitted = false; NativeWindow = null; Document = null; Sheet = null; SingletonApplication = null;
        for (int index = References.Count - 1; index >= 0; index--) try { Marshal.ReleaseComObject(References[index]); } catch (InvalidComObjectException) { }
        References.Clear();
    }
}
