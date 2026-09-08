using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;

internal sealed class InputPacket
{
    internal LeaseState Lease;
    internal ulong Marker;
    internal int Seen;
    internal readonly HashSet<uint> Held = new HashSet<uint>();
}

internal sealed class PacketGate
{
    private readonly ConcurrentDictionary<ulong, InputPacket> Pending = new ConcurrentDictionary<ulong, InputPacket>();
    private readonly ControlLease Lease;
    private readonly Func<DesktopTarget, bool> TargetCurrent;
    private readonly ulong Prefix;
    private int Sequence;

    internal PacketGate(ControlLease lease, Func<DesktopTarget, bool> targetCurrent)
    {
        Lease = lease;
        TargetCurrent = targetCurrent;
        var bytes = new byte[4];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
        Prefix = ((ulong)(BitConverter.ToUInt32(bytes, 0) | 0x80000000U)) << 32;
    }
    internal InputPacket Begin(LeaseState state)
    {
        Lease.Require(state);
        var sequence = Interlocked.Increment(ref Sequence);
        if (sequence <= 0 || Pending.Count >= 16) throw new InvalidOperationException("Input packet capacity reached");
        var packet = new InputPacket { Lease = state, Marker = Prefix | (uint)sequence };
        if (!Pending.TryAdd(packet.Marker, packet)) throw new InvalidOperationException("Input packet collision");
        return packet;
    }
    internal bool Own(ulong marker) { return (marker & 0xffffffff00000000UL) == Prefix; }
    internal string MarkerState(ulong marker)
    {
        var lowMatch = false;
        foreach (var item in Pending.Keys) if ((uint)item == (uint)marker) lowMatch = true;
        return "zero=" + (marker == 0) + ", upperZero=" + ((marker >> 32) == 0) + ", pendingLow=" + lowMatch;
    }
    internal bool Admit(ulong marker, uint identity, bool release, bool tracked)
    {
        InputPacket packet;
        if (!Pending.TryGetValue(marker, out packet)) return false;
        try
        {
            lock (packet.Held)
            {
                if (release) return packet.Held.Remove(identity);
                if (!Lease.Valid(packet.Lease) || !TargetCurrent(packet.Lease.Target)) return false;
                if (tracked) packet.Held.Add(identity);
                return true;
            }
        }
        finally { Interlocked.Increment(ref packet.Seen); }
    }
    internal void End(InputPacket packet)
    {
        lock (packet.Held)
        {
            if (packet.Held.Count != 0) throw new InvalidOperationException("Synthetic input release was not confirmed");
        }
        InputPacket removed;
        Pending.TryRemove(packet.Marker, out removed);
    }
}
