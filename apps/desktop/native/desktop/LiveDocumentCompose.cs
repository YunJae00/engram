using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

internal sealed partial class LiveDocument
{
    private string Structure, ReadAddress;
    private string StructureStamp()
    {
        if (Kind == "word") { dynamic content = Keep(Document.Content); return Text(content.End); }
        if (Kind == "excel") return SheetName;
        dynamic slides = Keep(Document.Slides);
        var parts = new List<string>();
        for (int index = 1; index <= (int)slides.Count; index++)
        {
            dynamic slide = Keep(slides[index]), shapes = Keep(slide.Shapes);
            parts.Add(Text(slide.SlideID) + ":" + Text(shapes.Count));
        }
        return string.Join(",", parts);
    }
    private static Dictionary<string, object> Fields(object raw, params string[] keys)
    {
        var value = raw as Dictionary<string, object>;
        if (value == null) throw new ArgumentException("Expected an object.");
        foreach (var key in value.Keys) if (Array.IndexOf(keys, key) < 0) throw new ArgumentException("Unsupported composition field: " + key);
        return value;
    }
    private static IList Items(object raw, int maximum)
    {
        var value = raw as IList;
        if (value == null || value.Count < 1 || value.Count > maximum) throw new ArgumentException("Invalid composition batch size.");
        return value;
    }
    private static double Scalar(Dictionary<string, object> value, string key, double min, double max)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || !(raw is int || raw is double || raw is decimal)) throw new ArgumentException("Invalid numeric field: " + key);
        var number = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
        if (double.IsNaN(number) || double.IsInfinity(number) || number < min || number > max) throw new ArgumentException("Out of bounds: " + key);
        return number;
    }
    private static int Rgb(string color)
    {
        if (!Regex.IsMatch(color, "^#?[a-fA-F0-9]{6}$")) throw new ArgumentException("Use six-digit RGB colors, with an optional # prefix.");
        int rgb = int.Parse(color.TrimStart('#'), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return ((rgb & 255) << 16) | (rgb & 65280) | ((rgb >> 16) & 255);
    }
    private static void StyleFields(Dictionary<string, object> value)
    {
        if (value.ContainsKey("fontSize")) Scalar(value, "fontSize", 8, 120);
        foreach (var key in new[] { "color", "fill", "background" }) if (value.ContainsKey(key)) Rgb(RequestText(value, key));
        foreach (var key in new[] { "bold", "autoFit" }) if (value.ContainsKey(key) && !(value[key] is bool)) throw new ArgumentException("Invalid boolean style.");
        if (value.ContainsKey("text") && Regex.IsMatch(RequestText(value, "text"), "[\\x00-\\x08\\x0b-\\x1f]")) throw new ArgumentException("Invalid document text.");
    }
    internal static string ValidateComposition(Dictionary<string, object> request)
    {
        Fields(request, "id", "method", "window", "pid", "lease", "snapshot", "slides", "paragraphs", "format");
        string mode = null;
        foreach (var key in new[] { "slides", "paragraphs", "format" }) if (request.ContainsKey(key))
        { if (mode != null) throw new ArgumentException("Choose one composition payload."); mode = key; }
        if (mode == null) throw new ArgumentException("Missing composition payload.");
        if (mode == "slides") foreach (var raw in Items(request[mode], 12))
        {
            var slide = Fields(raw, "slide", "background", "boxes"); StyleFields(slide);
            if (slide.ContainsKey("slide")) Number(slide, "slide", 1, 10000);
            foreach (var rawBox in Items(slide["boxes"], 40))
            {
                var box = Fields(rawBox, "text", "x", "y", "width", "height", "fontSize", "color", "bold", "fill");
                RequestText(box, "text"); Rgb(RequestText(box, "color")); Scalar(box, "fontSize", 8, 120); StyleFields(box);
                Scalar(box, "x", 0, 4000); Scalar(box, "y", 0, 4000); Scalar(box, "width", 0.01, 4000); Scalar(box, "height", 0.01, 4000);
            }
        }
        else if (mode == "paragraphs") foreach (var raw in Items(request[mode], 80))
        {
            var paragraph = Fields(raw, "text", "fontSize", "color", "bold"); RequestText(paragraph, "text"); StyleFields(paragraph);
        }
        else
        {
            var format = Fields(request[mode], "fontSize", "color", "bold", "numberFormat", "autoFit"); StyleFields(format);
            if (format.Count == 0) throw new ArgumentException("Empty format.");
            if (format.ContainsKey("numberFormat") && Array.IndexOf(new[] { "General", "#,##0", "#,##0.00", "0%", "0.00%" }, RequestText(format, "numberFormat")) < 0) throw new ArgumentException("Unsupported number format.");
        }
        return mode;
    }
    private void StyleFont(dynamic font, Dictionary<string, object> value, bool presentation)
    {
        if (value.ContainsKey("fontSize")) font.Size = (float)Scalar(value, "fontSize", 8, 120);
        if (value.ContainsKey("bold")) font.Bold = (bool)value["bold"] ? -1 : 0;
        if (value.ContainsKey("color"))
        {
            if (presentation) { dynamic color = Keep(font.Color); color.RGB = Rgb(RequestText(value, "color")); }
            else font.Color = Rgb(RequestText(value, "color"));
        }
    }
    internal object Compose(DesktopTarget target, Dictionary<string, object> request, Action check)
    {
        var started = Stopwatch.StartNew(); var permitted = check;
        check = delegate { permitted(); if (started.ElapsedMilliseconds > 20000) throw new InvalidOperationException("Composition time budget reached. Read the document and continue only unfinished content."); };
        check(); SameDocument(target);
        string mode;
        try { mode = ValidateComposition(request); }
        catch (ArgumentException error) { return Result(new List<object>(), error.Message + " No changes applied.", null); }
        if ((mode == "slides" && Kind != "powerpoint") || (mode == "paragraphs" && Kind != "word") || (mode == "format" && Kind != "excel")) return Result(new List<object>(), "This operation is not available in this application. No changes applied.", null);
        if (Snapshot == null || Snapshot != RequestText(request, "snapshot") || (Stopwatch.GetTimestamp() - Created) / (double)Stopwatch.Frequency > 180)
            return Result(new List<object>(), "Read this live document again before composing; no changes applied.", null);
        Snapshot = null;
        if (Structure != StructureStamp()) return Result(new List<object>(), "Document structure changed. Read again; no changes applied.", null);
        foreach (var block in Blocks.Values) if (Value(block) != block.Text) return Result(new List<object>(), "Observed content changed. Read again; no changes applied.", block.Id);
        if (mode == "slides")
        {
            dynamic page = Keep(Document.PageSetup), slides = Keep(Document.Slides);
            foreach (var raw in (IList)request[mode])
            {
                var spec = (Dictionary<string, object>)raw;
                if (spec.ContainsKey("slide") && (Number(spec, "slide", 1, 10000) < 1 || Number(spec, "slide", 1, 10000) > (int)slides.Count)) return Result(new List<object>(), "Choose an existing slide or omit slide to append. No changes applied.", null);
                foreach (Dictionary<string, object> box in (IList)spec["boxes"])
                    if (Scalar(box, "x", 0, 4000) + Scalar(box, "width", 0.01, 4000) > (double)page.SlideWidth || Scalar(box, "y", 0, 4000) + Scalar(box, "height", 0.01, 4000) > (double)page.SlideHeight)
                        return Result(new List<object>(), "A text box extends outside the slide. Read pageWidth/pageHeight and replan. No changes applied.", null);
            }
        }
        var completed = new List<object>(); string attempted = null;
        try
        {
            if (mode == "slides") foreach (Dictionary<string, object> spec in (IList)request[mode])
            {
                check(); SameDocument(target);
                dynamic slides = Keep(Document.Slides);
                int index = spec.ContainsKey("slide") ? Number(spec, "slide", 1, 10000) : (int)slides.Count + 1;
                attempted = "slide " + index;
                dynamic slide = spec.ContainsKey("slide") ? Keep(slides[index]) : Keep(slides.Add(index, 12));
                if (spec.ContainsKey("background")) { slide.FollowMasterBackground = 0; dynamic fill = Keep(slide.Background.Fill); fill.Solid(); fill.ForeColor.RGB = Rgb(RequestText(spec, "background")); }
                dynamic shapes = Keep(slide.Shapes);
                foreach (Dictionary<string, object> box in (IList)spec["boxes"])
                {
                    check(); SameDocument(target);
                    dynamic shape = Keep(shapes.AddTextbox(1, (float)Scalar(box, "x", 0, 4000), (float)Scalar(box, "y", 0, 4000), (float)Scalar(box, "width", 0.01, 4000), (float)Scalar(box, "height", 0.01, 4000)));
                    attempted = "slide " + index + " shape " + Text(shape.Id);
                    dynamic frame = Keep(shape.TextFrame), range = Keep(frame.TextRange);
                    frame.MarginLeft = 0; frame.MarginRight = 0; frame.MarginTop = 0; frame.MarginBottom = 0; frame.WordWrap = -1; frame.AutoSize = 0;
                    range.Text = RequestText(box, "text"); StyleFont(Keep(range.Font), box, true);
                    if (box.ContainsKey("fill")) { dynamic fill = Keep(shape.Fill); fill.Visible = -1; fill.Solid(); fill.ForeColor.RGB = Rgb(RequestText(box, "fill")); }
                    check();
                    if (Text(range.Text).Replace("\r", "\n") != RequestText(box, "text").Replace("\r", "\n")) throw new InvalidOperationException("Text readback differs; do not replay.");
                    completed.Add(new { slide = index, shape = Text(shape.Id), text = Text(range.Text) });
                }
            }
            else if (mode == "paragraphs") foreach (Dictionary<string, object> spec in (IList)request[mode])
            {
                check(); SameDocument(target);
                dynamic content = Keep(Document.Content); int start = (int)content.End - 1;
                attempted = "paragraph at " + start;
                if (start > 0 && Text(Keep(Document.Range(start - 1, start)).Text) != "\r")
                {
                    dynamic separator = Keep(Document.Range(start, start)); separator.InsertAfter("\r"); start++;
                }
                dynamic range = Keep(Document.Range(start, start));
                string value = RequestText(spec, "text").Replace("\n", "\r") + "\r";
                range.InsertAfter(value); range = Keep(Document.Range(start, start + value.Length)); StyleFont(Keep(range.Font), spec, false);
                check();
                if (Text(range.Text) != value) throw new InvalidOperationException("Paragraph readback differs; do not replay.");
                completed.Add(new { start = start, text = Text(range.Text) });
            }
            else
            {
                check(); SameDocument(target); attempted = ReadAddress;
                dynamic range = Keep(Sheet.Range[ReadAddress]); var spec = (Dictionary<string, object>)request[mode];
                StyleFont(Keep(range.Font), spec, false);
                if (spec.ContainsKey("numberFormat")) range.NumberFormat = RequestText(spec, "numberFormat");
                if (spec.ContainsKey("autoFit") && (bool)spec["autoFit"]) { dynamic columns = Keep(range.Columns); columns.AutoFit(); }
                check(); completed.Add(new { range = ReadAddress, numberFormat = Text(range.NumberFormat), fontSize = Text(range.Font.Size), bold = Text(range.Font.Bold), columnWidth = Text(range.ColumnWidth) });
            }
            return new { completed = completed, error = (string)null, live = true, reobserveRequired = true, saved = false, verification = "Returned native values only. Verify visual layout, formatting and task completeness independently." };
        }
        catch (Exception error) { return Result(completed, error.Message + " A partial object may remain; inspect it before continuing.", attempted); }
    }
}
