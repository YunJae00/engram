using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Web.Script.Serialization;

internal static class DesktopProfile
{
    private static readonly bool Enabled = Environment.GetEnvironmentVariable("CI") == "true"
        && Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true";
    [ThreadStatic] private static Dictionary<string, Sample> Samples;
    [ThreadStatic] private static long Started;
    private sealed class Sample { public int count; public double elapsedMs; }
    private sealed class Measurement : IDisposable
    {
        private readonly string Name;
        private readonly long Start = Stopwatch.GetTimestamp();
        internal Measurement(string name) { Name = name; }
        public void Dispose() { Record(Name, Start); }
    }
    internal static void Begin()
    {
        if (!Enabled) return;
        Samples = new Dictionary<string, Sample>();
        Started = Stopwatch.GetTimestamp();
    }
    internal static IDisposable Measure(string name) { return Samples == null ? null : new Measurement(name); }
    internal static long Start() { return Samples == null ? 0 : Stopwatch.GetTimestamp(); }
    internal static void Record(string name, long start)
    {
        if (Samples == null) return;
        Sample sample;
        if (!Samples.TryGetValue(name, out sample)) { sample = new Sample(); Samples.Add(name, sample); }
        sample.count++;
        sample.elapsedMs += (Stopwatch.GetTimestamp() - start) * 1000.0 / Stopwatch.Frequency;
    }
    internal static void End(int id, string method)
    {
        if (Samples == null) return;
        try
        {
            Console.Error.WriteLine("DESKTOP_PROFILE " + new JavaScriptSerializer().Serialize(new {
                id = id, method = method, elapsedMs = (Stopwatch.GetTimestamp() - Started) * 1000.0 / Stopwatch.Frequency,
                measurements = Samples
            }));
        }
        finally { Samples = null; }
    }
}
