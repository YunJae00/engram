using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class DesktopFixture : Form
{
    [StructLayout(LayoutKind.Sequential)] private struct Point { internal int X; internal int Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { internal int Left; internal int Top; internal int Right; internal int Bottom; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect rect, int size);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144 };
    private readonly TextBox Field = new TextBox { AccessibleName = "Task value", Left = 16, Top = 16, Width = 260 };
    private readonly Button Increment = new Button { AccessibleName = "Increment count", Text = "Increment", Left = 16, Top = 52, Width = 140 };
    private readonly Label Counter = new Label { AccessibleName = "Invocation count", Text = "Count 0", Left = 172, Top = 58, Width = 160 };
    private readonly CheckBox Choice = new CheckBox { AccessibleName = "Task enabled", Text = "Task enabled", Left = 16, Top = 90, Width = 160 };
    private readonly ListBox Selector = new ListBox { AccessibleName = "Task selector", Left = 16, Top = 124, Width = 260, Height = 100 };
    private readonly TextBox Password = new TextBox { AccessibleName = "Task password", UseSystemPasswordChar = true, Text = "fixture-only-password", Left = 16, Top = 240, Width = 260 };
    private int Count;
    private int Frame;
    private readonly Label Heartbeat = new Label { AccessibleName = "Frame counter", Text = "Frame 0", Left = 16, Top = 282, Width = 220 };
    private readonly System.Windows.Forms.Timer Clock = new System.Windows.Forms.Timer { Interval = 100 };
    private readonly bool VisiblePreview;

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000000; if (!VisiblePreview) value.ExStyle |= 0x80; return value; }
    }

    private DesktopFixture(string lane, bool visible)
    {
        VisiblePreview = visible;
        Text = "Desktop fixture " + lane;
        AccessibleName = Text;
        StartPosition = FormStartPosition.Manual;
        Location = visible ? new System.Drawing.Point(40, 40) : new System.Drawing.Point(-24000, -24000);
        Size = new Size(480, 400);
        ShowInTaskbar = visible;
        Field.Text = "Lane " + lane;
        Controls.AddRange(new Control[] { Field, Increment, Counter, Choice, Selector, Password, Heartbeat });
        Clock.Tick += delegate { Frame++; Heartbeat.Text = "Frame " + Frame; };
        Clock.Start();
        FormClosed += delegate { Clock.Dispose(); };
        for (var index = 1; index <= 50; index++) Selector.Items.Add("Choice " + index);
        Selector.SelectedIndex = 0;
        Increment.Click += delegate { Count++; Counter.Text = "Count " + Count; };
        Shown += delegate
        {
            var state = State();
            state["type"] = "ready";
            Send(state);
            var reader = new Thread(ReadCommands) { IsBackground = true };
            reader.Start();
        };
    }

    private Dictionary<string, object> State()
    {
        Point cursor;
        if (!GetCursorPos(out cursor)) throw new InvalidOperationException("Cannot read the cursor position");
        Rect rect;
        if (!GetWindowRect(Handle, out rect)) throw new InvalidOperationException("Cannot read the fixture size");
        Rect capture;
        if (DwmGetWindowAttribute(Handle, 9, out capture, Marshal.SizeOf(typeof(Rect))) != 0) capture = rect;
        return new Dictionary<string, object>
        {
            { "window", Handle.ToInt64().ToString(CultureInfo.InvariantCulture) },
            { "pid", System.Diagnostics.Process.GetCurrentProcess().Id }, { "title", Text },
            { "token", FixturePrivilege.Report() },
            { "value", Field.Text }, { "count", Count }, { "checked", Choice.Checked },
            { "selected", Selector.SelectedIndex }, { "topIndex", Selector.TopIndex },
            { "passwordUnchanged", Password.Text == "fixture-only-password" },
            { "width", rect.Right - rect.Left }, { "height", rect.Bottom - rect.Top }, { "frame", Frame },
            { "captureWidth", capture.Right - capture.Left }, { "captureHeight", capture.Bottom - capture.Top },
            { "foreground", GetForegroundWindow().ToInt64().ToString(CultureInfo.InvariantCulture) },
            { "cursor", new { x = cursor.X, y = cursor.Y } }
        };
    }

    private static void Send(object value)
    {
        Console.WriteLine(Json.Serialize(value));
        Console.Out.Flush();
    }

    private void Receive(string line)
    {
        var id = 0;
        try
        {
            var request = Json.Deserialize<Dictionary<string, object>>(line);
            id = Convert.ToInt32(request["id"]);
            var method = (string)request["method"];
            if (method == "renameButton") Increment.AccessibleName = "Changed operation";
            else if (method == "restoreButton") Increment.AccessibleName = "Increment count";
            else if (method == "resize")
            {
                var width = Convert.ToInt32(request["width"]);
                var height = Convert.ToInt32(request["height"]);
                if (width < 320 || width > 1200 || height < 320 || height > 1200) throw new ArgumentException("Invalid fixture size");
                Size = new Size(width, height);
            }
            else if (method == "largeContent")
            {
                for (var index = 0; index < 12; index++)
                    Controls.Add(new TextBox { AccessibleName = "Large field " + index, Text = new string('\uD55C', 4096), Left = 300, Top = 16 + index * 25, Width = 120 });
            }
            else if (method != "state" && method != "close") throw new ArgumentException("Unsupported fixture request");
            Send(new { id = id, result = State() });
            if (method == "close") Close();
        }
        catch (Exception error) { Send(new { id = id, error = error.Message }); }
    }

    private void ReadCommands()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var command = line;
            if (IsDisposed) return;
            try { BeginInvoke((Action)(() => Receive(command))); }
            catch (InvalidOperationException) { return; }
        }
        if (!IsDisposed)
        {
            try { BeginInvoke((Action)Close); }
            catch (InvalidOperationException) { return; }
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            var exitCode = FixturePrivilege.Bootstrap(args);
            if (exitCode.HasValue) return exitCode.Value;
            if (Array.IndexOf(args, "--token-report") >= 0) { Send(FixturePrivilege.Report()); return 0; }
        }
        catch (Exception error) { Send(new { type = "fatal", error = error.Message }); return 2; }
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new DesktopFixture(args.Length > 0 ? args[0] : "1", Array.IndexOf(args, "--visible") >= 0));
        return 0;
    }
}
