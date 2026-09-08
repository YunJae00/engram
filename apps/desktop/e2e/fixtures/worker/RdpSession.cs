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
    private string startupStage;

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
            if (!disconnecting && !disposed) Fail(DescribeDisconnection(reason));
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
            startupStage = "window.show";
            window.Show();
            startupStage = "window.create-control";
            host.CreateControl();
            startupStage = "COM.control-object";
            control = host.ControlObject;
            startupStage = "COM.client-interface";
            client = (IMsRdpClient9)control;
            startupStage = "configure";
            Configure();
            startupStage = "events.disconnected";
            ComEventsHelper.Combine(control, EventsId, 4, disconnected);
            eventMask |= 1;
            startupStage = "events.fatal-error";
            ComEventsHelper.Combine(control, EventsId, 10, fatalError);
            eventMask |= 2;
            startupStage = "events.authentication-warning";
            ComEventsHelper.Combine(control, EventsId, 18, authenticationWarning);
            eventMask |= 4;
            startupStage = "connect";
            client.Connect();
            startupStage = "connect.requested";
        }
        catch (Exception error)
        {
            Fail("Starting the protected worker session failed at " + startupStage + ": " + ErrorCode(error));
        }
    }

    private void Configure()
    {
        startupStage = "configure.secured-settings-enabled";
        if (client.SecuredSettingsEnabled == 0)
            throw new InvalidOperationException("The initial-program settings are unavailable.");
        startupStage = "configure.advanced-settings-interface";
        var advanced = client.AdvancedSettings9;
        startupStage = "configure.GrabFocusOnConnect";
        advanced.GrabFocusOnConnect = false;
        startupStage = "configure.RedirectClipboard";
        advanced.RedirectClipboard = false;
        startupStage = "configure.RedirectDrives";
        advanced.RedirectDrives = false;
        startupStage = "configure.RedirectPrinters";
        advanced.RedirectPrinters = false;
        startupStage = "configure.RedirectPorts";
        advanced.RedirectPorts = false;
        startupStage = "configure.RedirectSmartCards";
        advanced.RedirectSmartCards = false;
        startupStage = "configure.RedirectDevices";
        advanced.RedirectDevices = false;
        startupStage = "configure.RedirectPOSDevices";
        advanced.RedirectPOSDevices = false;
        startupStage = "configure.AudioCaptureRedirectionMode";
        advanced.AudioCaptureRedirectionMode = false;
        startupStage = "configure.AudioRedirectionMode";
        advanced.AudioRedirectionMode = 2;
        startupStage = "configure.EnableCredSspSupport";
        advanced.EnableCredSspSupport = true;
        startupStage = "configure.EnableCredSspSupport-readback";
        if (!advanced.EnableCredSspSupport)
            throw new InvalidOperationException("Connection-level CredSSP support was not accepted.");
        startupStage = "configure.EnableAutoReconnect";
        advanced.EnableAutoReconnect = false;
        startupStage = "configure.DisplayConnectionBar";
        advanced.DisplayConnectionBar = false;
        startupStage = "configure.SmartSizing";
        advanced.SmartSizing = false;
        startupStage = "configure.advanced-settings-readback";
        if (advanced.GrabFocusOnConnect || advanced.RedirectClipboard || advanced.RedirectDrives
            || advanced.RedirectPrinters || advanced.RedirectPorts || advanced.RedirectSmartCards
            || advanced.RedirectDevices || advanced.RedirectPOSDevices || advanced.AudioCaptureRedirectionMode
            || advanced.AudioRedirectionMode != 2 || advanced.EnableAutoReconnect)
            throw new InvalidOperationException("The required input and device protections were rejected.");

        startupStage = "configure.credentials-interface";
        var credentials = (IMsRdpClientNonScriptable5)control;
        startupStage = "configure.AllowPromptingForCredentials";
        credentials.AllowPromptingForCredentials = false;
        startupStage = "configure.AllowCredentialSaving";
        credentials.AllowCredentialSaving = false;
        startupStage = "configure.credentials-readback";
        if (credentials.AllowPromptingForCredentials || credentials.AllowCredentialSaving)
            throw new InvalidOperationException("Credential prompting could not be disabled.");
        DisableCameras();

        startupStage = "configure.extended-settings-interface";
        var extended = (SessionSettings)control;
        startupStage = "configure.extended-settings";
        SetRequired(extended, "ConnectToChildSession", true);
        SetRequired(extended, "IgnoreServerGeneratedMouseMoves", true);
        SetRequired(extended, "EnableLocationRedirection", false);
        startupStage = "configure.Server";
        client.Server = "localhost";
        startupStage = "configure.current-user-identity";
        client.UserName = Environment.UserName;
        client.Domain = Environment.UserDomainName;
        if (client.UserName != Environment.UserName || client.Domain != Environment.UserDomainName)
            throw new InvalidOperationException("The current-user connection identity was not accepted.");
        startupStage = "configure.DesktopWidth";
        client.DesktopWidth = window.ClientSize.Width;
        startupStage = "configure.DesktopHeight";
        client.DesktopHeight = window.ClientSize.Height;
        startupStage = "configure.ColorDepth";
        client.ColorDepth = 32;
        startupStage = "configure.StartProgram";
        client.SecuredSettings.StartProgram = command;
        startupStage = "configure.WorkDir";
        client.SecuredSettings.WorkDir = directory;
        startupStage = "configure.initial-program-readback";
        if (client.SecuredSettings.StartProgram != command || client.SecuredSettings.WorkDir != directory)
            throw new InvalidOperationException("The fixture initial program was not accepted.");
    }

    private void DisableCameras()
    {
        startupStage = "configure.camera-collection";
        var cameras = ((IMsRdpClientNonScriptable7)control).CameraRedirConfigCollection;
        startupStage = "configure.camera-default-redirection";
        cameras.RedirectByDefault = false;
        startupStage = "configure.camera-rescan";
        cameras.Rescan();
        startupStage = "configure.camera-default-readback";
        if (cameras.RedirectByDefault)
            throw new InvalidOperationException("Default camera redirection could not be disabled.");
        for (uint index = 0; index < cameras.Count; index++)
        {
            startupStage = "configure.camera-" + index;
            var camera = cameras.get_ByIndex(index);
            camera.Redirected = false;
            if (camera.Redirected)
                throw new InvalidOperationException("Camera redirection could not be disabled.");
        }
    }

    private static void SetRequired(SessionSettings settings, string name, bool enabled)
    {
        string operation = "write";
        try
        {
            object value = enabled;
            settings.PutProperty(name, ref value);
            operation = "readback";
            if (!Object.Equals(settings.GetProperty(name), enabled))
                throw new InvalidOperationException("The required session setting value was rejected.");
        }
        catch (Exception error)
        {
            throw new InvalidOperationException("Required extended setting " + name + " failed during " + operation + ".", error);
        }
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

    private string DescribeDisconnection(int reason)
    {
        string message = "The worker session disconnected (reason=" + reason + ", stage=" + startupStage + ").";
        if (client == null) return message + " The client interface is unavailable.";
        try
        {
            var extended = client.ExtendedDisconnectReason;
            message += " ExtendedDisconnectReason=" + (uint)extended + " (" + extended + ").";
            string description = client.GetErrorDescription((uint)reason, (uint)extended);
            return message + Environment.NewLine + description;
        }
        catch (Exception error)
        {
            return message + " Disconnect diagnostics failed: " + ErrorCode(error);
        }
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
        return "0x" + Marshal.GetHRForException(error).ToString("X8") + Environment.NewLine + error.ToString();
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
