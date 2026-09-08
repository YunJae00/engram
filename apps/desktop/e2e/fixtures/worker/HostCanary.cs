using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal sealed class HostCanary : Form
{
    private readonly TextBox field;
    private string expected = "";
    private Point originalCursor;
    private bool armed;
    public int Samples { get; private set; }

    public HostCanary()
    {
        SessionPlatform.RequireHostedRunner();
        Text = "Parent input fixture";
        ClientSize = new Size(400, 180);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(Math.Max(0, Screen.PrimaryScreen.WorkingArea.Width - 420), 20);
        field = new TextBox { Location = new Point(24, 54), Width = 348 };
        Controls.Add(new Label { Text = "Independent parent keyboard input", AutoSize = true, Location = new Point(24, 24) });
        Controls.Add(field);
    }

    public void Arm()
    {
        Show();
        Activate();
        field.Focus();
        originalCursor = Cursor.Position;
        armed = true;
    }

    public void Sample()
    {
        Verify();
        char value = (char)('a' + Samples % 26);
        var down = new Input { Type = 1, Data = new Data { Keyboard = new Key { Scan = value, Flags = 4 } } };
        var up = new Input { Type = 1, Data = new Data { Keyboard = new Key { Scan = value, Flags = 6 } } };
        var batch = new[] { down, up };
        if (SendInput(2, batch, Marshal.SizeOf(typeof(Input))) != 2)
            throw new InvalidOperationException("The parent fixture input was rejected.");
        expected += value;
        Samples++;
    }

    public void Verify()
    {
        SessionPlatform.RequireHostedRunner();
        if (!armed || GetForegroundWindow() != Handle || !field.Focused)
            throw new InvalidOperationException("The parent fixture lost keyboard focus.");
        if (Cursor.Position != originalCursor)
            throw new InvalidOperationException("The parent pointer moved during child input.");
        if (field.Text != expected)
            throw new InvalidOperationException("The parent received missing or unexpected text.");
    }

    public bool HasExpectedText { get { return field.Text == expected && Samples >= 5; } }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public Data Data; }
    [StructLayout(LayoutKind.Explicit)]
    private struct Data
    {
        [FieldOffset(0)] public Key Keyboard;
        [FieldOffset(0)] public Mouse Mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Key { public ushort Virtual; public ushort Scan; public uint Flags; public uint Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Mouse { public int X; public int Y; public uint Data; public uint Flags; public uint Time; public UIntPtr Extra; }
}
