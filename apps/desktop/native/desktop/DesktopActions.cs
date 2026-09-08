using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Windows;

internal sealed class DesktopActions
{
    private readonly ControlLease Lease;
    private readonly InputMonitor Monitor;
    private readonly AutomationSession Automation;
    private readonly InputDispatcher Input;

    internal DesktopActions(ControlLease lease, InputMonitor monitor, AutomationSession automation)
    {
        Lease = lease; Monitor = monitor; Automation = automation;
        Input = new InputDispatcher(lease, monitor.Packets, InputDispatcher.NativeDispatch);
    }
    private void Prepare(LeaseState state, string snapshot)
    {
        Lease.Require(state);
        Automation.Require(snapshot, state);
        DesktopNative.IdleKeys();
        Monitor.BeforeInput(state);
        Lease.Require(state);
    }
    private void Move(LeaseState state, string snapshot, Point point)
    {
        var left = DesktopNative.GetSystemMetrics(76);
        var top = DesktopNative.GetSystemMetrics(77);
        var width = DesktopNative.GetSystemMetrics(78);
        var height = DesktopNative.GetSystemMetrics(79);
        if (width < 2 || height < 2) throw new InvalidOperationException("Desktop coordinate bounds are unavailable");
        var x = (int)Math.Round((point.X - left) * 65535.0 / (width - 1));
        var y = (int)Math.Round((point.Y - top) * 65535.0 / (height - 1));
        if (x < 0 || y < 0 || x > 65535 || y > 65535) throw new InvalidOperationException("Input position is outside the desktop");
        Input.Send(state, new[] { InputDispatcher.Mouse(x, y, 0, 0xc001) }, delegate
        {
            Prepare(state, snapshot);
            Automation.ClickPoint(Automation.Require(snapshot, state), null, (int)point.X, (int)point.Y);
        });
    }
    internal void Click(LeaseState state, string snapshot, string element, int? x, int? y)
    {
        var observation = Automation.Require(snapshot, state);
        var point = Automation.ClickPoint(observation, element, x, y);
        Move(state, snapshot, point);
        Input.Send(state, new[] { InputDispatcher.Mouse(0, 0, 0, 2), InputDispatcher.Mouse(0, 0, 0, 4) }, delegate
        {
            Prepare(state, snapshot);
            var fresh = Automation.ClickPoint(observation, element, x, y);
            if (fresh != point) throw new InvalidOperationException("The control moved before input. Observe the application again");
        });
    }
    internal void Type(LeaseState state, string snapshot, string text)
    {
        ControlPolicy.Literal(text);
        var watch = Stopwatch.StartNew();
        for (var index = 0; index < text.Length; )
        {
            if (watch.ElapsedMilliseconds > 14000) throw new InvalidOperationException("Typing reached its time limit; inspect the field before continuing");
            var inputs = new List<DesktopNative.Input>();
            while (index < text.Length)
            {
                var character = text[index];
                var count = char.IsHighSurrogate(character) ? 4 : 2;
                if (inputs.Count + count > 8) break;
                index++;
                inputs.Add(InputDispatcher.Key(0, character, 4));
                inputs.Add(InputDispatcher.Key(0, character, 6));
                if (char.IsHighSurrogate(character))
                {
                    character = text[index++];
                    inputs.Add(InputDispatcher.Key(0, character, 4));
                    inputs.Add(InputDispatcher.Key(0, character, 6));
                }
            }
            Input.Send(state, inputs.ToArray(), delegate { Prepare(state, snapshot); Automation.RequireEditable(Automation.Require(snapshot, state)); });
        }
    }
    internal void Scroll(LeaseState state, string snapshot, int delta)
    {
        if (delta == 0 || delta < -10 || delta > 10) throw new ArgumentException("Scroll delta must be a nonzero integer from -10 to 10");
        var observation = Automation.Require(snapshot, state);
        var point = new Point(Math.Floor(observation.Bounds.X + observation.Bounds.Width / 2),
            Math.Floor(observation.Bounds.Y + observation.Bounds.Height / 2));
        Move(state, snapshot, point);
        for (var tick = 0; tick < Math.Abs(delta); tick++)
            Input.Send(state, new[] { InputDispatcher.Mouse(0, 0, unchecked((uint)(Math.Sign(delta) * 120)), 0x800) },
                delegate { Prepare(state, snapshot); Automation.ClickPoint(observation, null, (int)point.X, (int)point.Y); });
    }
    internal void Key(LeaseState state, string snapshot, string key)
    {
        if (key == "Escape") { Lease.Revoke("Escape requested"); return; }
        var keys = ControlPolicy.Chord(key);
        var inputs = new List<DesktopNative.Input>();
        foreach (var code in keys) inputs.Add(InputDispatcher.Key(code, 0, code >= 33 && code <= 46 ? 1U : 0U));
        for (var index = keys.Length - 1; index >= 0; index--)
            inputs.Add(InputDispatcher.Key(keys[index], 0, keys[index] >= 33 && keys[index] <= 46 ? 3U : 2U));
        Input.Send(state, inputs.ToArray(), delegate { Prepare(state, snapshot); Automation.RequireFocus(Automation.Require(snapshot, state)); });
    }
}
