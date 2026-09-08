using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

internal sealed class InputDispatcher
{
    private readonly ControlLease Lease;
    private readonly PacketGate Packets;
    private readonly Func<DesktopNative.Input[], uint> Dispatch;

    internal InputDispatcher(ControlLease lease, PacketGate packets, Func<DesktopNative.Input[], uint> dispatch)
    { Lease = lease; Packets = packets; Dispatch = dispatch; }

    internal void Send(LeaseState state, DesktopNative.Input[] inputs, Action validate)
    {
        if (inputs.Length == 0 || inputs.Length > 8) throw new ArgumentException("Input batches must be small and complete");
        Lease.Require(state);
        validate();
        Lease.Require(state);
        var packet = Packets.Begin(state);
        for (var index = 0; index < inputs.Length; index++)
        {
            if (inputs[index].Type == 1) inputs[index].Value.Key.Extra = new UIntPtr(packet.Marker);
            else inputs[index].Value.Mouse.Extra = new UIntPtr(packet.Marker);
        }
        try
        {
            Lease.Require(state);
            if (Dispatch(inputs) != inputs.Length) throw new InvalidOperationException("Desktop input was not fully accepted");
            var watch = Stopwatch.StartNew();
            while (Volatile.Read(ref packet.Seen) < inputs.Length && watch.ElapsedMilliseconds < 500) Thread.Sleep(1);
            if (Volatile.Read(ref packet.Seen) < inputs.Length) throw new InvalidOperationException("Desktop input hook acknowledgement is missing");
            Lease.Require(state);
        }
        catch { Lease.Revoke("Desktop input was interrupted or could not be verified"); throw; }
        finally
        {
            bool held;
            lock (packet.Held) held = packet.Held.Count > 0;
            if (held)
            {
                var releases = new List<DesktopNative.Input>();
                for (var index = inputs.Length - 1; index >= 0; index--)
                {
                    var input = inputs[index];
                    if (input.Type == 1 && (input.Value.Key.Flags & 2) == 0)
                    { input.Value.Key.Flags |= 2; releases.Add(input); }
                    else if (input.Type == 0 && (input.Value.Mouse.Flags & 2) != 0)
                    { input.Value.Mouse.Flags = 4; releases.Add(input); }
                }
                if (releases.Count > 0) Dispatch(releases.ToArray());
                var releaseWatch = Stopwatch.StartNew();
                do
                {
                    lock (packet.Held) held = packet.Held.Count > 0;
                    if (held) Thread.Sleep(1);
                } while (held && releaseWatch.ElapsedMilliseconds < 500);
            }
            Packets.End(packet);
        }
    }

    internal static DesktopNative.Input Key(ushort key, ushort scan, uint flags)
    { return new DesktopNative.Input { Type = 1, Value = new DesktopNative.InputUnion { Key = new DesktopNative.KeyInput { Key = key, Scan = scan, Flags = flags } } }; }
    internal static DesktopNative.Input Mouse(int x, int y, uint data, uint flags)
    { return new DesktopNative.Input { Type = 0, Value = new DesktopNative.InputUnion { Mouse = new DesktopNative.MouseInput { X = x, Y = y, Data = data, Flags = flags } } }; }
    internal static uint NativeDispatch(DesktopNative.Input[] inputs)
    { return DesktopNative.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(DesktopNative.Input))); }
}
