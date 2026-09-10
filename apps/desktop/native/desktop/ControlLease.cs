using System;
using System.Collections.Generic;
using System.Threading;

internal sealed class LeaseState
{
    internal string Id;
    internal long Epoch;
    internal DesktopTarget Target;
    internal long Expires;
    internal int Revoked;
}

internal sealed class ControlLease
{
    private readonly object Sync = new object();
    private readonly HashSet<string> Grants = new HashSet<string>(StringComparer.Ordinal);
    private readonly Action<LeaseState, string> Changed;
    private LeaseState Current;
    private long Epoch;

    internal ControlLease(Action<LeaseState, string> changed) { Changed = changed; }
    internal LeaseState State { get { return Volatile.Read(ref Current); } }

    internal LeaseState Bind(DesktopTarget target, string grant, Func<bool> permitted = null)
    {
        Guid parsed;
        if (!Guid.TryParse(grant, out parsed)) throw new ArgumentException("A fresh user approval grant is required");
        lock (Sync)
        {
            if (permitted != null && !permitted()) throw new InvalidOperationException("Desktop approval was cancelled before control started");
            if (Current != null && Volatile.Read(ref Current.Revoked) == 0)
                throw new InvalidOperationException("Stop the current desktop control session first");
            if (Grants.Count >= 128 || !Grants.Add(parsed.ToString("N")))
                throw new InvalidOperationException("This approval cannot be reused; request new user approval");
            var value = new LeaseState { Id = Guid.NewGuid().ToString("N"), Epoch = Interlocked.Increment(ref Epoch),
                Target = target, Expires = Environment.TickCount + 600000L };
            Volatile.Write(ref Current, value);
            if (permitted != null && !permitted())
            { Revoke("Desktop approval was cancelled before control started"); throw new InvalidOperationException("Desktop approval was cancelled before control started"); }
            return value;
        }
    }

    internal bool Valid(LeaseState state)
    {
        return state != null && ReferenceEquals(State, state) && Volatile.Read(ref state.Revoked) == 0
            && unchecked((int)((uint)state.Expires - (uint)Environment.TickCount)) > 0;
    }

    internal LeaseState Require(string id)
    {
        var value = State;
        if (!Valid(value)) { Revoke(value, "Control expired or was stopped"); throw new InvalidOperationException("Desktop control requires new user approval"); }
        if (!string.Equals(value.Id, id, StringComparison.Ordinal)) throw new InvalidOperationException("Desktop control lease does not match");
        return value;
    }

    internal void Require(LeaseState state)
    {
        if (!Valid(state)) throw new InvalidOperationException("Desktop control was interrupted; no further input was sent");
    }

    internal void Revoke(string reason) { lock (Sync) Revoke(State, reason); }

    internal void Revoke(LeaseState expected, string reason)
    {
        LeaseState value;
        lock (Sync)
        {
            value = State;
            if (expected == null || !ReferenceEquals(value, expected)
                || Interlocked.Exchange(ref value.Revoked, 1) != 0) return;
            Interlocked.Increment(ref Epoch);
        }
        Changed(value, reason);
    }
}
