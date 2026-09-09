using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

internal static class DesktopApps
{
    // Resolve only fixed OS launchers; model input is never a path or command.
    private static readonly Dictionary<string, string[]> Apps = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        { "calculator", new[] { "Calculator", "calc.exe" } },
        { "notepad", new[] { "Notepad", "notepad.exe" } },
        { "paint", new[] { "Paint", "mspaint.exe" } }
    };

    internal static string Launcher(string id)
    {
        string[] app;
        if (!Apps.TryGetValue(id, out app)) throw new ArgumentException("Choose an app ID returned by list_apps. Paths and commands are not accepted.");
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), app[1]);
    }

    internal static object List()
    {
        var result = new List<object>();
        foreach (var app in Apps)
            if (File.Exists(Launcher(app.Key))) result.Add(new { id = app.Key, name = app.Value[0] });
        return result;
    }

    internal static object Open(string id, Func<bool> permitted)
    {
        var path = Launcher(id);
        if (!File.Exists(path)) throw new InvalidOperationException("This app's Windows launcher is unavailable.");
        if (!permitted()) throw new InvalidOperationException("The app launch was cancelled.");
        using (var process = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }))
        {
            if (process == null) throw new InvalidOperationException("Windows did not accept the app launch.");
            return new { requested = true, app = id, requiresObservation = true };
        }
    }
}
