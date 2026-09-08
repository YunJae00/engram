using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;

internal static class DesktopCapture
{
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out DesktopNative.Rectangle rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref DesktopNative.Point point);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);

    internal static Rect Bounds(IntPtr window)
    {
        DesktopNative.Rectangle rect;
        var origin = new DesktopNative.Point();
        if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref origin) || rect.Right <= 0 || rect.Bottom <= 0)
            throw new InvalidOperationException("The app does not have a visible client area");
        return new Rect(origin.X, origin.Y, rect.Right, rect.Bottom);
    }

    internal static object Read(DesktopTarget target, Func<bool> current)
    {
        // Client-only rendering has a documented origin, unlike cropped window thumbnails.
        var bounds = Bounds(target.Handle);
        if (bounds.Width > 8192 || bounds.Height > 8192 || bounds.Width * bounds.Height > 16000000
            || (GetWindowLong(target.Handle, -20) & 0x00400000) != 0)
            throw new InvalidOperationException("This app does not support safe client-area capture");
        if (!current()) throw new InvalidOperationException("The screenshot request was cancelled");
        using (var full = new Bitmap((int)bounds.Width, (int)bounds.Height, PixelFormat.Format32bppRgb))
        {
            using (var graphics = Graphics.FromImage(full))
            {
                var dc = graphics.GetHdc();
                try
                {
                    if (!PrintWindow(target.Handle, dc, 3)) throw new InvalidOperationException("This app did not render its window. Use accessibility text instead");
                }
                finally { graphics.ReleaseHdc(dc); }
            }
            if (!current() || Bounds(target.Handle) != bounds) throw new InvalidOperationException("The app changed while capturing. Observe it again");
            var scale = Math.Min(1.0, Math.Min(1600.0 / bounds.Width, 1000.0 / bounds.Height));
            var width = Math.Max(1, (int)Math.Round(bounds.Width * scale));
            var height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
            using (var image = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (var graphics = Graphics.FromImage(image))
            using (var stream = new MemoryStream())
            using (var quality = new EncoderParameters(1))
            {
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(full, new Rectangle(0, 0, width, height));
                quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
                image.Save(stream, ImageCodecInfo.GetImageEncoders().First(codec => codec.FormatID == ImageFormat.Jpeg.Guid), quality);
                if (stream.Length > 350000) throw new InvalidOperationException("The screenshot exceeded its safe size limit. Use accessibility text instead");
                return new { basis = "client-physical", bounds = AutomationSession.Bounds(bounds), width = width, height = height,
                    data = Convert.ToBase64String(stream.ToArray()) };
            }
        }
    }
}
