using System;
using System.Collections.Generic;
using System.IO;

internal sealed class RemoteScanProgram
{
    internal enum Operand
    {
        Root = 1, PasswordId, OffscreenId, False, True, FirstChild, NextSibling, PidId, ExpectedPid,
        Cursor, Stack, Depth, Nodes, Found, Complete, Reason, Test, Password, Offscreen,
        Size, One, Zero, NodeCap, DepthCap, Budget, Cost, ActualPid, MaxDepth, Child
    }

    internal const int NodeLimit = 1024, DepthLimit = 64;
    internal static readonly uint[] Opcodes = {
        0x01, 0x02, 0x03, 0x04, 0x05, 0x0e, 0x0f, 0x19, 0x18,
        0x1c, 0x1d, 0x1e, 0x1f, 0x25, 0x2a, 0x2c, 0x2e, 0x38, 0x39, 0x3a, 0x3d, 0x3e
    };
    private readonly List<int[]> Instructions = new List<int[]>();
    private int Emit(params int[] words) { Instructions.Add(words); return Instructions.Count - 1; }
    private void Target(int instruction, int target)
    { var words = Instructions[instruction]; words[words.Length - 1] = target - instruction; }
    private static int Id(Operand operand) { return (int)operand; }

    private void Fail(int reason, params int[] branches)
    {
        foreach (var branch in branches) Target(branch, Instructions.Count);
        Emit(0x1e, Id(Operand.Reason), reason); Emit(0x05);
    }

    internal static byte[] Build(int pid)
    {
        if (pid <= 0) throw new ArgumentOutOfRangeException("pid");
        var code = new RemoteScanProgram();
        code.Generate(pid);
        using (var output = new MemoryStream())
        using (var writer = new BinaryWriter(output))
        {
            writer.Write(0);
            foreach (var instruction in code.Instructions)
                for (var index = 0; index < instruction.Length; index++)
                    if (instruction[0] == 0x1f && index == 2) writer.Write((byte)instruction[index]);
                    else writer.Write(instruction[index]);
            return output.ToArray();
        }
    }

    private void Generate(int pid)
    {
        Emit(0x1d, Id(Operand.PasswordId), 30019);
        Emit(0x1d, Id(Operand.OffscreenId), 30022);
        Emit(0x1d, Id(Operand.PidId), 30002);
        Emit(0x1d, Id(Operand.ExpectedPid), pid);
        Emit(0x1d, Id(Operand.FirstChild), 3); Emit(0x1d, Id(Operand.NextSibling), 1);
        Emit(0x1f, Id(Operand.False), 0); Emit(0x1f, Id(Operand.True), 1);
        Emit(0x1e, Id(Operand.One), 1); Emit(0x1e, Id(Operand.Zero), 0);
        Emit(0x1e, Id(Operand.Depth), 1); Emit(0x1e, Id(Operand.Nodes), 0);
        Emit(0x1e, Id(Operand.MaxDepth), 0); Emit(0x1e, Id(Operand.Reason), 0);
        Emit(0x1e, Id(Operand.NodeCap), NodeLimit); Emit(0x1e, Id(Operand.DepthCap), DepthLimit);
        Emit(0x1e, Id(Operand.Budget), 131072 - 128);
        var cost = Emit(0x1e, Id(Operand.Cost), 0);
        Emit(0x1f, Id(Operand.Found), 0); Emit(0x1f, Id(Operand.Complete), 0);
        Emit(0x25, Id(Operand.Stack));
        Emit(0x39, Id(Operand.Cursor), Id(Operand.Root), Id(Operand.FirstChild));
        Emit(0x3a, Id(Operand.Test), Id(Operand.Cursor));
        var empty = Emit(0x02, Id(Operand.Test), 0);
        var loop = Instructions.Count;
        Emit(0x1c, Id(Operand.Test), Id(Operand.Budget), Id(Operand.Cost), 3);
        var budgetFailure = Emit(0x02, Id(Operand.Test), 0);
        Emit(0x0f, Id(Operand.Budget), Id(Operand.Cost));
        Emit(0x1c, Id(Operand.Test), Id(Operand.Nodes), Id(Operand.NodeCap), 4);
        var nodeFailure = Emit(0x02, Id(Operand.Test), 0);
        Emit(0x1c, Id(Operand.Test), Id(Operand.Depth), Id(Operand.DepthCap), 2);
        var depthFailure = Emit(0x02, Id(Operand.Test), 0);
        Emit(0x38, Id(Operand.ActualPid), Id(Operand.Cursor), Id(Operand.PidId), Id(Operand.False));
        Emit(0x3e, Id(Operand.Test), Id(Operand.ActualPid));
        var pidTypeFailure = Emit(0x03, Id(Operand.Test), 0);
        Emit(0x1c, Id(Operand.Test), Id(Operand.ActualPid), Id(Operand.ExpectedPid), 0);
        var pidFailure = Emit(0x03, Id(Operand.Test), 0);
        Emit(0x38, Id(Operand.Password), Id(Operand.Cursor), Id(Operand.PasswordId), Id(Operand.False));
        Emit(0x3d, Id(Operand.Test), Id(Operand.Password));
        var passwordTypeFailure = Emit(0x03, Id(Operand.Test), 0);
        var notPassword = Emit(0x03, Id(Operand.Password), 0);
        Emit(0x38, Id(Operand.Offscreen), Id(Operand.Cursor), Id(Operand.OffscreenId), Id(Operand.False));
        Emit(0x3d, Id(Operand.Test), Id(Operand.Offscreen));
        var offscreenTypeFailure = Emit(0x03, Id(Operand.Test), 0);
        Emit(0x19, Id(Operand.Test), Id(Operand.Offscreen));
        Emit(0x18, Id(Operand.Found), Id(Operand.Test));
        Target(notPassword, Instructions.Count);
        Emit(0x0e, Id(Operand.Nodes), Id(Operand.One));
        Emit(0x1c, Id(Operand.Test), Id(Operand.Depth), Id(Operand.MaxDepth), 2);
        var depthUnchanged = Emit(0x03, Id(Operand.Test), 0);
        Emit(0x01, Id(Operand.MaxDepth), Id(Operand.Depth));
        Target(depthUnchanged, Instructions.Count);
        Emit(0x39, Id(Operand.Child), Id(Operand.Cursor), Id(Operand.FirstChild));
        Emit(0x3a, Id(Operand.Test), Id(Operand.Child));
        var leaf = Emit(0x02, Id(Operand.Test), 0);
        // Only real ancestors are pushed. The imported root's siblings are outside the scan.
        Emit(0x2a, Id(Operand.Stack), Id(Operand.Cursor));
        Emit(0x0e, Id(Operand.Depth), Id(Operand.One));
        Emit(0x01, Id(Operand.Cursor), Id(Operand.Child));
        var descend = Emit(0x04, 0); Target(descend, loop);
        var sibling = Instructions.Count;
        Target(leaf, sibling);
        Emit(0x39, Id(Operand.Cursor), Id(Operand.Cursor), Id(Operand.NextSibling));
        Emit(0x3a, Id(Operand.Test), Id(Operand.Cursor));
        var next = Emit(0x03, Id(Operand.Test), 0); Target(next, loop);
        Emit(0x2e, Id(Operand.Size), Id(Operand.Stack));
        Emit(0x1c, Id(Operand.Test), Id(Operand.Size), Id(Operand.Zero), 0);
        var exhausted = Emit(0x02, Id(Operand.Test), 0);
        Emit(0x0f, Id(Operand.Size), Id(Operand.One));
        Emit(0x2c, Id(Operand.Cursor), Id(Operand.Stack), Id(Operand.Size));
        Emit(0x0f, Id(Operand.Depth), Id(Operand.One));
        var advance = Emit(0x04, 0); Target(advance, sibling);
        // Charge all branches and a pop per node; every pop has an earlier push.
        Instructions[cost][2] = Instructions.Count - loop;
        Target(exhausted, Instructions.Count); Target(empty, Instructions.Count);
        Emit(0x01, Id(Operand.Complete), Id(Operand.True)); Emit(0x05);
        Fail(1, nodeFailure); Fail(2, depthFailure); Fail(3, budgetFailure);
        Fail(4, pidTypeFailure, pidFailure); Fail(5, passwordTypeFailure, offscreenTypeFailure);
    }
}
