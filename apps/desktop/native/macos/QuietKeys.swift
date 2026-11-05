import AppKit
import ApplicationServices

func quietKeyChord(_ key: String) throws -> (CGKeyCode, CGEventFlags) {
    let codes: [String: CGKeyCode] = ["Enter": 36, "Escape": 53, "Tab": 48, "Shift+Tab": 48,
        "ArrowUp": 126, "ArrowDown": 125, "ArrowLeft": 123, "ArrowRight": 124, "Control+Enter": 36]
    guard let code = codes[key] else { throw DesktopFailure("Unsupported quiet key; no input was sent") }
    return (code, key == "Shift+Tab" ? .maskShift : key == "Control+Enter" ? .maskControl : [])
}

extension DesktopHost {
    func quietKey(_ key: String, node: Control, window: Target, inputVersion: UInt64) throws -> [String: Any] {
        let (code, flags) = try quietKeyChord(key)
        try checkBackground(node, window: window, inputVersion: inputVersion)
        func effect() -> String {
            let focus = attribute(AXUIElementCreateApplication(window.pid), kAXFocusedUIElementAttribute)
            var range = CFRange(location: -1, length: -1)
            if let selection = attribute(node.element, kAXSelectedTextRangeAttribute), CFGetTypeID(selection) == AXValueGetTypeID() {
                _ = AXValueGetValue(unsafeBitCast(selection, to: AXValue.self), .cfRange, &range)
            }
            return node.value + "|" + String(focus.map { CFHash($0) } ?? 0) + "|\(range.location):\(range.length)"
        }
        guard AXUIElementSetAttributeValue(node.element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
            return ["pressed": "", "landed": false, "delivery": "not_delivered", "retry": "unsafe", "message": "This app does not accept background keys"]
        }
        try backgroundKeyWindow(window)
        let before = effect()
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        down?.flags = flags; up?.flags = flags
        try backgroundPair(down, up, window: window, inputVersion: inputVersion)
        let deadline = Date().addingTimeInterval(0.7)
        var changed = false
        repeat {
            usleep(50_000)
            try checkBackgroundInput(window, inputVersion: inputVersion)
            changed = effect() != before
        } while !changed && Date() < deadline
        return ["how": "focus-key", "pressed": "focus-key", "key": key, "control": "c" + node.id, "landed": changed,
            "delivery": changed ? "delivered_unverified" : "not_delivered", "retry": "unsafe", "requiresVerification": true,
            "message": changed ? "" : "This app does not accept background keys, or no effect could be verified. Read the app before continuing."]
    }
}
