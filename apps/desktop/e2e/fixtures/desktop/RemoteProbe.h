#pragma once

#ifdef HAS_REMOTE_OPERATIONS
// Protocol facts: Microsoft's RemoteOperationInstructions.h and RemoteOperationGraph.cpp.
// Branch offsets count instructions, not bytes; NewBool carries one unpadded byte.
struct RemoteScanCode
{
    std::vector<std::vector<uint32_t>> instructions;
    int Emit(std::initializer_list<uint32_t> words)
    {
        instructions.emplace_back(words);
        return static_cast<int>(instructions.size()) - 1;
    }
    void Target(int instruction, int target)
    {
        instructions.at(instruction).back() = static_cast<uint32_t>(target - instruction);
    }
    std::vector<uint8_t> Bytes() const
    {
        std::vector<uint8_t> bytes(4, 0);
        for (const auto& instruction : instructions)
            for (size_t index = 0; index < instruction.size(); index++)
                for (int shift = 0; shift < (instruction[0] == 0x1f && index == 2 ? 8 : 32); shift += 8)
                    bytes.push_back(static_cast<uint8_t>(instruction[index] >> shift));
        return bytes;
    }
};

struct RemoteScanResult { std::string json; bool complete = false; };

static RemoteScanResult RemoteFullScan(IUIAutomation* automation, IUIAutomationElement* root, DWORD pid)
{
    namespace Core = winrt::Windows::UI::UIAutomation::Core;
    const char* stage = "scan-import";
    try
    {
        Core::CoreAutomationRemoteOperation operation;
        winrt::com_ptr<IUIAutomationElement> held;
        held.copy_from(root);
        operation.ImportElement({ 1 }, held.as<winrt::Windows::UI::UIAutomation::AutomationElement>());
        stage = "scan-capability";
        const std::vector<uint32_t> opcodes = {
            0x01, 0x02, 0x03, 0x04, 0x05, 0x0e, 0x0f, 0x19, 0x1a, 0x18,
            0x1c, 0x1d, 0x1e, 0x1f, 0x25, 0x2a, 0x2c, 0x2e, 0x38, 0x39, 0x3a, 0x3d, 0x3e,
        };
        for (const auto opcode : opcodes)
            if (!operation.IsOpcodeSupported(opcode))
                return { "{\"available\":false,\"completeCoverage\":false,\"stage\":\"scan-capability\",\"unsupportedOpcode\":" + std::to_string(opcode) + "}" };

        enum Operand : uint32_t {
            Root = 1, PasswordId, OffscreenId, False, True, FirstChild, NextSibling, PidId, ExpectedPid,
            Cursor, Stack, Depth, Nodes, Found, Complete, Reason, Test, Password, Offscreen,
            Size, One, Zero, NodeCap, DepthCap, Budget, Cost, ActualPid, MaxDepth,
        };
        constexpr uint32_t nodeLimit = 1024, depthLimit = 64, instructionLimit = 131072;
        RemoteScanCode code;
        code.Emit({ 0x1d, PasswordId, UIA_IsPasswordPropertyId });
        code.Emit({ 0x1d, OffscreenId, UIA_IsOffscreenPropertyId });
        code.Emit({ 0x1d, PidId, UIA_ProcessIdPropertyId });
        code.Emit({ 0x1d, ExpectedPid, pid });
        code.Emit({ 0x1d, FirstChild, NavigateDirection_FirstChild });
        code.Emit({ 0x1d, NextSibling, NavigateDirection_NextSibling });
        code.Emit({ 0x1f, False, 0 }); code.Emit({ 0x1f, True, 1 });
        code.Emit({ 0x1e, One, 1 }); code.Emit({ 0x1e, Zero, 0 });
        code.Emit({ 0x1e, Depth, 1 }); code.Emit({ 0x1e, Nodes, 0 });
        code.Emit({ 0x1e, MaxDepth, 0 }); code.Emit({ 0x1e, Reason, 0 });
        code.Emit({ 0x1e, NodeCap, nodeLimit }); code.Emit({ 0x1e, DepthCap, depthLimit });
        code.Emit({ 0x1e, Budget, instructionLimit - 128 });
        const int costInstruction = code.Emit({ 0x1e, Cost, 0 });
        code.Emit({ 0x1f, Found, 0 }); code.Emit({ 0x1f, Complete, 0 });
        code.Emit({ 0x25, Stack });
        code.Emit({ 0x39, Cursor, Root, FirstChild });

        const int loop = static_cast<int>(code.instructions.size());
        code.Emit({ 0x1c, Test, Budget, Cost, 3 }); // LessThan.
        const int budgetFailure = code.Emit({ 0x02, Test, 0 });
        code.Emit({ 0x0f, Budget, Cost });
        code.Emit({ 0x3a, Test, Cursor });
        const int ascend = code.Emit({ 0x02, Test, 0 });
        code.Emit({ 0x1c, Test, Nodes, NodeCap, 4 }); // GreaterThanOrEqual.
        const int nodeFailure = code.Emit({ 0x02, Test, 0 });
        code.Emit({ 0x1c, Test, Depth, DepthCap, 2 }); // GreaterThan.
        const int depthFailure = code.Emit({ 0x02, Test, 0 });
        code.Emit({ 0x38, ActualPid, Cursor, PidId, False });
        code.Emit({ 0x3e, Test, ActualPid });
        const int pidTypeFailure = code.Emit({ 0x03, Test, 0 });
        code.Emit({ 0x1c, Test, ActualPid, ExpectedPid, 0 });
        const int pidFailure = code.Emit({ 0x03, Test, 0 });
        code.Emit({ 0x38, Password, Cursor, PasswordId, False });
        code.Emit({ 0x3d, Test, Password });
        const int passwordTypeFailure = code.Emit({ 0x03, Test, 0 });
        code.Emit({ 0x38, Offscreen, Cursor, OffscreenId, False });
        code.Emit({ 0x3d, Test, Offscreen });
        const int offscreenTypeFailure = code.Emit({ 0x03, Test, 0 });
        code.Emit({ 0x19, Test, Offscreen });
        code.Emit({ 0x1a, Test, Password, Test });
        code.Emit({ 0x18, Found, Test });
        code.Emit({ 0x0e, Nodes, One });
        code.Emit({ 0x1c, Test, Depth, MaxDepth, 2 });
        const int depthUnchanged = code.Emit({ 0x03, Test, 0 });
        code.Emit({ 0x01, MaxDepth, Depth });
        code.Target(depthUnchanged, static_cast<int>(code.instructions.size()));
        // Only descendants are pushed. The imported root's sibling is never read.
        code.Emit({ 0x2a, Stack, Cursor });
        code.Emit({ 0x0e, Depth, One });
        code.Emit({ 0x39, Cursor, Cursor, FirstChild });
        const int descend = code.Emit({ 0x04, 0 }); code.Target(descend, loop);

        code.Target(ascend, static_cast<int>(code.instructions.size()));
        code.Emit({ 0x2e, Size, Stack });
        code.Emit({ 0x1c, Test, Size, Zero, 0 });
        const int exhausted = code.Emit({ 0x02, Test, 0 });
        code.Emit({ 0x0f, Size, One });
        code.Emit({ 0x2c, Cursor, Stack, Size });
        code.Emit({ 0x0f, Depth, One });
        code.Emit({ 0x39, Cursor, Cursor, NextSibling });
        const int advance = code.Emit({ 0x04, 0 }); code.Target(advance, loop);
        // Every loop path executes at most this many instructions, including both
        // alternatives. Charging that conservative bound makes cycles bounded too.
        const auto loopCost = static_cast<uint32_t>(code.instructions.size() - loop);
        code.instructions.at(costInstruction).back() = loopCost;
        code.Target(exhausted, static_cast<int>(code.instructions.size()));
        code.Emit({ 0x01, Complete, True }); code.Emit({ 0x05 });
        const auto fail = [&](std::initializer_list<int> branches, uint32_t reason)
        {
            for (const auto branch : branches) code.Target(branch, static_cast<int>(code.instructions.size()));
            code.Emit({ 0x1e, Reason, reason }); code.Emit({ 0x05 });
        };
        fail({ nodeFailure }, 1); fail({ depthFailure }, 2); fail({ budgetFailure }, 3);
        fail({ pidTypeFailure, pidFailure }, 4); fail({ passwordTypeFailure, offscreenTypeFailure }, 5);
        for (const auto& instruction : code.instructions)
            if (std::find(opcodes.begin(), opcodes.end(), instruction[0]) == opcodes.end())
                throw std::runtime_error("Unchecked remote scan opcode");
        for (const auto id : { Nodes, Found, Complete, Reason, MaxDepth, Budget })
            operation.AddToResults({ static_cast<int>(id) });
        stage = "scan-execute";
        const auto started = std::chrono::steady_clock::now();
        const auto result = operation.Execute(code.Bytes());
        const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        if (result.Status() != Core::AutomationRemoteOperationStatus::Success)
            return { "{\"available\":false,\"completeCoverage\":false,\"stage\":\"scan-execute\",\"status\":"
                + std::to_string(static_cast<int>(result.Status())) + ",\"extendedError\":"
                + std::to_string(static_cast<int32_t>(result.ExtendedError())) + ",\"errorLocation\":"
                + std::to_string(result.ErrorLocation()) + "}" };
        const auto value = [&](Operand id) { return result.GetOperand({ static_cast<int>(id) }); };
        const bool exhaustedTree = winrt::unbox_value<bool>(value(Complete));
        const bool found = winrt::unbox_value<bool>(value(Found));
        const auto nodes = winrt::unbox_value<uint32_t>(value(Nodes));
        const auto reason = winrt::unbox_value<uint32_t>(value(Reason));
        stage = "scan-reference";
        ComPtr<IUIAutomationCondition> all, password, visible, condition;
        Check(automation->CreateTrueCondition(&all));
        VARIANT property; VariantInit(&property); property.vt = VT_BOOL; property.boolVal = VARIANT_TRUE;
        Check(automation->CreatePropertyCondition(UIA_IsPasswordPropertyId, property, &password));
        property.boolVal = VARIANT_FALSE;
        Check(automation->CreatePropertyCondition(UIA_IsOffscreenPropertyId, property, &visible));
        Check(automation->CreateAndCondition(password.Get(), visible.Get(), &condition));
        ComPtr<IUIAutomationElementArray> descendants;
        ComPtr<IUIAutomationElement> referencePassword;
        Check(root->FindAll(TreeScope_Descendants, all.Get(), &descendants));
        int referenceNodes = 0; Check(descendants->get_Length(&referenceNodes));
        Check(root->FindFirst(TreeScope_Descendants, condition.Get(), &referencePassword));
        const bool countMatches = nodes == static_cast<uint32_t>(referenceNodes);
        const bool passwordMatches = found == static_cast<bool>(referencePassword);
        const bool complete = exhaustedTree && reason == 0 && countMatches && passwordMatches;
        std::ostringstream json;
        json << "{\"available\":true,\"stage\":\"" << (complete ? "complete" : "incomplete")
            << "\",\"completeCoverage\":" << (complete ? "true" : "false")
            << ",\"exhausted\":" << (exhaustedTree ? "true" : "false") << ",\"elapsedMs\":" << elapsed
            << ",\"nodesVisited\":" << nodes << ",\"referenceNodes\":" << referenceNodes
            << ",\"nodeCountMatches\":" << (countMatches ? "true" : "false")
            << ",\"password\":" << (found ? "true" : "false")
            << ",\"passwordMatches\":" << (passwordMatches ? "true" : "false")
            << ",\"reason\":" << reason << ",\"maxDepth\":" << winrt::unbox_value<uint32_t>(value(MaxDepth))
            << ",\"nodeLimit\":" << nodeLimit << ",\"depthLimit\":" << depthLimit
            << ",\"instructionLimit\":" << instructionLimit << ",\"chargedInstructions\":"
            << instructionLimit - winrt::unbox_value<uint32_t>(value(Budget)) << '}';
        return { json.str(), complete };
    }
    catch (const winrt::hresult_error& error)
    {
        return { "{\"available\":false,\"completeCoverage\":false,\"stage\":\"" + std::string(stage)
            + "\",\"hresult\":" + std::to_string(static_cast<int32_t>(error.code())) + "}" };
    }
    catch (const std::exception&)
    {
        return { "{\"available\":false,\"completeCoverage\":false,\"stage\":\"" + std::string(stage) + "\"}" };
    }
}
#endif
