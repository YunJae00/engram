using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal sealed class DesktopTarget { internal IntPtr Handle; internal int Pid; }
internal static class DesktopNative
{
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { internal int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect value);
    internal static Rectangle VisualBounds(IntPtr window) { Rect value; if (DwmGetWindowAttribute(window, 9, out value, 16) != 0) GetWindowRect(window, out value); return Rectangle.FromLTRB(value.Left, value.Top, value.Right, value.Bottom); }
}
internal sealed class FixtureWindow : Form
{
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { var value = base.CreateParams; value.ExStyle |= 0x08000000; return value; } }
}
internal static class ApplicationFrameFixture
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    private static int Checks;
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); Checks++; }
    private static void Until(Func<bool> check, string message)
    {
        var timeout = Stopwatch.StartNew();
        while (!check() && timeout.ElapsedMilliseconds < 2000) { Application.DoEvents(); Thread.Sleep(16); }
        Check(check(), message);
    }
    private static bool Above(IntPtr higher, IntPtr lower)
    {
        for (var at = GetWindow(lower, 3); at != IntPtr.Zero; at = GetWindow(at, 3)) if (at == higher) return true;
        return false;
    }
    [STAThread] private static int Main(string[] args)
    {
        try {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            var foreground = GetForegroundWindow();
            using (var target = new FixtureWindow { Text = "Engram frame test", Bounds = new Rectangle(160, 140, 640, 440), BackColor = Color.White })
            using (var cover = new FixtureWindow { Text = "Engram occlusion test", Bounds = new Rectangle(440, 220, 340, 280), BackColor = Color.WhiteSmoke }) {
                target.Show(); Application.DoEvents();
                var info = new DesktopTarget { Handle = target.Handle, Pid = Process.GetCurrentProcess().Id };
                IntPtr frame;
                using (var host = new ApplicationFrameHost()) {
                    frame = new IntPtr(long.Parse(host.Show(info)));
                    Until(() => IsWindowVisible(frame), "The owned frame must be visible");
                    Check(GetWindow(frame, 4) == target.Handle, "The frame must belong to the target window");
                    Check(GetForegroundWindow() == foreground, "The frame must not take keyboard focus");
                    Check(Above(frame, target.Handle), "The frame must sit above its target");
                    target.TopMost = true;
                    SetWindowPos(target.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x10 | 1 | 2);
                    SetWindowDisplayAffinity(frame, 0);
                    var capture = DesktopNative.VisualBounds(frame);
                    using (var bitmap = new Bitmap(capture.Width, capture.Height)) {
                        Until(() => {
                            using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(capture.Location, Point.Empty, capture.Size);
                            var blue = 0;
                            for (var y = 0; y < bitmap.Height; y++) for (var x = 0; x < bitmap.Width; x++) {
                                if (x > 12 && x < bitmap.Width - 12 && y > 12 && y < bitmap.Height - 12) continue;
                                var color = bitmap.GetPixel(x, y); if (color.B > color.R + 35 && color.B > color.G + 15) blue++;
                            }
                            return blue > 100;
                        }, "The native frame must actually paint a blue outline");
                        if (args.Length == 1) bitmap.Save(args[0], System.Drawing.Imaging.ImageFormat.Png);
                    }
                    SetWindowDisplayAffinity(frame, 0x11);
                    cover.TopMost = true;
                    cover.Show(); SetWindowPos(cover.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x10 | 1 | 2); Application.DoEvents();
                    Until(() => Above(cover.Handle, frame), "Other windows must cover the frame too");
                    for (var step = 0; step < 20; step++) {
                        SetWindowPos(target.Handle, IntPtr.Zero, 160 + step * 5, 140 + step * 3, 640 + step * 2, 440, 0x10 | 4);
                        var beforeTracking = GetForegroundWindow();
                        Until(() => {
                            var expected = DesktopNative.VisualBounds(target.Handle); var actual = DesktopNative.VisualBounds(frame);
                            return Math.Abs(actual.Left - expected.Left + 6) <= 1 && Math.Abs(actual.Top - expected.Top + 6) <= 1 && Math.Abs(actual.Width - expected.Width - 12) <= 1;
                        }, "The frame must follow moves and resizes");
                        Check(GetForegroundWindow() == beforeTracking, "Following a moved window must not change keyboard focus");
                        Check(Above(cover.Handle, frame), "Moving the target must not raise the frame above another app");
                    }
                    Check(host.Show(info) == frame.ToInt64().ToString(), "Consecutive commands reuse one frame");
                    ShowWindow(target.Handle, 0);
                    Until(() => !IsWindowVisible(frame), "A hidden target must have no visible frame");
                    ShowWindow(target.Handle, 4);
                    Until(() => IsWindowVisible(frame), "Restoring the target must restore its frame");
                    ShowWindow(target.Handle, 7);
                    Until(() => !IsWindowVisible(frame), "A minimized target must hide its frame");
                    ShowWindow(target.Handle, 4);
                    Until(() => IsWindowVisible(frame), "An unminimized target must restore its frame");
                    Check(GetForegroundWindow() != frame, "Window tracking must not acquire user input");
                }
                Until(() => !IsWindow(frame), "Ending work must remove the frame");
            }
            Console.WriteLine("{\"applicationFrameChecks\":" + Checks + ",\"passed\":true}"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
