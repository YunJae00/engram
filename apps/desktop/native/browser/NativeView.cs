using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

internal sealed class NativeView : WebView2
{
    internal static IntPtr Owner;
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    private bool placed;
    private bool showing;
    private Rectangle visibleRegion;

    protected override CreateParams CreateParams
    {
        get
        {
            var value = base.CreateParams;
            value.Parent = Owner;
            value.Style = (value.Style & unchecked((int)~0x80000000)) | 0x40000000;
            return value;
        }
    }

    internal void Place(int x, int y, int width, int height, bool visible, Rectangle? clip = null)
    {
        if (!visible)
        {
            if (placed && !showing) return;
            // Keep the controller running for background automation. Child
            // windows outside their parent's client area remain clipped.
            Bounds = new Rectangle(-32000, -32000, Width, Height);
            Show();
            SetWindowPos(Handle, IntPtr.Zero, -32000, -32000, Width, Height, 0x0050);
            placed = true;
            showing = false;
            return;
        }
        var region = clip ?? new Rectangle(0, 0, width, height);
        if (placed && showing && Bounds == new Rectangle(x, y, width, height) && visibleRegion == region) return;
        var previous = Region;
        Region = new Region(region);
        if (previous != null) previous.Dispose();
        visibleRegion = region;
        Bounds = new Rectangle(x, y, width, height);
        Show();
        SetWindowPos(Handle, IntPtr.Zero, x, y, width, height, 0x0050);
        placed = true;
        showing = true;
        Invalidate(true);
    }
}
