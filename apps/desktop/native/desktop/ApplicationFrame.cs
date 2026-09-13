using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// An owned native surface follows the target's z-order and disappears with this process.
internal sealed class ApplicationFrame : Form
{
    [StructLayout(LayoutKind.Sequential)] private struct Point { internal int X, Y; internal Point(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] private struct PixelSize { internal int Width, Height; internal PixelSize(int w, int h) { Width = w; Height = h; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] private struct Blend { internal byte Operation, Flags, Alpha, Format; }
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll")] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screen, ref Point destination, ref PixelSize size, IntPtr source, ref Point origin, uint key, ref Blend blend, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetLong64(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern IntPtr SetLong32(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    private readonly System.Windows.Forms.Timer Timer;
    private DesktopTarget Target;
    private Rectangle Last;
    private const int Pad = 6;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { var value = base.CreateParams; value.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000; return value; } }

    internal ApplicationFrame()
    {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
        Timer = new System.Windows.Forms.Timer { Interval = 16 };
        Timer.Tick += delegate { try { Follow(); } catch { ShowWindow(Handle, 0); Timer.Stop(); } };
    }
    internal void Attach(DesktopTarget target)
    {
        if (Target != null && Target.Handle == target.Handle && Target.Pid == target.Pid) { Follow(); Timer.Start(); return; }
        ShowWindow(Handle, 0); Target = target; Last = Rectangle.Empty;
        if (IntPtr.Size == 8) SetLong64(Handle, -8, target.Handle); else SetLong32(Handle, -8, target.Handle);
        SetWindowDisplayAffinity(Handle, 0x11);
        Follow(); Timer.Start();
    }
    private void Follow()
    {
        uint pid; int cloaked;
        if (Target == null || GetWindowThreadProcessId(Target.Handle, out pid) == 0 || pid != Target.Pid || !IsWindowVisible(Target.Handle) || IsIconic(Target.Handle)
            || (DwmGetWindowAttribute(Target.Handle, 14, out cloaked, 4) == 0 && cloaked != 0)) { ShowWindow(Handle, 0); return; }
        var box = DesktopNative.VisualBounds(Target.Handle);
        var bounds = new Rectangle((int)box.Left - Pad, (int)box.Top - Pad, (int)box.Width + Pad * 2, (int)box.Height + Pad * 2);
        if (bounds.Width <= Pad * 2 || bounds.Height <= Pad * 2 || (long)bounds.Width * bounds.Height > 40000000) { ShowWindow(Handle, 0); return; }
        if (Last.Size != bounds.Size) PaintFrame(bounds);
        var previous = GetWindow(Target.Handle, 3);
        if (previous != Handle || Last.Location != bounds.Location || !IsWindowVisible(Handle)) {
            if (previous == Handle) previous = GetWindow(Handle, 3);
            if (previous != IntPtr.Zero && (GetWindowLong(previous, -20) & 8) != 0 && (GetWindowLong(Handle, -20) & 8) == 0) previous = IntPtr.Zero;
            SetWindowPos(Handle, previous, bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x10 | 0x40);
        }
        Last = bounds;
    }
    private void PaintFrame(Rectangle bounds)
    {
        using (var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                for (var spread = Pad - 1; spread >= 0; spread--) {
                    var inset = Pad - spread;
                    using (var path = Rounded(new Rectangle(inset, inset, bounds.Width - inset * 2 - 1, bounds.Height - inset * 2 - 1), 8 + spread))
                    using (var pen = new Pen(Color.FromArgb(spread == 0 ? 190 : 48 - spread * 7, 80, 133, 244), spread == 0 ? 1.4f : 1f)) graphics.DrawPath(pen, path);
                }
            }
            var screen = GetDC(IntPtr.Zero); var dc = CreateCompatibleDC(screen); var image = bitmap.GetHbitmap(Color.FromArgb(0)); var old = SelectObject(dc, image);
            try {
                var destination = new Point(bounds.X, bounds.Y); var size = new PixelSize(bounds.Width, bounds.Height); var origin = new Point(0, 0);
                var blend = new Blend { Alpha = 255, Format = 1 };
                if (!UpdateLayeredWindow(Handle, screen, ref destination, ref size, dc, ref origin, 0, ref blend, 2)) throw new InvalidOperationException("The application frame could not be drawn.");
            } finally { SelectObject(dc, old); DeleteObject(image); DeleteDC(dc); ReleaseDC(IntPtr.Zero, screen); }
        }
    }
    private static GraphicsPath Rounded(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath(); var diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90); path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90); path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90); path.CloseFigure(); return path;
    }
    protected override void Dispose(bool disposing) { if (disposing) { Timer.Stop(); Timer.Dispose(); } base.Dispose(disposing); }
}

internal sealed class ApplicationFrameHost : IDisposable
{
    private ApplicationFrame Frame;
    private Thread Thread;
    private readonly ManualResetEvent Ready = new ManualResetEvent(false);
    private Exception StartupError;
    internal string Show(DesktopTarget target)
    {
        if (Thread == null) {
            Thread = new Thread(delegate() {
                try { Frame = new ApplicationFrame(); var handle = Frame.Handle; }
                catch (Exception error) { StartupError = error; }
                finally { Ready.Set(); }
                if (StartupError == null) Application.Run();
            }) { IsBackground = true, Name = "Application frame" };
            Thread.SetApartmentState(ApartmentState.STA); Thread.Start();
        }
        if (!Ready.WaitOne(3000)) throw new InvalidOperationException("The application frame did not become ready.");
        if (StartupError != null) throw new InvalidOperationException("The application frame could not start.", StartupError);
        return (string)Frame.Invoke(new Func<string>(delegate { Frame.Attach(target); return Frame.Handle.ToInt64().ToString(); }));
    }
    public void Dispose()
    {
        if (Frame != null && !Frame.IsDisposed) { try { Frame.BeginInvoke(new Action(delegate { Frame.Dispose(); Application.ExitThread(); })); } catch (InvalidOperationException) { } }
        if (Thread == null || Thread.Join(1000)) Ready.Dispose();
    }
}
