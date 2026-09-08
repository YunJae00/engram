using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class WorkerFixture
{
    private const string TypedText = "독립 작업 입력 검증";

    public static int Run(string outputDir, int parentSession, int expectedChildSession, string nonce)
    {
        var keyboard = false;
        var click = false;
        var wheel = false;
        var resize = false;
        var screenshot = false;
        var error = "";
        var actualSession = -1;
        var processId = -1;
        var displayWidth = 0;
        var displayHeight = 0;
        var output = Path.GetFullPath(outputDir);
        Directory.CreateDirectory(output);
        using (var process = Process.GetCurrentProcess()) { actualSession = process.SessionId; processId = process.Id; }
        try
        {
            WorkerInput.RequireSession(parentSession, expectedChildSession);
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw new InvalidOperationException("The worker fixture requires an STA thread");
            if (string.IsNullOrEmpty(nonce) || nonce.Length > 128)
                throw new InvalidOperationException("A bounded parent-issued fixture nonce is required");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var available = Screen.PrimaryScreen.WorkingArea;
            var width = Math.Min(640, available.Width - 144);
            var height = Math.Min(440, available.Height - 132);
            if (width < 400 || height < 300)
                throw new InvalidOperationException("The worker display is too small for the input fixture");
            using (var window = new Form())
            using (var timer = new System.Windows.Forms.Timer())
            {
                window.Text = "Engram worker input fixture";
                window.StartPosition = FormStartPosition.CenterScreen;
                window.ClientSize = new Size(width, height);
                window.Padding = new Padding(16);
                window.BackColor = Color.White;
                var title = new Label { Text = "Independent worker session", Dock = DockStyle.Top, Height = 30 };
                var field = new TextBox { Dock = DockStyle.Top, Height = 30 };
                var button = new Button { Text = "Confirm input", Dock = DockStyle.Top, Height = 38 };
                var status = new Label { Text = "Waiting for worker input", Dock = DockStyle.Top, Height = 34 };
                var scroll = new FixtureScroll { Dock = DockStyle.Fill };
                var clicked = 0;
                button.Click += delegate { clicked++; status.Text = "Button click received"; };
                window.Controls.Add(scroll);
                window.Controls.Add(status);
                window.Controls.Add(button);
                window.Controls.Add(field);
                window.Controls.Add(title);
                var input = new WorkerInput(window, parentSession, expectedChildSession);
                var watch = Stopwatch.StartNew();
                var stage = 0;
                var complete = false;
                var wantedSize = new Size(width + 64, height + 32);
                timer.Interval = 350;
                timer.Tick += delegate
                {
                    try
                    {
                        if (watch.ElapsedMilliseconds > 15000) throw new TimeoutException("The worker fixture exceeded its input deadline");
                        switch (stage++)
                        {
                            case 0: input.Activate(); break;
                            case 1: input.Click(Center(field)); break;
                            case 2:
                                if (!field.Focused) throw new InvalidOperationException("The fixture text field did not receive focus");
                                input.Type(TypedText);
                                break;
                            case 3:
                                keyboard = field.Text == TypedText;
                                if (!keyboard) throw new InvalidOperationException("Unicode input did not reach the worker text field");
                                input.Click(Center(button));
                                break;
                            case 4:
                                click = clicked == 1;
                                if (!click) throw new InvalidOperationException("The worker button did not receive exactly one click");
                                input.Click(Center(scroll));
                                break;
                            case 5: input.Wheel(Center(scroll), -360); break;
                            case 6:
                                wheel = scroll.WheelEvents > 0 && scroll.VerticalScroll.Value > 0;
                                if (!wheel) throw new InvalidOperationException("The worker scroll area did not move after wheel input");
                                input.RequireForeground();
                                window.ClientSize = wantedSize;
                                break;
                            case 7:
                                resize = input.ClientSize() == wantedSize && window.ClientSize == wantedSize;
                                if (!resize) throw new InvalidOperationException("The worker window did not reach its requested size");
                                status.Text = "Keyboard, pointer, wheel and resize verified";
                                break;
                            case 8:
                                input.RequireForeground();
                                var origin = window.PointToScreen(Point.Empty);
                                var bounds = new Rectangle(origin, window.ClientSize);
                                var display = SystemInformation.VirtualScreen;
                                displayWidth = display.Width;
                                displayHeight = display.Height;
                                if (!display.Contains(bounds))
                                    throw new InvalidOperationException("The worker fixture is outside its display bounds");
                                using (var image = new Bitmap(window.ClientSize.Width, window.ClientSize.Height))
                                using (var graphics = Graphics.FromImage(image))
                                {
                                    graphics.CopyFromScreen(origin, Point.Empty, image.Size);
                                    image.Save(Path.Combine(output, "worker.png"), ImageFormat.Png);
                                }
                                screenshot = true;
                                complete = true;
                                timer.Stop();
                                window.Close();
                                break;
                        }
                    }
                    catch (Exception failure)
                    {
                        error = failure.Message;
                        timer.Stop();
                        window.Close();
                    }
                };
                window.Shown += delegate { timer.Start(); };
                Application.Run(window);
                if (!complete && error.Length == 0) error = "The worker fixture closed before all checks completed";
            }
        }
        catch (Exception failure) { error = failure.Message; }
        var passed = keyboard && click && wheel && resize && screenshot && error.Length == 0;
        var result = new
        {
            nonce = nonce, session = actualSession, parentSession = parentSession,
            expectedChildSession = expectedChildSession, keyboard = keyboard, click = click,
            wheel = wheel, resize = resize, screenshot = screenshot, passed = passed, error = error,
            processId = processId, displayWidth = displayWidth, displayHeight = displayHeight
        };
        var json = new JavaScriptSerializer().Serialize(result);
        var pending = Path.Combine(output, "worker-result.pending");
        var target = Path.Combine(output, "worker-result.json");
        File.WriteAllText(pending, json, new UTF8Encoding(false));
        File.Move(pending, target);
        return passed ? 0 : 1;
    }

    private static Point Center(Control control)
    {
        return control.PointToScreen(new Point(control.ClientSize.Width / 2, control.ClientSize.Height / 2));
    }

    private sealed class FixtureScroll : ScrollableControl
    {
        internal int WheelEvents;

        internal FixtureScroll()
        {
            AutoScroll = true;
            AutoScrollMinSize = new Size(0, 1400);
            BackColor = Color.FromArgb(246, 247, 249);
            SetStyle(ControlStyles.Selectable, true);
            TabStop = true;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            base.OnMouseDown(e);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            WheelEvents++;
            base.OnMouseWheel(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            for (var row = 0; row < 35; row++)
                e.Graphics.DrawString("Worker scroll row " + (row + 1), Font, Brushes.DimGray, 12, row * 40 + AutoScrollPosition.Y + 12);
        }
    }
}
