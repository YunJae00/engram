using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class FixtureScroll : Panel
{
    internal int Wheels;
    internal FixtureScroll()
    {
        AccessibleName = "Scroll area";
        AutoScroll = true;
        Controls.Add(new Label { Text = new string('x', 60), Location = new Point(8, 8), Size = new Size(360, 1500), BackColor = Color.AliceBlue });
    }
    protected override void WndProc(ref Message message)
    { if (message.Msg == 0x20a) Wheels++; base.WndProc(ref message); }
}

internal sealed class ControlFixture : Form
{
    [StructLayout(LayoutKind.Sequential)] private struct KeyData { internal ushort Key, Scan; internal uint Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] private struct Data { [FieldOffset(0)] internal KeyData Key; [FieldOffset(24)] internal long Padding; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { internal uint Type; internal Data Data; }
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly object Output = new object();
    private readonly TextBox Entry = new TextBox { AccessibleName = "Worker input", Bounds = new Rectangle(18, 20, 450, 30) };
    private readonly TextBox Secret = new TextBox { AccessibleName = "Password", UseSystemPasswordChar = true, Bounds = new Rectangle(18, 60, 230, 30), Visible = false };
    private readonly Button Counter = new Button { AccessibleName = "Count click", Text = "Count click", Bounds = new Rectangle(480, 18, 130, 32) };
    private readonly FixtureScroll Scroller = new FixtureScroll { Bounds = new Rectangle(18, 100, 592, 280) };
    private readonly Panel Marker = new Panel { Bounds = new Rectangle(24, 390, 40, 20), BackColor = Color.Magenta };
    private int Clicks;
    private Form Away;

    internal ControlFixture()
    {
        Text = "Desktop input fixture";
        AccessibleName = "Desktop input fixture";
        StartPosition = FormStartPosition.Manual;
        Location = new Point(80, 80);
        ClientSize = new Size(630, 420);
        Counter.Click += delegate { Clicks++; };
        Controls.AddRange(new Control[] { Entry, Secret, Counter, Scroller, Marker });
        Shown += delegate
        {
            BeginInvoke((Action)delegate
            {
                // A hidden console launch must not hide the owned test surface.
                ShowWindow(Handle, 4);
                if (!IsWindowVisible(Handle) || GetAncestor(Handle, 2) != Handle)
                { Send(new { type = "fatal", error = "Owned fixture surface is not visible and top-level" }); Close(); return; }
                Entry.Focus();
                Send(new { type = "ready", window = Handle.ToInt64().ToString(), pid = System.Diagnostics.Process.GetCurrentProcess().Id, visible = true });
                var reader = new Thread(Read) { IsBackground = true };
                reader.Start();
            });
        };
    }
    private static void Send(object value) { lock (Output) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    private void Read()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var request = Json.Deserialize<Dictionary<string, object>>(line);
            BeginInvoke((Action)delegate { HandleRequest(request); });
        }
        BeginInvoke((Action)Close);
    }
    private void HandleRequest(Dictionary<string, object> request)
    {
        var id = (int)request["id"];
        try
        {
            var method = (string)request["method"];
            if (method == "verifyCapture")
            {
                var captured = (Dictionary<string, object>)request["capture"];
                var bounds = (Dictionary<string, object>)captured["bounds"];
                using (var stream = new MemoryStream(Convert.FromBase64String((string)captured["data"])))
                using (var image = new Bitmap(stream))
                {
                    var center = Marker.PointToScreen(new Point(Marker.Width / 2, Marker.Height / 2));
                    var x = (int)Math.Floor((center.X - Convert.ToDouble(bounds["x"])) / Convert.ToDouble(bounds["width"]) * image.Width);
                    var y = (int)Math.Floor((center.Y - Convert.ToDouble(bounds["y"])) / Convert.ToDouble(bounds["height"]) * image.Height);
                    var color = image.GetPixel(x, y);
                    if (color.R < 230 || color.G > 25 || color.B < 230) throw new InvalidOperationException("Client capture does not align with the owned marker");
                    Send(new { id = id, result = new { aligned = true, width = image.Width, height = image.Height } });
                    return;
                }
            }
            if (method == "focus") { Activate(); Entry.Focus(); }
            else if (method == "hide") Hide();
            else if (method == "grantForeground")
            {
                var pid = Convert.ToInt32(request["pid"]);
                using (var process = System.Diagnostics.Process.GetProcessById(pid))
                {
                    var expected = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "EngramDesktop.exe");
                    if (!string.Equals(process.MainModule.FileName, expected, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("The owned consent fixture could not grant foreground activation");
                    using (var relay = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(expected,
                        "--owner-pid " + System.Diagnostics.Process.GetCurrentProcess().Id + " --grant-foreground " + pid)
                        { UseShellExecute = false, CreateNoWindow = true, WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden }))
                    {
                        if (!relay.WaitForExit(1500)) { relay.Kill(); throw new InvalidOperationException("Foreground delegation timed out"); }
                        if (relay.ExitCode != 0) throw new InvalidOperationException("Foreground delegation was denied");
                    }
                }
            }
            else if (method == "away")
            {
                if (Away == null) Away = new Form { Text = "Owned foreground fixture", StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(760, 100, 300, 200) };
                Away.Show(); Away.Activate();
                if (GetForegroundWindow() != Away.Handle) throw new InvalidOperationException("The owned handoff window did not receive focus");
            }
            else if (method == "resize") { ClientSize = new Size(900, 600); Marker.Top = ClientSize.Height - 30; }
            else if (method == "maximize") { WindowState = FormWindowState.Maximized; Marker.Top = ClientSize.Height - 30; }
            else if (method == "restore") { WindowState = FormWindowState.Normal; ClientSize = new Size(630, 420); Marker.Top = 390; }
            else if (method == "password") { Secret.Visible = true; Secret.Focus(); }
            else if (method == "foreignInput" || method == "foreignEscape")
            {
                if (GetForegroundWindow() != Handle) throw new InvalidOperationException("Only the owned foreground fixture can receive this input");
                var marker = new UIntPtr(0x454e4752414dUL);
                ushort key = method == "foreignEscape" ? (ushort)27 : (ushort)0x87;
                var inputs = new[] {
                    new Input { Type = 1, Data = new Data { Key = new KeyData { Key = key, Extra = marker } } },
                    new Input { Type = 1, Data = new Data { Key = new KeyData { Key = key, Flags = 2, Extra = marker } } }
                };
                if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2) throw new InvalidOperationException("Fixture input was not accepted");
            }
            else if (method != "state") throw new ArgumentException("Unsupported fixture request");
            Send(new { id = id, result = new { text = Entry.Text, clicks = Clicks, wheelEvents = Scroller.Wheels,
                scrollY = -Scroller.AutoScrollPosition.Y, focused = Entry.Focused, foreground = GetForegroundWindow() == Handle, passwordVisible = Secret.Visible } });
        }
        catch (Exception error) { Send(new { id = id, error = error.Message }); }
    }
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "--ci-fixture" || Environment.GetEnvironmentVariable("CI") != "true"
            || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" || System.Diagnostics.Process.GetCurrentProcess().SessionId == 0)
        { Console.Error.WriteLine("This fixture requires an isolated interactive CI runner"); return 2; }
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Application.EnableVisualStyles();
        Application.Run(new ControlFixture());
        return 0;
    }
}
