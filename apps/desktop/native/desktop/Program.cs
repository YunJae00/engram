using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class Program
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144, RecursionLimit = 16 };
    private static readonly object OutputLock = new object();

    internal static string Text(Dictionary<string, object> request, string key, int limit)
    {
        object raw;
        if (!request.TryGetValue(key, out raw) || !(raw is string)) throw new ArgumentException("Missing or invalid " + key);
        var value = (string)raw;
        if (value.Length > limit || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid " + key + " length or content");
        return value;
    }

    private static int Number(Dictionary<string, object> request, string key, bool allowZero = false)
    {
        object raw;
        if (!request.TryGetValue(key, out raw) || !(raw is int) || (int)raw < (allowZero ? 0 : 1)) throw new ArgumentException("Missing or invalid " + key);
        return (int)raw;
    }

    private static void Send(object response)
    {
        lock (OutputLock)
        {
            Console.WriteLine(Json.Serialize(response));
            Console.Out.Flush();
        }
    }

    private static void Receive(string line, AutomationSession automation, WindowGuard guard)
    {
        var id = 0;
        try
        {
            var reader = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 };
            var request = reader.Deserialize<Dictionary<string, object>>(line);
            id = Number(request, "id");
            var method = Text(request, "method", 32);
            if (method != "inspectWindow" && method != "observe") throw new ArgumentException("Unsupported desktop method: this connection is read-only");
            var window = Text(request, "window", 32);
            var pid = Number(request, "pid", method == "inspectWindow");
            var target = guard.Resolve(window, pid);
            object result;
            if (method == "inspectWindow") result = new { window = target.Id, pid = target.Pid, title = target.Title, minimized = target.Minimized };
            else if (method == "observe") result = automation.Observe(target);
            else throw new ArgumentException("Unsupported desktop method");
            Send(new { id = id, result = result });
        }
        catch (Exception error)
        {
            var message = error is System.Windows.Automation.ElementNotAvailableException
                ? "The window or control is no longer available. Observe the window again."
                : error.Message;
            Send(new { id = id, error = message.Length > 500 ? message.Substring(0, 500) : message });
        }
    }

    [MTAThread]
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        int owner;
        if (args.Length != 2 || args[0] != "--owner-pid" || !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out owner) || owner <= 0)
        {
            Send(new { type = "fatal", error = "A valid --owner-pid is required" });
            return 2;
        }
        try
        {
            var guard = new WindowGuard(owner);
            var automation = new AutomationSession(guard);
            using (var requests = new BlockingCollection<string>(32))
            {
                var worker = new Thread(delegate()
                {
                    foreach (var line in requests.GetConsumingEnumerable()) Receive(line, automation, guard);
                });
                worker.IsBackground = true;
                worker.SetApartmentState(ApartmentState.MTA);
                worker.Start();
                Send(new { type = "ready", protocol = 1 });
                string input;
                while ((input = Console.ReadLine()) != null)
                {
                    if (input.Length > 65536) { Send(new { id = 0, error = "Desktop request exceeds 65536 characters" }); continue; }
                    if (!requests.TryAdd(input)) Send(new { id = 0, error = "Desktop request queue is full" });
                }
                requests.CompleteAdding();
                worker.Join(1000);
            }
            return 0;
        }
        catch (Exception error)
        {
            Send(new { type = "fatal", error = error.Message });
            return 2;
        }
    }
}
