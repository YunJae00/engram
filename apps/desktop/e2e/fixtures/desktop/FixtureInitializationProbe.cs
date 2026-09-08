using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Xml;

internal static class FixtureInitializationProbe
{
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);
    [DllImport("advapi32.dll")] private static extern bool IsValidSid(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr value, int length, out int needed);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr handle);

    private static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\""; }
    private static string Bool(bool value) { return value ? "true" : "false"; }
    private static string Label(IntPtr handle, int type)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        var error = GetSecurityInfo(handle, type, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) return "{\"readError\":" + error + "}";
        try
        {
            bool present, defaulted;
            IntPtr acl;
            if (!GetSecurityDescriptorSacl(descriptor, out present, out acl, out defaulted)) return "{\"readError\":" + Marshal.GetLastWin32Error() + "}";
            var labels = new List<string>();
            if (present && acl != IntPtr.Zero)
            {
                var count = (ushort)Marshal.ReadInt16(acl, 4);
                if (count > 1024) throw new InvalidOperationException("Mandatory label count is invalid");
                for (uint index = 0; index < count; index++)
                {
                    IntPtr ace;
                    if (!GetAce(acl, index, out ace)) throw new InvalidOperationException("Mandatory label entry is unavailable");
                    if (Marshal.ReadByte(ace) != 17) continue;
                    var size = (ushort)Marshal.ReadInt16(ace, 2);
                    var sid = IntPtr.Add(ace, 8);
                    if (size < 20 || !IsValidSid(sid) || GetLengthSid(sid) > size - 8) throw new InvalidOperationException("Mandatory label entry is invalid");
                    var name = new SecurityIdentifier(sid).Value;
                    var level = 0;
                    if (!name.StartsWith("S-1-16-", StringComparison.Ordinal) || !int.TryParse(name.Substring(7), out level)) throw new InvalidOperationException("Mandatory integrity level is invalid");
                    var policy = unchecked((uint)Marshal.ReadInt32(ace, 4));
                    labels.Add("{\"integrity\":" + level + ",\"policyMask\":" + policy + ",\"noWriteUp\":" + Bool((policy & 1) != 0) + ",\"noReadUp\":" + Bool((policy & 2) != 0) + ",\"noExecuteUp\":" + Bool((policy & 4) != 0) + "}");
                }
            }
            return "{\"readSucceeded\":true,\"explicitLabels\":[" + string.Join(",", labels.ToArray()) + "],\"unlabeledMediumDefault\":" + Bool(labels.Count == 0) + "}";
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    private static string TokenPolicy(IntPtr token)
    {
        var buffer = Marshal.AllocHGlobal(4);
        try
        {
            int needed;
            if (!GetTokenInformation(token, 27, buffer, 4, out needed)) return "{\"readError\":" + Marshal.GetLastWin32Error() + "}";
            return "{\"policyMask\":" + unchecked((uint)Marshal.ReadInt32(buffer)) + "}";
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static void MandatoryLabels(IntPtr process, IntPtr thread, IntPtr current, IntPtr restricted, string logs)
    {
        var result = "{\"securityInformation\":\"LABEL_SECURITY_INFORMATION\",\"currentToken\":" + TokenPolicy(current) + ",\"restrictedToken\":" + TokenPolicy(restricted) + ",\"windowStation\":" + Label(GetProcessWindowStation(), 7) + ",\"desktop\":" + Label(GetThreadDesktop(GetCurrentThreadId()), 7) + ",\"ownedProcess\":" + Label(process, 6) + ",\"ownedThread\":" + Label(thread, 6) + "}\n";
        File.WriteAllText(Path.Combine(logs, "mandatory-access.json"), result, new UTF8Encoding(false));
    }
    private static Dictionary<string, string> EventData(string xml)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 65536 };
        var document = new XmlDocument { XmlResolver = null };
        using (var reader = XmlReader.Create(new StringReader(xml), settings)) document.Load(reader);
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (XmlNode entry in document.SelectNodes("//*[local-name()='EventData']/*[local-name()='Data']"))
        {
            var name = entry.Attributes["Name"];
            if (name != null && entry.InnerText.Length <= 1024) values[name.Value] = entry.InnerText;
        }
        return values;
    }
    private static bool MatchesPid(string text, uint pid)
    {
        uint value;
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return uint.TryParse(text.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value) && value == pid;
        return uint.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) && value == pid;
    }
    private static string SafeField(Dictionary<string, string> values, string key)
    {
        string value;
        if (!values.TryGetValue(key, out value)) return "null";
        value = Path.GetFileName(value);
        return Quote(value.Length <= 160 ? value : value.Substring(0, 160));
    }
    internal static void OwnedEvents(uint pid, string executable, DateTime started, string logs)
    {
        var matches = new List<string>();
        string failure = null;
        var scanned = 0;
        var timer = Stopwatch.StartNew();
        try
        {
            var query = new EventLogQuery("Application", PathType.LogName, "*[System[(EventID=1000 or EventID=1001 or EventID=1026) and TimeCreated[timediff(@SystemTime) <= 120000]]]") { ReverseDirection = true };
            using (var reader = new EventLogReader(query))
            {
                while (scanned < 64 && matches.Count < 8 && timer.ElapsedMilliseconds < 2000)
                {
                    using (var record = reader.ReadEvent(TimeSpan.FromMilliseconds(150)))
                    {
                        if (record == null) break;
                        scanned++;
                        if (!record.TimeCreated.HasValue || record.TimeCreated.Value.ToUniversalTime() < started.AddSeconds(-2)) continue;
                        var data = EventData(record.ToXml());
                        string eventPid, app;
                        if (!data.TryGetValue("ProcessId", out eventPid) || !MatchesPid(eventPid, pid) || !data.TryGetValue("AppName", out app) || !string.Equals(Path.GetFileName(app), Path.GetFileName(executable), StringComparison.OrdinalIgnoreCase)) continue;
                        matches.Add("{\"id\":" + record.Id + ",\"pid\":" + pid + ",\"application\":" + SafeField(data, "AppName") + ",\"module\":" + SafeField(data, "ModuleName") + ",\"exceptionCode\":" + SafeField(data, "ExceptionCode") + "}");
                    }
                }
            }
        }
        catch (Exception error) { failure = error.GetType().Name + " (0x" + error.HResult.ToString("X8") + ")"; }
        var result = "{\"scope\":\"owned child PID and application only\",\"scanned\":" + scanned + ",\"events\":[" + string.Join(",", matches.ToArray()) + "],\"queryError\":" + (failure == null ? "null" : Quote(failure)) + "}\n";
        File.WriteAllText(Path.Combine(logs, "child-events.json"), result, new UTF8Encoding(false));
    }
}
