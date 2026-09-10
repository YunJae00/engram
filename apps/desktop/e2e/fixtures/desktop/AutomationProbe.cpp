#include <windows.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include <chrono>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <stdexcept>

using Microsoft::WRL::ComPtr;

static void Check(HRESULT result)
{
    if (FAILED(result)) throw std::runtime_error("UI Automation query failed");
}

static unsigned long long Number(const wchar_t* value)
{
    if (!value[0] || std::wcsspn(value, L"0123456789") != std::wcslen(value))
        throw std::runtime_error("Expected a decimal fixture identity");
    wchar_t* end = nullptr;
    const auto result = std::wcstoull(value, &end, 10);
    if (!result || *end) throw std::runtime_error("Invalid fixture identity");
    return result;
}

static void Samples(REFCLSID implementation, HWND window)
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
        Check(root->FindFirst(TreeScope_Descendants, condition.Get(), &found));
        const auto milliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        if (sample) std::cout << ',';
        std::cout << "{\"elapsedMs\":" << milliseconds << ",\"password\":" << (found ? "true" : "false") << '}';
    }
    std::cout << ']';
}

int wmain(int argc, wchar_t** argv)
{
    try
    {
        const auto ci = _wgetenv(L"CI");
        const auto github = _wgetenv(L"GITHUB_ACTIONS");
        if (argc != 3 || !ci || !github || std::wcscmp(ci, L"true") || std::wcscmp(github, L"true"))
            throw std::runtime_error("An isolated Windows CI fixture is required");
        const auto window = reinterpret_cast<HWND>(Number(argv[1]));
        const auto expectedPid = Number(argv[2]);
        DWORD pid = 0;
        wchar_t title[128] = {};
        GetWindowThreadProcessId(window, &pid);
        GetWindowTextW(window, title, 128);
        if (!IsWindow(window) || pid != expectedPid || std::wcscmp(title, L"Desktop input fixture"))
            throw std::runtime_error("The owned fixture window is unavailable");
        Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
        std::cout << "{\"classic\":";
        Samples(__uuidof(CUIAutomation), window);
        std::cout << ",\"modern\":";
        Samples(__uuidof(CUIAutomation8), window);
        std::cout << "}\n";
        CoUninitialize();
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
