using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class WorkerSession
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly string Output = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "results");

    [STAThread]
    private static int Main(string[] args)
    {
        Directory.CreateDirectory(Output);
        try
        {
            if (args.Length == 3 && args[0] == "--worker") return RunWorker(Int32.Parse(args[1]), args[2]);
            if (args.Length != 1 || (args[0] != "--run-hosted" && args[0] != "--preflight"))
                throw new ArgumentException("Select --preflight or --run-hosted.");
            var report = new Dictionary<string, object> {
                { "parentSession", SessionPlatform.Current }, { "enabled", SessionPlatform.Enabled() },
                { "existingChild", SessionPlatform.Child() }, { "os", Environment.OSVersion.VersionString },
                { "inputTested", false }, { "passed", false }
            };
            if (args[0] == "--preflight")
            {
                report["mode"] = "read-only";
                Write("parent-result.json", report);
                return 0;
            }
            SessionPlatform.RequireHostedRunner();
            return RunParent(report);
        }
        catch (Exception error)
        {
            string result = args.Length > 0 && args[0] == "--worker" ? "worker-bootstrap-error.json" : "parent-result.json";
            Write(result, new { passed = false, inputTested = false, error = error.ToString() });
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static int RunWorker(int parent, string nonce)
    {
        // Only the parent can resolve its child ID; bootstrap waits for that bound lease.
        var deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 30000)
        {
            if (File.Exists(Path.Combine(Output, "lease.json")))
            {
                var lease = Read("lease.json");
                if ((string)lease["nonce"] != nonce || Convert.ToInt32(lease["parentSession"]) != parent)
                    throw new InvalidOperationException("The worker lease does not match its launcher.");
                int child = Convert.ToInt32(lease["childSession"]);
                if (child == parent || SessionPlatform.Current != child)
                    throw new InvalidOperationException("The fixture did not start in its assigned child session.");
                int result = WorkerFixture.Run(Output, parent, child, nonce);
                var acknowledgment = Stopwatch.StartNew();
                while (!File.Exists(Path.Combine(Output, "release.json")) && acknowledgment.ElapsedMilliseconds < 15000)
                    Thread.Sleep(100);
                return result;
            }
            Thread.Sleep(100);
        }
        throw new TimeoutException("The verified worker lease was not provided.");
    }

    private static int RunParent(Dictionary<string, object> report)
    {
        if ((int)report["existingChild"] != -1)
            throw new InvalidOperationException("An existing child session will not be reused.");
        bool changed = false;
        int child = -1;
        RdpSession rdp = null;
        HostCanary canary = null;
        try
        {
            if (!(bool)report["enabled"])
            {
                changed = true;
                SessionPlatform.SetEnabled(true);
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string nonce = Guid.NewGuid().ToString("N");
            int parent = SessionPlatform.Current;
            var elapsed = Stopwatch.StartNew();
            canary = new HostCanary();
            rdp = new RdpSession(Process.GetCurrentProcess().MainModule.FileName,
                "--worker " + parent + " " + nonce, 800, 600);
            using (var context = new ApplicationContext())
            using (var timer = new System.Windows.Forms.Timer { Interval = 250 })
            {
                bool started = false;
                bool resized = false;
                bool finished = false;
                timer.Tick += delegate
                {
                    try
                    {
                        if (elapsed.ElapsedMilliseconds > 90000)
                            throw new TimeoutException("The child fixture did not complete within 90 seconds.");
                        if (!started)
                        {
                            canary.Arm();
                            rdp.Start();
                            started = true;
                            return;
                        }
                        if (rdp.RuntimeError != null) throw new InvalidOperationException(rdp.RuntimeError);
                        if (File.Exists(Path.Combine(Output, "worker-bootstrap-error.json")))
                            throw new InvalidOperationException("Worker bootstrap failed: " + Read("worker-bootstrap-error.json")["error"]);
                        if (finished)
                        {
                            canary.Verify();
                            if (!canary.HasExpectedText) throw new InvalidOperationException("Parent input readback failed.");
                            report["parentSamples"] = canary.Samples;
                            report["parentInputUnaffected"] = true;
                            report["passed"] = true;
                            timer.Stop();
                            context.ExitThread();
                            return;
                        }
                        canary.Sample();
                        int found = SessionPlatform.Child();
                        if (child >= 0 && found != child)
                            throw new InvalidOperationException("The session lease was revoked or replaced.");
                        if (child < 0 && found >= 0)
                        {
                            if (found == 0 || found == parent) throw new InvalidOperationException("The child is not isolated.");
                            child = found;
                            report["childSession"] = child;
                            Write("lease.json", new { parentSession = parent, childSession = child, nonce = nonce });
                        }
                        if (child >= 0 && rdp.Connected && !resized)
                        {
                            rdp.Resize(960, 720);
                            if (rdp.RuntimeError != null) throw new InvalidOperationException(rdp.RuntimeError);
                            resized = true;
                            report["displayResizeRequested"] = true;
                        }
                        if (File.Exists(Path.Combine(Output, "worker-result.json")))
                        {
                            var result = Read("worker-result.json");
                            report["worker"] = result;
                            if ((string)result["nonce"] != nonce || Convert.ToInt32(result["session"]) != child)
                                throw new InvalidOperationException("The fixture result does not belong to this session.");
                            report["inputTested"] = true;
                            foreach (string key in new[] { "keyboard", "click", "wheel", "resize", "screenshot", "passed" })
                                if (!result.ContainsKey(key) || !Convert.ToBoolean(result[key]))
                                    throw new InvalidOperationException("The worker input check failed: " + key);
                            if (Convert.ToInt32(result["displayWidth"]) != 960 || Convert.ToInt32(result["displayHeight"]) != 720)
                                throw new InvalidOperationException("The remote display did not reach its requested dimensions.");
                            if (!resized) throw new InvalidOperationException("The remote display resize was not tested.");
                            finished = true;
                        }
                    }
                    catch (Exception error)
                    {
                        report["error"] = error.ToString();
                        timer.Stop();
                        context.ExitThread();
                    }
                };
                timer.Start();
                Application.Run(context);
            }
        }
        catch (Exception error) { report["error"] = error.ToString(); }
        finally
        {
            var errors = new List<string>();
            Cleanup(delegate { Write("release.json", new { stop = true }); }, errors);
            Cleanup(delegate { if (rdp != null) rdp.Dispose(); }, errors);
            Cleanup(delegate { if (canary != null) canary.Dispose(); }, errors);
            Cleanup(delegate {
                if (child >= 0 && SessionPlatform.Child() == child) SessionPlatform.LogOffOwned(child);
            }, errors);
            Cleanup(delegate { if (changed) SessionPlatform.SetEnabled(false); }, errors);
            report["cleanupCompleted"] = errors.Count == 0;
            if (errors.Count != 0) { report["cleanupError"] = errors; report["passed"] = false; }
            Write("parent-result.json", report);
        }
        return (bool)report["passed"] ? 0 : 1;
    }

    private static void Cleanup(Action action, List<string> errors)
    {
        try { action(); }
        catch (Exception error) { errors.Add(error.ToString()); }
    }

    private static Dictionary<string, object> Read(string name)
    {
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Output, name)));
    }

    private static void Write(string name, object value)
    {
        string path = Path.Combine(Output, name);
        string temporary = path + ".partial";
        File.WriteAllText(temporary, Json.Serialize(value));
        File.Move(temporary, path);
    }
}
