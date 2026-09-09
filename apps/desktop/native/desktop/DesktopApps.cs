using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static class DesktopApps
{
    private static object Call(object item, string member, bool property, params object[] args)
    { return item.GetType().InvokeMember(member, property ? BindingFlags.GetProperty : BindingFlags.InvokeMethod, null, item, args); }
    private static string Property(object item, string name)
    { return Convert.ToString(Call(item, "ExtendedProperty", false, name)); }
    private static void Release(object item)
    { if (item != null && Marshal.IsComObject(item)) Marshal.FinalReleaseComObject(item); }
    internal static string Id(string identity)
    {
        using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").ToLowerInvariant();
    }
    internal static bool Allowed(string name, string identity, string target)
    {
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(identity)) return false;
        if (ControlPolicy.IsSensitive(name) || ControlPolicy.IsSensitive(identity) || ControlPolicy.IsSensitive(target)) return false;
        foreach (var part in Regex.Split(identity + " " + target, @"[\\/ .!_:\-]+"))
            if (WindowGuard.ProtectedApplication(part)) return false;
        return Regex.IsMatch(identity, @"^[A-Za-z0-9.\-_]+![A-Za-z0-9.\-_]+$")
            || (!string.IsNullOrEmpty(target) && Path.IsPathRooted(target) && string.Equals(Path.GetExtension(target), ".exe", StringComparison.OrdinalIgnoreCase));
    }
    private static object Visit(string wanted, Func<bool> permitted)
    {
        if (wanted != null && !Regex.IsMatch(wanted, "^[a-f0-9]{64}$")) throw new ArgumentException("Use an exact ID from list_apps. Paths and commands are not accepted.");
        object shell = null, folder = null, items = null;
        try
        {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
            folder = Call(shell, "NameSpace", false, "shell:AppsFolder");
            if (folder == null) throw new InvalidOperationException("Windows application catalog is unavailable.");
            items = Call(folder, "Items", false);
            var count = Convert.ToInt32(Call(items, "Count", true));
            if (count > 4096) throw new InvalidOperationException("Windows application catalog exceeds the supported size.");
            var result = new List<object>();
            for (var index = 0; index < count; index++)
            {
                if (!permitted()) throw new InvalidOperationException("The app request was cancelled.");
                object item = null;
                try
                {
                    item = Call(items, "Item", false, index);
                    var name = Convert.ToString(Call(item, "Name", true));
                    var identity = Property(item, "System.AppUserModel.ID");
                    var target = Property(item, "System.Link.TargetParsingPath");
                    var path = Convert.ToString(Call(item, "Path", true));
                    if (string.IsNullOrEmpty(identity)) identity = path;
                    if (!Allowed(name, identity, target)) continue;
                    var id = Id(identity + "\n" + target + "\n" + path);
                    if (wanted == null) result.Add(new { id = id, name = name });
                    else if (wanted == id)
                    {
                        if (!permitted()) throw new InvalidOperationException("The app launch was cancelled.");
                        Call(item, "InvokeVerb", false, "open");
                        return new { requested = true, name = name, requiresObservation = true };
                    }
                }
                finally { Release(item); }
            }
            if (wanted != null) throw new InvalidOperationException("This app is no longer available. Refresh list_apps before choosing again.");
            return result;
        }
        finally { Release(items); Release(folder); Release(shell); }
    }
    internal static object List() { return Visit(null, delegate { return true; }); }
    internal static object Open(string id, Func<bool> permitted) { return Visit(id, permitted); }
}
