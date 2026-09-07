using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

internal static class Program
{
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Dictionary<string, NativeView> Views = new Dictionary<string, NativeView>();
    private static readonly TaskCompletionSource<bool> BrowserExited = new TaskCompletionSource<bool>();
    private static readonly SemaphoreSlim Commands = new SemaphoreSlim(1, 1);
    private static Control dispatcher;
    private static CoreWebView2Environment environment;
    private static bool stopping;
    private static NativeInput input;

    private static void Send(object value)
    {
        Console.WriteLine(Json.Serialize(value));
        Console.Out.Flush();
    }

    private static async Task<string> Create(string opener = null, Action<CoreWebView2> attach = null)
    {
        if (Views.Count >= 32) throw new InvalidOperationException("Close an existing browser page before opening another");
        var view = new NativeView { Left = -32000, Top = -32000, Width = 1280, Height = 860, Visible = false };
        view.CreateControl();
        try
        {
            await view.EnsureCoreWebView2Async(environment);
            view.Place(0, 0, 1280, 860, false);
            view.CoreWebView2.LaunchingExternalUriScheme += delegate(object sender, CoreWebView2LaunchingExternalUriSchemeEventArgs request) { request.Cancel = true; };
            if (attach != null) attach(view.CoreWebView2);
            if (opener == null) view.CoreWebView2.Navigate("about:blank");
            var info = Json.Deserialize<Dictionary<string, object>>(await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Target.getTargetInfo", "{}"));
            var target = (Dictionary<string, object>)info["targetInfo"];
            var id = (string)target["targetId"];
            Views.Add(id, view);
            view.CoreWebView2.WindowCloseRequested += delegate { Remove(id); };
            view.CoreWebView2.NewWindowRequested += async delegate(object sender, CoreWebView2NewWindowRequestedEventArgs request)
            {
                var deferred = request.GetDeferral();
                try
                {
                    if (stopping) { request.Handled = true; return; }
                    var popup = await Create(id, delegate(CoreWebView2 core)
                    {
                        request.NewWindow = core;
                        request.Handled = true;
                        deferred.Complete();
                        deferred = null;
                    });
                    Send(new { type = "popup", target = popup, opener = id });
                }
                catch (Exception error) { Send(new { type = "error", message = error.Message }); request.Handled = true; }
                finally { if (deferred != null) deferred.Complete(); }
            };
            view.CoreWebView2.ProcessFailed += delegate { Send(new { type = "failed", target = id }); };
            view.Place(0, 0, 1280, 860, false);
            Send(new { type = "created", target = id, opener = opener });
            return id;
        }
        catch { view.Dispose(); throw; }
    }

    private static void Remove(string id)
    {
        NativeView view;
        if (!Views.TryGetValue(id, out view)) return;
        Views.Remove(id);
        view.Dispose();
    }

    private static async Task Stop()
    {
        if (stopping) return;
        stopping = true;
        if (input != null) input.Dispose();
        foreach (var id in Views.Keys.ToArray()) Remove(id);
        var clean = await Task.WhenAny(BrowserExited.Task, Task.Delay(15000)) == BrowserExited.Task;
        Send(new { type = "stopped", clean = clean });
        Application.ExitThread();
    }

    private static async void Receive(string line)
    {
        await Commands.WaitAsync();
        int serial = 0;
        try
        {
            if (stopping) return;
            var message = Json.Deserialize<Dictionary<string, object>>(line);
            serial = Convert.ToInt32(message["id"]);
            var method = (string)message["method"];
            if (method == "create") Send(new { id = serial, target = await Create() });
            else if (method == "layout")
            {
                var shown = new HashSet<string>();
                var items = (System.Collections.ArrayList)message["views"];
                if (items.Count > 4) throw new InvalidOperationException("Too many visible pages");
                foreach (Dictionary<string, object> item in items)
                {
                    var target = (string)item["target"];
                    NativeView view;
                    if (!Views.TryGetValue(target, out view)) continue;
                    int x = Convert.ToInt32(item["x"]), y = Convert.ToInt32(item["y"]);
                    int width = Convert.ToInt32(item["width"]), height = Convert.ToInt32(item["height"]);
                    if (x < -32768 || y < -32768 || width < 1 || height < 1 || width > 32768 || height > 32768 || x + width > 32768 || y + height > 32768) continue;
                    System.Drawing.Rectangle? clip = null;
                    if (item.ContainsKey("clip")) {
                        var crop = (Dictionary<string, object>)item["clip"];
                        clip = System.Drawing.Rectangle.Intersect(new System.Drawing.Rectangle(0, 0, width, height), new System.Drawing.Rectangle(Convert.ToInt32(crop["x"]), Convert.ToInt32(crop["y"]), Convert.ToInt32(crop["width"]), Convert.ToInt32(crop["height"])));
                    }
                    view.Place(x, y, width, height, true, clip);
                    shown.Add(target);
                }
                foreach (var pair in Views) if (!shown.Contains(pair.Key)) pair.Value.Place(0, 0, 0, 0, false);
                Send(new { id = serial });
            }
            else if (method == "close") { Remove((string)message["target"]); Send(new { id = serial }); }
            else if (method == "stop") { Send(new { id = serial }); await Stop(); }
            else throw new InvalidOperationException("Unknown browser command");
        }
        catch (Exception error) { Send(new { id = serial, error = error.Message }); }
        finally { Commands.Release(); }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            if (args.Length != 3) throw new ArgumentException("Expected parent, profile and debug port");
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            NativeView.Owner = new IntPtr(long.Parse(args[0]));
            var port = int.Parse(args[2]);
            if (port < 1024 || port > 65535 || !Path.IsPathRooted(args[1])) throw new ArgumentException("Invalid browser configuration");
            Application.EnableVisualStyles();
            dispatcher = new Control();
            dispatcher.CreateControl();
            dispatcher.BeginInvoke(new Action(async delegate
            {
                try
                {
                    var options = new CoreWebView2EnvironmentOptions("--remote-debugging-port=" + port + " --remote-debugging-address=127.0.0.1");
                    options.AllowSingleSignOnUsingOSPrimaryAccount = true;
                    environment = await CoreWebView2Environment.CreateAsync(null, args[1], options);
                    environment.BrowserProcessExited += delegate { BrowserExited.TrySetResult(true); };
                    var first = await Create();
                    input = new NativeInput(Views, delegate(string target) { Send(new { type = "input", target = target }); });
                    Send(new { type = "ready", target = first });
                    var reader = new Thread(delegate()
                    {
                        string line;
                        while ((line = Console.ReadLine()) != null)
                        {
                            if (line.Length > 32768) continue;
                            var command = line;
                            dispatcher.BeginInvoke(new Action(delegate { Receive(command); }));
                        }
                        dispatcher.BeginInvoke(new Action(delegate { Receive("{\"id\":0,\"method\":\"stop\"}"); }));
                    });
                    reader.IsBackground = true;
                    reader.Start();
                }
                catch (Exception error) { Send(new { type = "error", message = error.Message }); Application.ExitThread(); }
            }));
            Application.Run();
        }
        catch (Exception error) { Send(new { type = "error", message = error.Message }); Environment.ExitCode = 1; }
    }
}
