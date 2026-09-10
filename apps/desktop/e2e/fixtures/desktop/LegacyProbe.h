#include <oleacc.h>
#include <string>

static std::wstring ProbeString(BSTR value)
{
    const std::wstring text(value ? value : L"", value ? SysStringLen(value) : 0);
    SysFreeString(value);
    return text;
}

static std::wstring ProbeLines(const std::wstring& text)
{
    std::wstring value;
    for (size_t index = 0; index < text.size(); index++)
    {
        if (text[index] != L'\r') value.push_back(text[index]);
        else { value.push_back(L'\n'); if (index + 1 < text.size() && text[index + 1] == L'\n') index++; }
    }
    return value;
}

static void RequireLegacyFixture(HWND window, DWORD expectedPid)
{
    DWORD pid = 0;
    wchar_t title[128] = {}, image[32768] = {}, executable[32768] = {};
    GetWindowThreadProcessId(window, &pid);
    GetWindowTextW(window, title, 128);
    if (!IsWindowVisible(window) || GetAncestor(window, GA_ROOT) != window || pid != expectedPid
        || GetForegroundWindow() != window || std::wcscmp(title, L"Desktop input fixture") || (GetAsyncKeyState(VK_ESCAPE) & 0x8000))
        throw std::runtime_error("The owned foreground fixture changed");
    const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    DWORD size = 32768;
    const bool obtained = process && QueryFullProcessImageNameW(process, 0, image, &size);
    if (process) CloseHandle(process);
    if (!obtained || !GetModuleFileNameW(nullptr, executable, 32768)) throw std::runtime_error("The owned fixture path is unavailable");
    const std::wstring base(executable);
    const auto expected = base.substr(0, base.find_last_of(L"\\/") + 1) + L"ControlFixture.exe";
    if (_wcsicmp(image, expected.c_str())) throw std::runtime_error("Legacy writes are restricted to the sibling owned fixture");
}

static std::wstring ProbeText(IUIAutomationTextPattern* pattern)
{
    ComPtr<IUIAutomationTextRange> range;
    Check(pattern->get_DocumentRange(&range));
    BSTR raw = nullptr;
    Check(range->GetText(2001, &raw));
    const auto text = ProbeString(raw);
    if (text.size() > 2000) throw std::runtime_error("The probe requires the complete bounded document value");
    return text;
}

static bool ProbeReadonly(IUIAutomationTextPattern* pattern)
{
    ComPtr<IUIAutomationTextRange> range;
    Check(pattern->get_DocumentRange(&range));
    VARIANT value;
    VariantInit(&value);
    Check(range->GetAttributeValue(UIA_IsReadOnlyAttributeId, &value));
    const bool known = value.vt == VT_BOOL;
    const bool readonly = known && value.boolVal != VARIANT_FALSE;
    VariantClear(&value);
    if (!known) throw std::runtime_error("Document writability is unknown");
    return readonly;
}

static void RequireUnprotectedFixture(IUIAutomation* automation, IUIAutomationElement* root)
{
    VARIANT flag;
    VariantInit(&flag); flag.vt = VT_BOOL; flag.boolVal = VARIANT_TRUE;
    ComPtr<IUIAutomationCondition> passwords;
    Check(automation->CreatePropertyCondition(UIA_IsPasswordPropertyId, flag, &passwords));
    ComPtr<IUIAutomationElementArray> found;
    Check(root->FindAll(TreeScope_Descendants, passwords.Get(), &found));
    int total = 0;
    Check(found->get_Length(&total));
    for (int index = 0; index < total; index++) {
        ComPtr<IUIAutomationElement> one;
        Check(found->GetElement(index, &one));
        BOOL offscreen = FALSE;
        Check(one->get_CurrentIsOffscreen(&offscreen));
        if (!offscreen) throw std::runtime_error("A protected field is visible in the owned fixture");
    }
}

static std::string LegacyDiagnostic(HWND window, DWORD expectedPid, bool expectReadonly)
{
    RequireLegacyFixture(window, expectedPid);
    ComPtr<IUIAutomation> automation;
    Check(CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)));
    ComPtr<IUIAutomation2> settings;
    Check(automation.As(&settings));
    Check(settings->put_ConnectionTimeout(5000));
    Check(settings->put_TransactionTimeout(5000));
    ComPtr<IUIAutomationElement> root, editor;
    Check(automation->ElementFromHandle(window, &root));
    RequireUnprotectedFixture(automation.Get(), root.Get());
    ComPtr<IUIAutomationCondition> condition;
    VARIANT name;
    VariantInit(&name);
    name.vt = VT_BSTR;
    name.bstrVal = SysAllocString(L"Deep editor");
    const auto named = automation->CreatePropertyCondition(UIA_NamePropertyId, name, &condition);
    VariantClear(&name);
    Check(named);
    ComPtr<IUIAutomationElementArray> matches;
    Check(root->FindAll(TreeScope_Descendants, condition.Get(), &matches));
    int count = 0;
    Check(matches->get_Length(&count));
    if (count != 1) throw std::runtime_error("Expected exactly one owned multiline editor");
    Check(matches->GetElement(0, &editor));
    CONTROLTYPEID type = 0;
    Check(editor->get_CurrentControlType(&type));
    if (type != UIA_DocumentControlTypeId && type != UIA_EditControlTypeId) throw std::runtime_error("The owned target is not a text editor");
    RECT originalBounds;
    Check(editor->get_CurrentBoundingRectangle(&originalBounds));
    BSTR identifier = nullptr;
    Check(editor->get_CurrentAutomationId(&identifier));
    const auto originalId = ProbeString(identifier);
    ComPtr<IUIAutomationTextPattern> text;
    Check(editor->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text)));
    const auto initialText = ProbeText(text.Get());
    const auto readonly = ProbeReadonly(text.Get());
    if (readonly != expectReadonly) throw std::runtime_error("The document readonly fixture state disagrees");
    ComPtr<IUIAutomationLegacyIAccessiblePattern> legacy;
    const auto available = editor->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, IID_PPV_ARGS(&legacy));
    if (FAILED(available) || !legacy)
        return std::string("{\"legacyAvailable\":false,\"unsupported\":true,\"setterAttempted\":false,\"restored\":true,\"readonlyBlocked\":")
            + (readonly ? "true}" : "false}");
    DWORD role = 0, state = 0;
    Check(legacy->get_CurrentRole(&role));
    Check(legacy->get_CurrentState(&state));
    if (readonly)
        return "{\"legacyAvailable\":true,\"setterAttempted\":false,\"restored\":true,\"readonlyBlocked\":true,\"role\":"
            + std::to_string(role) + ",\"state\":" + std::to_string(state) + "}";
    if (role != ROLE_SYSTEM_TEXT || (state & (STATE_SYSTEM_READONLY | STATE_SYSTEM_PROTECTED | STATE_SYSTEM_UNAVAILABLE | STATE_SYSTEM_INVISIBLE | STATE_SYSTEM_OFFSCREEN)))
        throw std::runtime_error("The legacy target is not an available unprotected editable text control");
    const auto legacyValue = [&]() {
        BSTR raw = nullptr;
        Check(legacy->get_CurrentValue(&raw));
        return ProbeString(raw);
    };
    const auto initial = legacyValue();
    if (initial.size() > 2000 || ProbeLines(initial) != ProbeLines(initialText))
        return "{\"legacyAvailable\":true,\"unsupported\":true,\"reason\":\"complete-value-disagreement\",\"setterAttempted\":false,\"restored\":true}";
    const auto safe = [&](const std::wstring& expected) {
        RequireLegacyFixture(window, expectedPid);
        ComPtr<IUIAutomationElement> focused, currentRoot;
        Check(automation->GetFocusedElement(&focused));
        Check(automation->ElementFromHandle(window, &currentRoot));
        BOOL equal = FALSE;
        Check(automation->CompareElements(root.Get(), currentRoot.Get(), &equal));
        if (!equal) throw std::runtime_error("The owned root was replaced");
        Check(automation->CompareElements(editor.Get(), focused.Get(), &equal));
        if (!equal) throw std::runtime_error("The owned editor lost focus");
        BOOL password = TRUE, enabled = FALSE, offscreen = TRUE;
        Check(editor->get_CurrentIsPassword(&password));
        Check(editor->get_CurrentIsEnabled(&enabled));
        Check(editor->get_CurrentIsOffscreen(&offscreen));
        RECT bounds;
        Check(editor->get_CurrentBoundingRectangle(&bounds));
        BSTR currentId = nullptr, currentName = nullptr;
        Check(editor->get_CurrentAutomationId(&currentId));
        Check(editor->get_CurrentName(&currentName));
        const auto identifierNow = ProbeString(currentId), nameNow = ProbeString(currentName);
        CONTROLTYPEID typeNow = 0;
        Check(editor->get_CurrentControlType(&typeNow));
        if (identifierNow != originalId || nameNow != L"Deep editor" || typeNow != type || !EqualRect(&bounds, &originalBounds)
            || password || !enabled || offscreen || ProbeReadonly(text.Get())) throw std::runtime_error("The observed editor changed");
        Check(legacy->get_CurrentRole(&role));
        Check(legacy->get_CurrentState(&state));
        if (role != ROLE_SYSTEM_TEXT || (state & (STATE_SYSTEM_READONLY | STATE_SYSTEM_PROTECTED | STATE_SYSTEM_UNAVAILABLE | STATE_SYSTEM_INVISIBLE | STATE_SYSTEM_OFFSCREEN)))
            throw std::runtime_error("The legacy editor became protected or unavailable");
        RequireUnprotectedFixture(automation.Get(), currentRoot.Get());
        if (legacyValue() != expected || ProbeLines(ProbeText(text.Get())) != ProbeLines(expected))
            throw std::runtime_error("The complete document value changed before the probe write");
    };
    std::wstring replacement;
    for (int line = 0; line < 100; line++) replacement += L"Line \uD55C\uAE00 42\r\n";
    safe(initial);
    const auto started = std::chrono::steady_clock::now();
    const auto written = legacy->SetValue(replacement.c_str());
    const auto milliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    const auto after = ProbeText(text.Get());
    if (FAILED(written)) {
        const bool unchanged = ProbeLines(after) == ProbeLines(initial);
        return std::string("{\"legacyAvailable\":true,\"setterAttempted\":true,\"setterHresult\":") + std::to_string(static_cast<long>(written))
            + ",\"unsupported\":" + (unchanged ? "true" : "false") + ",\"restored\":" + (unchanged ? "true}" : "false}");
    }
    const bool verified = ProbeLines(after) == ProbeLines(replacement);
    if (!verified) return "{\"legacyAvailable\":true,\"setterAttempted\":true,\"setterHresult\":0,\"writeVerified\":false,\"restored\":false}";
    safe(replacement);
    const auto restored = legacy->SetValue(initial.c_str());
    const bool restoredValue = SUCCEEDED(restored) && ProbeLines(ProbeText(text.Get())) == ProbeLines(initial);
    std::ostringstream evidence;
    evidence << "{\"legacyAvailable\":true,\"setterAttempted\":true,\"setterHresult\":" << static_cast<long>(written)
        << ",\"writeVerified\":true,\"restored\":" << (restoredValue ? "true" : "false")
        << ",\"restoreHresult\":" << static_cast<long>(restored) << ",\"characters\":" << replacement.size() << ",\"elapsedMs\":" << milliseconds << '}';
    return evidence.str();
}
