#include <windows.h>
#include <roapi.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include <chrono>
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <stdexcept>
#include <sstream>
#include <vector>
#if __has_include(<winrt/Windows.UI.UIAutomation.Core.h>)
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.UI.UIAutomation.h>
#include <winrt/Windows.UI.UIAutomation.Core.h>
#define HAS_REMOTE_OPERATIONS 1
#endif

using Microsoft::WRL::ComPtr;

static void Check(HRESULT result)
{
    if (FAILED(result)) throw std::runtime_error("UI Automation query failed");
}

#include "LegacyProbe.h"
#include "RemoteProbe.h"

static unsigned long long Number(const wchar_t* value)
{
    if (!value[0] || std::wcsspn(value, L"0123456789") != std::wcslen(value))
        throw std::runtime_error("Expected a decimal fixture identity");
    wchar_t* end = nullptr;
    const auto result = std::wcstoull(value, &end, 10);
    if (!result || *end) throw std::runtime_error("Invalid fixture identity");
    return result;
}

static void Samples(REFCLSID implementation, HWND window, bool passwordFirst = false)
{
    ComPtr<IUIAutomation> automation;
    Check(CoCreateInstance(implementation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)));
    ComPtr<IUIAutomation2> settings;
    if (SUCCEEDED(automation.As(&settings)))
    {
        Check(settings->put_ConnectionTimeout(5000));
        Check(settings->put_TransactionTimeout(5000));
    }
    ComPtr<IUIAutomationCondition> password, visible, condition;
    VARIANT value;
    VariantInit(&value);
    value.vt = VT_BOOL;
    value.boolVal = VARIANT_TRUE;
    Check(automation->CreatePropertyCondition(UIA_IsPasswordPropertyId, value, &password));
    value.boolVal = VARIANT_FALSE;
    Check(automation->CreatePropertyCondition(UIA_IsOffscreenPropertyId, value, &visible));
    Check(automation->CreateAndCondition(password.Get(), visible.Get(), &condition));
    std::cout << '[';
    for (int sample = 0; sample < 3; sample++)
    {
        ComPtr<IUIAutomationElement> root, found;
        Check(automation->ElementFromHandle(window, &root));
        const auto started = std::chrono::steady_clock::now();
        if (passwordFirst)
        {
            ComPtr<IUIAutomationElementArray> candidates;
            Check(root->FindAll(TreeScope_Descendants, password.Get(), &candidates));
            int count = 0;
            Check(candidates->get_Length(&count));
            for (int index = 0; index < count; index++)
            {
                ComPtr<IUIAutomationElement> candidate;
                Check(candidates->GetElement(index, &candidate));
                BOOL offscreen = FALSE;
                Check(candidate->get_CurrentIsOffscreen(&offscreen));
                if (!offscreen) { found = candidate; break; }
            }
        }
        else Check(root->FindFirst(TreeScope_Descendants, condition.Get(), &found));
        const auto milliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        if (sample) std::cout << ',';
        std::cout << "{\"elapsedMs\":" << milliseconds << ",\"password\":" << (found ? "true" : "false") << '}';
    }
    std::cout << ']';
}

static std::string RemoteDiagnostic(HWND window)
{
#ifdef HAS_REMOTE_OPERATIONS
    const char* stage = "activation";
    try
    {
        namespace Core = winrt::Windows::UI::UIAutomation::Core;
        Core::CoreAutomationRemoteOperation operation;
        winrt::com_ptr<IUIAutomation> automation;
        winrt::check_hresult(CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(automation.put())));
        winrt::com_ptr<IUIAutomationElement> root;
        winrt::check_hresult(automation->ElementFromHandle(window, root.put()));
        stage = "import";
        operation.ImportElement({ 1 }, root.as<winrt::Windows::UI::UIAutomation::AutomationElement>());
        stage = "capability";
        // UIA bytecode opcodes: NewInt, NewBool, GetPropertyValue, Navigate.
        // Protocol layout: github.com/microsoft/Microsoft-UI-UIAutomation, RemoteOperationInstructions.h.
        for (const uint32_t opcode : { 0x1dU, 0x1fU, 0x38U, 0x39U })
            if (!operation.IsOpcodeSupported(opcode))
                return "{\"available\":false,\"stage\":\"capability\",\"unsupportedOpcode\":" + std::to_string(opcode) + ",\"completeCoverage\":false}";
        std::vector<uint8_t> code;
        const auto words = [&](std::initializer_list<uint32_t> values)
        {
            for (const auto value : values)
                for (int shift = 0; shift < 32; shift += 8) code.push_back(static_cast<uint8_t>(value >> shift));
        };
        words({ 0, 0x1d, 2, UIA_IsPasswordPropertyId, 0x1f, 3 });
        code.push_back(0); // NewBool payload is one byte, without padding.
        words({ 0x38, 4, 1, 2, 3, 0x1d, 5, NavigateDirection_FirstChild, 0x39, 6, 1, 5,
            0x1d, 7, NavigateDirection_NextSibling, 0x39, 8, 6, 7 });
        for (const int id : { 4, 6, 8 }) operation.AddToResults({ id });
        stage = "execute";
        const auto started = std::chrono::steady_clock::now();
        const auto result = operation.Execute(code);
        const auto milliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        if (result.Status() != Core::AutomationRemoteOperationStatus::Success)
            return "{\"available\":false,\"stage\":\"execute\",\"status\":" + std::to_string(static_cast<int>(result.Status()))
                + ",\"extendedError\":" + std::to_string(static_cast<int32_t>(result.ExtendedError()))
                + ",\"errorLocation\":" + std::to_string(result.ErrorLocation()) + ",\"completeCoverage\":false}";
        stage = "parity";
        BOOL password = FALSE;
        winrt::check_hresult(root->get_CurrentIsPassword(&password));
        const bool remotePassword = winrt::unbox_value<bool>(result.GetOperand({ 4 }));
        winrt::com_ptr<IUIAutomationTreeWalker> walker;
        winrt::com_ptr<IUIAutomationElement> child, sibling;
        winrt::check_hresult(automation->get_RawViewWalker(walker.put()));
        winrt::check_hresult(walker->GetFirstChildElement(root.get(), child.put()));
        if (child) winrt::check_hresult(walker->GetNextSiblingElement(child.get(), sibling.put()));
        const auto same = [&](IUIAutomationElement* expected, int id)
        {
            const auto returned = result.GetOperand({ id });
            if (!returned) return expected == nullptr;
            if (!expected) return false;
            BOOL equal = FALSE;
            const auto actual = returned.as<IUIAutomationElement>();
            winrt::check_hresult(automation->CompareElements(expected, actual.get(), &equal));
            return equal != FALSE;
        };
        const bool propertyMatches = remotePassword == (password != FALSE);
        const bool navigationMatches = same(child.get(), 6) && same(sibling.get(), 8);
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        const auto scan = RemoteFullScan(automation.get(), root.get(), pid);
        std::ostringstream json;
        json << "{\"available\":true,\"stage\":\"complete\",\"elapsedMs\":" << milliseconds
            << ",\"propertyMatches\":" << (propertyMatches ? "true" : "false")
            << ",\"navigationMatches\":" << (navigationMatches ? "true" : "false")
            << ",\"completeCoverage\":" << (scan.complete ? "true" : "false") << ",\"fullScan\":" << scan.json << '}';
        return json.str();
    }
    catch (const winrt::hresult_error& error)
    {
        return "{\"available\":false,\"stage\":\"" + std::string(stage) + "\",\"hresult\":"
            + std::to_string(static_cast<int32_t>(error.code())) + ",\"completeCoverage\":false}";
    }
#else
    return "{\"available\":false,\"stage\":\"sdk-headers-unavailable\",\"completeCoverage\":false}";
#endif
}

int wmain(int argc, wchar_t** argv)
{
    try
    {
        const auto ci = _wgetenv(L"CI");
        const auto github = _wgetenv(L"GITHUB_ACTIONS");
        if ((argc != 3 && argc != 4) || (argc == 4 && std::wcscmp(argv[3], L"--remote") && std::wcscmp(argv[3], L"--legacy") && std::wcscmp(argv[3], L"--legacy-readonly"))
            || !ci || !github || std::wcscmp(ci, L"true") || std::wcscmp(github, L"true"))
            throw std::runtime_error("An isolated Windows CI fixture is required");
        const auto window = reinterpret_cast<HWND>(Number(argv[1]));
        const auto expectedPid = Number(argv[2]);
        DWORD pid = 0;
        wchar_t title[128] = {};
        GetWindowThreadProcessId(window, &pid);
        GetWindowTextW(window, title, 128);
        if (!IsWindow(window) || pid != expectedPid || std::wcscmp(title, L"Desktop input fixture"))
            throw std::runtime_error("The owned fixture window is unavailable");
        Check(RoInitialize(RO_INIT_MULTITHREADED));
        if (argc == 4)
        {
            std::cout << (!std::wcscmp(argv[3], L"--remote") ? RemoteDiagnostic(window)
                : LegacyDiagnostic(window, pid, !std::wcscmp(argv[3], L"--legacy-readonly"))) << '\n';
            RoUninitialize();
            return 0;
        }
        std::cout << "{\"classic\":";
        Samples(__uuidof(CUIAutomation), window);
        std::cout << ",\"modern\":";
        Samples(__uuidof(CUIAutomation8), window);
        std::cout << ",\"modernPasswordFirst\":";
        Samples(__uuidof(CUIAutomation8), window, true);
        std::cout << "}\n";
        RoUninitialize();
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
