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
    private readonly HashSet<ulong> Issued = new HashSet<ulong>();

    internal PacketGate(ControlLease lease, Func<DesktopTarget, bool> targetCurrent)
    {
        Lease = lease;
        TargetCurrent = targetCurrent;
    }
    internal InputPacket Begin(LeaseState state)
    {
        Lease.Require(state);
        if (Pending.Count >= 16) throw new InvalidOperationException("Input packet capacity reached");
        ulong marker;
        lock (Issued)
        {
            if (Issued.Count >= 65536) throw new InvalidOperationException("Reconnect computer access before sending more input");
            var bytes = new byte[4];
            using (var random = RandomNumberGenerator.Create())
            {
                do { random.GetBytes(bytes); marker = BitConverter.ToUInt32(bytes, 0); }
                while (marker == 0 || Issued.Contains(marker));
            }
            Issued.Add(marker);
        }
        // Mouse input may preserve only 32 bits of extra information. Each
        // packet still requires an exact, private, never-reused random marker.
        var packet = new InputPacket { Lease = state, Marker = marker };
        if (!Pending.TryAdd(packet.Marker, packet)) throw new InvalidOperationException("Input packet collision");
        return packet;
    }
    internal bool Own(ulong marker) { lock (Issued) return Issued.Contains(marker); }
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
