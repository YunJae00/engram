import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow")
func backgroundWindowID(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

extension DesktopHost {
    func checkBackground(_ node: Control, window: Target, inputVersion: UInt64) throws {
        _ = try resolveWindow(window.id, pid: window.pid)
        _ = try control(Snapshot(target: window, bounds: try window.bounds, controls: [node], focus: nil, complete: true), id: node.id)
        guard !node.secret, node.enabled, attribute(node.element, kAXEnabledAttribute) as? Bool ?? true, !window.minimized else {
            throw DesktopFailure("The control is unavailable")
        }
        try checkBackgroundInput(window, inputVersion: inputVersion)
    }
    func checkBackgroundInput(_ window: Target, inputVersion: UInt64) throws {
        guard !monitor.state().escaped, monitor.inputVersion(window.pid) == inputVersion,
              !(window.foreground && monitor.state().idle < 4000) else { throw DesktopFailure("The person is using this app") }
    }
    func backgroundKeyWindow(_ window: Target) throws {
        func matches() -> Bool {
            guard let focused = attribute(AXUIElementCreateApplication(window.pid), kAXFocusedWindowAttribute),
                  CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
            var id: CGWindowID = 0
            return backgroundWindowID(unsafeBitCast(focused, to: AXUIElement.self), &id) == .success && id == window.id
        }
        if matches() { return }
        AXUIElementSetAttributeValue(window.element, kAXMainAttribute as CFString, kCFBooleanTrue)
        usleep(100_000)
        guard matches() else { throw DesktopFailure("The app's key window is not this window") }
    }
    // Web buttons activate on Return; a web page may bind Space to its own controls. AppKit buttons press on Space.
    func webContent(_ element: AXUIElement) -> Bool {
        var current = element
        for _ in 0..<60 {
            if stringAttribute(current, kAXRoleAttribute) == "AXWebArea" { return true }
            guard let parent = attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
            current = unsafeBitCast(parent, to: AXUIElement.self)
        }
        return false
    }
    func backgroundPair(_ down: CGEvent?, _ up: CGEvent?, window: Target, inputVersion: UInt64) throws {
        guard let down = down, let up = up else { throw DesktopFailure("Background input could not be created") }
        try checkBackgroundInput(window, inputVersion: inputVersion)
        down.setIntegerValueField(.eventSourceUserData, value: monitor.marker)
        up.setIntegerValueField(.eventSourceUserData, value: monitor.marker)
        down.postToPid(window.pid)
        up.postToPid(window.pid)
    }
    func backgroundPress(_ node: Control, window: Target, inputVersion: UInt64) throws -> String {
        try checkBackground(node, window: window, inputVersion: inputVersion)
        let buttons = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton"]
        if buttons.contains(node.role) || node.role == "AXLink",
           AXUIElementSetAttributeValue(node.element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success {
            usleep(150_000)
            // Chromium reports the focused control on the element itself; its application-level focused element reads as noValue.
            if attribute(node.element, kAXFocusedAttribute) as? Bool == true {
                try backgroundKeyWindow(window)
                let code: CGKeyCode = node.role == "AXLink" || webContent(node.element) ? 36 : 49
                try backgroundPair(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                                   CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false), window: window, inputVersion: inputVersion)
                return "focus-key"
            }
        }
        try checkBackgroundInput(window, inputVersion: inputVersion)
        guard AXUIElementPerformAction(node.element, kAXPressAction as CFString) == .success else { throw DesktopFailure("This control cannot be pressed") }
        return "ax"
    }
    func backgroundSet(_ node: Control, value: String, window: Target, inputVersion: UInt64) throws -> String {
        AXUIElementSetAttributeValue(node.element, kAXValueAttribute as CFString, value as CFString)
        // Chromium acknowledges AX writes before its field value is updated.
        usleep(100_000)
        if node.value == value { return "ax" }
        return try backgroundText(node, value: value, window: window, inputVersion: inputVersion) ? "typed" : "ax"
    }
    func backgroundText(_ node: Control, value: String, window: Target, inputVersion: UInt64) throws -> Bool {
        if !value.isEmpty { try literal(value) }
        // Identity is checked once before typing; Chromium can move the field as its value changes.
        try checkBackground(node, window: window, inputVersion: inputVersion)
        guard AXUIElementSetAttributeValue(node.element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { return false }
        usleep(150_000)
        var range = CFRange(location: 0, length: node.value.utf16.count)
        guard let selection = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(node.element, kAXSelectedTextRangeAttribute as CFString, selection) == .success else { return false }
        usleep(100_000)
        try backgroundKeyWindow(window)
        if value.isEmpty {
            try backgroundPair(CGEvent(keyboardEventSource: nil, virtualKey: 51, keyDown: true),
                               CGEvent(keyboardEventSource: nil, virtualKey: 51, keyDown: false), window: window, inputVersion: inputVersion)
        }
        if !value.isEmpty {
            _ = try insertText(node.element, textChunks(value), ready: { try checkBackgroundInput(window, inputVersion: inputVersion) },
                               post: { down, up in try backgroundPair(down, up, window: window, inputVersion: inputVersion) })
        }
        usleep(100_000)
        return true
    }
}
