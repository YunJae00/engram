using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using MSTSCLib;

internal sealed class RdpSession : IDisposable
{
    private static readonly Guid EventsId = new Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6");
    private readonly int ownerThread;
    private readonly string command;
    private readonly string directory;
    private readonly QuietForm window;
    private readonly SessionControl host;
    private readonly Action<int> disconnected;
    private readonly Action<int> fatalError;
    private readonly Action authenticationWarning;
    private IMsRdpClient9 client;
    private object control;
    private bool started;
    private bool disposed;
    private bool disconnecting;
    private int eventMask;

    public string RuntimeError { get; private set; }

    public RdpSession(string fixturePath, string arguments, int width, int height)
    {
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
            throw new InvalidOperationException("The session host requires an STA thread.");
        CheckSize(width, height);
        if (String.IsNullOrWhiteSpace(fixturePath) || !Path.IsPathRooted(fixturePath)
            || !File.Exists(fixturePath) || !fixturePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("An existing absolute fixture executable path is required.", "fixturePath");
        if (fixturePath.IndexOfAny(new[] { '"', '\0', '\r', '\n' }) >= 0)
            throw new ArgumentException("The fixture path contains an invalid character.", "fixturePath");
        arguments = arguments ?? String.Empty;
        if (arguments.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0)
            throw new ArgumentException("The fixture arguments contain an invalid character.", "arguments");
        string absolutePath = Path.GetFullPath(fixturePath);
        command = "\"" + absolutePath + "\"" + (arguments.Length == 0 ? "" : " " + arguments);
        if (command.Length > 259)
            throw new ArgumentException("The initial program exceeds the supported command length.", "arguments");
        directory = Path.GetDirectoryName(absolutePath);
        ownerThread = Thread.CurrentThread.ManagedThreadId;
        window = new QuietForm { ClientSize = new Size(width, height), Text = "Worker session fixture" };
        host = new SessionControl { Dock = DockStyle.Fill, TabStop = false };
        ((ISupportInitialize)host).BeginInit();
        window.Controls.Add(host);
        ((ISupportInitialize)host).EndInit();
        disconnected = delegate(int reason)
        {
            if (!disconnecting && !disposed) Fail("The worker session disconnected (" + reason + ").");
        };
        fatalError = delegate(int code) { Fail("The session control reported a fatal error (" + code + ")."); };
        authenticationWarning = delegate { Fail("The connection requires interactive authentication."); };
    }

    public bool Connected
    {
        get
        {
            CheckThread();
            if (disposed || client == null || RuntimeError != null) return false;
            try { return client.Connected == 1; }
            catch (COMException error) { Fail("Reading connection state failed: " + ErrorCode(error)); return false; }
        }
    }

    public void Start()
    {
        CheckUsable();
        if (started) throw new InvalidOperationException("The session has already been started.");
        started = true;
        try
        {
            window.Show();
            host.CreateControl();
            control = host.ControlObject;
            client = (IMsRdpClient9)control;
            Configure();
            ComEventsHelper.Combine(control, EventsId, 4, disconnected);
            eventMask |= 1;
            ComEventsHelper.Combine(control, EventsId, 10, fatalError);
            eventMask |= 2;
            ComEventsHelper.Combine(control, EventsId, 18, authenticationWarning);
            eventMask |= 4;
            client.Connect();
        }
        catch (Exception error)
        {
            Fail("Starting the protected worker session failed: " + ErrorCode(error));
        }
    }

    private void Configure()
    {
        if (client.SecuredSettingsEnabled == 0)
            throw new InvalidOperationException("The initial-program settings are unavailable.");
        var advanced = client.AdvancedSettings9;
        advanced.GrabFocusOnConnect = false;
        advanced.RedirectClipboard = false;
        advanced.RedirectDrives = false;
        advanced.RedirectPrinters = false;
        advanced.RedirectPorts = false;
        advanced.RedirectSmartCards = false;
        advanced.RedirectDevices = false;
        advanced.RedirectPOSDevices = false;
        advanced.AudioCaptureRedirectionMode = false;
        advanced.AudioRedirectionMode = 2;
        advanced.EnableAutoReconnect = false;
        advanced.DisplayConnectionBar = false;
        advanced.SmartSizing = false;
        if (advanced.GrabFocusOnConnect || advanced.RedirectClipboard || advanced.RedirectDrives
            || advanced.RedirectPrinters || advanced.RedirectPorts || advanced.RedirectSmartCards
            || advanced.RedirectDevices || advanced.RedirectPOSDevices || advanced.AudioCaptureRedirectionMode
            || advanced.AudioRedirectionMode != 2 || advanced.EnableAutoReconnect)
            throw new InvalidOperationException("The required input and device protections were rejected.");

        var credentials = (IMsRdpClientNonScriptable5)control;
        credentials.AllowPromptingForCredentials = false;
        credentials.AllowCredentialSaving = false;
        if (credentials.AllowPromptingForCredentials || credentials.AllowCredentialSaving)
            throw new InvalidOperationException("Credential prompting could not be disabled.");
        DisableCameras();

        var extended = (SessionSettings)control;
        SetRequired(extended, "ConnectToChildSession", true);
        SetRequired(extended, "IgnoreServerGeneratedMouseMoves", true);
        SetRequired(extended, "EnableLocationRedirection", false);
        client.Server = "localhost";
        client.DesktopWidth = window.ClientSize.Width;
        client.DesktopHeight = window.ClientSize.Height;
        client.ColorDepth = 32;
        client.SecuredSettings.StartProgram = command;
        client.SecuredSettings.WorkDir = directory;
        if (client.SecuredSettings.StartProgram != command || client.SecuredSettings.WorkDir != directory)
            throw new InvalidOperationException("The fixture initial program was not accepted.");
    }

    private void DisableCameras()
    {
        var cameras = ((IMsRdpClientNonScriptable7)control).CameraRedirConfigCollection;
        cameras.RedirectByDefault = false;
        cameras.Rescan();
        if (cameras.RedirectByDefault)
            throw new InvalidOperationException("Default camera redirection could not be disabled.");
        for (uint index = 0; index < cameras.Count; index++)
        {
            var camera = cameras.get_ByIndex(index);
            camera.Redirected = false;
            if (camera.Redirected)
                throw new InvalidOperationException("Camera redirection could not be disabled.");
        }
    }

    private static void SetRequired(SessionSettings settings, string name, bool enabled)
    {
        object value = enabled;
        settings.PutProperty(name, ref value);
        if (!Object.Equals(settings.GetProperty(name), enabled))
            throw new InvalidOperationException("The required session setting was rejected: " + name + ".");
    }

    public void Resize(int width, int height)
    {
        CheckUsable();
        CheckSize(width, height);
        if (!Connected) throw new InvalidOperationException("The worker session is not connected.");
        try
        {
            client.UpdateSessionDisplaySettings((uint)width, (uint)height,
                (uint)Math.Max(10, width * 254 / 960), (uint)Math.Max(10, height * 254 / 960), 0, 100, 100);
            window.ClientSize = new Size(width, height);
        }
        catch (Exception error) { Fail("Resizing the worker session failed: " + ErrorCode(error)); }
    }

    public void Disconnect()
    {
        CheckThread();
        if (disposed) return;
        disconnecting = true;
        try { if (client != null && client.Connected != 0) client.Disconnect(); }
        catch (COMException error) { RecordError("Disconnecting the worker session failed: " + ErrorCode(error)); }
        finally { window.Hide(); }
    }

    private void Fail(string message)
    {
        RecordError(message);
        if (disposed || disconnecting) return;
        // Disconnect after the current COM event returns to avoid reentrant teardown.
        if (window.IsHandleCreated) window.BeginInvoke(new Action(Disconnect));
    }

    private void RecordError(string message)
    {
        if (RuntimeError == null) RuntimeError = message;
    }

    private static string ErrorCode(Exception error)
    {
        return error.GetType().Name + " (0x" + Marshal.GetHRForException(error).ToString("X8") + "): " + error.Message;
    }

    private void CheckThread()
    {
        if (Thread.CurrentThread.ManagedThreadId != ownerThread)
            throw new InvalidOperationException("Session operations must use the owning STA thread.");
    }

    private void CheckUsable()
    {
        CheckThread();
        if (disposed) throw new ObjectDisposedException("RdpSession");
        if (RuntimeError != null) throw new InvalidOperationException(RuntimeError);
    }

    private static void CheckSize(int width, int height)
    {
        if (width < 200 || width > 3840 || height < 150 || height > 2160)
            throw new ArgumentOutOfRangeException("width", "The fixture size must fit within 200x150 and 3840x2160.");
    }

    public void Dispose()
    {
        CheckThread();
        if (disposed) return;
        Disconnect();
        disposed = true;
        RemoveEvent(1, 4, disconnected);
        RemoveEvent(2, 10, fatalError);
        RemoveEvent(4, 18, authenticationWarning);
        window.Dispose();
        client = null;
        control = null;
    }

    private void RemoveEvent(int mask, int id, Delegate callback)
    {
        if ((eventMask & mask) == 0 || control == null) return;
        try { ComEventsHelper.Remove(control, EventsId, id, callback); }
        catch (COMException error) { RecordError("Releasing session events failed: " + ErrorCode(error)); }
        eventMask &= ~mask;
    }

    [ComImport, Guid("302D8188-0052-4807-806A-362B628F9AC5")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface SessionSettings
    {
        void PutProperty([MarshalAs(UnmanagedType.BStr)] string name,
            [In, MarshalAs(UnmanagedType.Struct)] ref object value);
        [return: MarshalAs(UnmanagedType.Struct)]
        object GetProperty([MarshalAs(UnmanagedType.BStr)] string name);
    }

    private sealed class SessionControl : AxHost
    {
        internal SessionControl() : base("1DF7C823-B2D4-4B54-975A-F2AC5D7CF8B8")
        {
            TabStop = false;
        }
        internal object ControlObject { get { return GetOcx(); } }
    }

    private sealed class QuietForm : Form
    {
        internal QuietForm()
        {
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(0, 0);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                parameters.ExStyle |= 0x08000000;
                return parameters;
            }
        }
    }
}
