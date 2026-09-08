using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

internal sealed class ControlIndicator : Form
{
    private readonly Label Caption;
    private readonly Button StopButton;
    private Timer PauseTimer;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000000 | 0x00000080; return value; }
    }

    internal ControlIndicator(Action stopped)
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(342, 38);
        BackColor = Color.FromArgb(30, 51, 83);
        using (var shape = Shape(ClientRectangle, 15)) Region = new Region(shape);
        Caption = new Label { Text = "Engram is using this app", ForeColor = Color.White,
            AutoSize = false, Bounds = new Rectangle(12, 0, 240, 38), TextAlign = ContentAlignment.MiddleLeft };
        StopButton = new Button { Text = "Stop · Esc", Bounds = new Rectangle(254, 5, 82, 28),
            FlatStyle = FlatStyle.Flat, BackColor = Color.White, ForeColor = Color.FromArgb(30, 51, 83), TabStop = false };
        StopButton.Click += delegate { stopped(); };
        Controls.Add(Caption);
        Controls.Add(StopButton);
    }

    internal void Start(DesktopTarget target)
    {
        if (PauseTimer != null) { PauseTimer.Stop(); PauseTimer.Dispose(); PauseTimer = null; }
        var bounds = DesktopNative.Bounds(target.Handle);
        var screen = Screen.FromHandle(target.Handle).WorkingArea;
        Location = new Point(Math.Max(screen.Left, Math.Min(screen.Right - Width, (int)(bounds.Left + (bounds.Width - Width) / 2))),
            Math.Max(screen.Top, Math.Min(screen.Bottom - Height, (int)bounds.Top + 6)));
        Caption.Text = "Engram is using this app";
        StopButton.Enabled = true;
        Show();
    }

    internal void Paused()
    {
        Caption.Text = "Control stopped";
        StopButton.Enabled = false;
        if (PauseTimer != null) { PauseTimer.Stop(); PauseTimer.Dispose(); }
        PauseTimer = new Timer { Interval = 600 };
        PauseTimer.Tick += delegate { PauseTimer.Stop(); Hide(); };
        PauseTimer.Start();
    }

    protected override void Dispose(bool disposing)
    { if (disposing && PauseTimer != null) PauseTimer.Dispose(); base.Dispose(disposing); }

    private static GraphicsPath Shape(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var size = radius * 2;
        path.AddArc(bounds.Left, bounds.Top, size, size, 180, 90);
        path.AddArc(bounds.Right - size, bounds.Top, size, size, 270, 90);
        path.AddArc(bounds.Right - size, bounds.Bottom - size, size, size, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - size, size, size, 90, 90);
        path.CloseFigure();
        return path;
    }
    protected override void OnPaint(PaintEventArgs args)
    {
        base.OnPaint(args);
        args.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var shape = Shape(new Rectangle(0, 0, Width - 1, Height - 1), 15))
        using (var pen = new Pen(Color.FromArgb(97, 154, 229))) args.Graphics.DrawPath(pen, shape);
    }
}
