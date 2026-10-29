import AppKit
import ApplicationServices

func literal(_ text: String) throws {
    guard !text.isEmpty, text.utf16.count <= 2000, !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
        throw DesktopFailure("Text must contain 1 to 2000 characters without control characters")
    }
}
func keyChord(_ key: String) throws -> (CGKeyCode, CGEventFlags) {
    let plain: [String: CGKeyCode] = ["Enter":36,"Tab":48,"Space":49,"Backspace":51,"Delete":117,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,"Home":115,"End":119,"PageUp":116,"PageDown":121,"F6":97]
    let allowed: Set<String> = ["Shift+Tab","Control+Tab","Control+Shift+Tab","Shift+F6","Control+A","Control+B","Control+I","Control+U","Control+F","Control+L","Control+N","Control+H","Control+Home","Control+End","Control+ArrowLeft","Control+ArrowRight","Shift+Home","Shift+End","Shift+ArrowLeft","Shift+ArrowRight","Shift+ArrowUp","Shift+ArrowDown","Control+Shift+Home","Control+Shift+End","Control+Shift+ArrowLeft","Control+Shift+ArrowRight"]
    if let code = plain[key] { return (code, []) }
    guard allowed.contains(key) else { throw DesktopFailure("This key is not allowed for desktop control") }
    if key == "Control+H" { return (3, [.maskCommand, .maskAlternate]) }
    if key == "Control+Home" { return (126, .maskCommand) }
    if key == "Control+End" { return (125, .maskCommand) }
    if key == "Control+Shift+Home" { return (126, [.maskCommand, .maskShift]) }
    if key == "Control+Shift+End" { return (125, [.maskCommand, .maskShift]) }
    let parts = key.split(separator: "+").map(String.init)
    let base = parts.last!
    var flags: CGEventFlags = parts.contains("Shift") ? .maskShift : []
    if parts.contains("Control") {
        // Windows editing shortcuts use Command on macOS, word movement uses Option.
        flags.insert(base == "Tab" ? .maskControl : base.hasPrefix("Arrow") ? .maskAlternate : .maskCommand)
    }
    let letters: [String: CGKeyCode] = ["A":0,"B":11,"I":34,"U":32,"F":3,"L":37,"N":45,"H":4]
    guard let code = plain[base] ?? letters[base] else { throw DesktopFailure("Invalid key") }
    return (code, flags)
}
extension DesktopHost {
    func focused(_ reading: Snapshot, editable: Bool) throws -> Control {
        guard let focused = attribute(AXUIElementCreateApplication(reading.target.pid), kAXFocusedUIElementAttribute),
              let original = reading.focus, CFEqual(original, focused),
              let node = reading.controls.first(where: { CFEqual($0.element, focused) }), !node.secret, node.enabled,
              !editable || node.settable else { throw DesktopFailure("Focus changed or is not a safe editable control. Observe again") }
        return try control(reading, id: node.id)
    }
    func safePoint(_ point: CGPoint, reading: Snapshot) throws {
        guard reading.complete, reading.bounds.contains(point), !reading.controls.contains(where: { $0.secret && ($0.bounds?.contains(point) ?? true) }) else { throw DesktopFailure("The input position is protected or unverified") }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let hit = hit else { throw DesktopFailure("Cannot verify the input position") }
        var pid: pid_t = 0
        AXUIElementGetPid(hit, &pid)
        guard pid == reading.target.pid, reading.controls.contains(where: { CFEqual($0.element, hit) && !$0.secret }) else { throw DesktopFailure("Another surface covers the input position. Observe again") }
    }
    func act(_ request: [String: Any], method: String, window: Target) throws -> Any {
        let lease = try text(request, "lease", limit: 100)
        let reading = try snapshot(request, window: window)
        let intervention = monitor.state().intervention
        func check() throws {
            try monitor.check(lease, window: window, intervention: intervention)
            try requireCurrent(reading, target: resolveWindow(window.id, pid: window.pid))
            guard window.foreground else { throw DesktopFailure("The selected window is no longer in front") }
            let flags = CGEventSource.flagsState(.combinedSessionState)
            guard flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty else { throw DesktopFailure("Release the keyboard modifiers before computer control") }
        }
        func post(_ event: CGEvent?) throws {
            guard let event = event else { throw DesktopFailure("Input could not be created") }
            try check()
            try monitor.post(event, lease: lease, window: window, intervention: intervention)
        }
        // A paired release must be sent even when intervention cancels the next action.
        func pair(_ down: CGEvent?, _ up: CGEvent?) throws {
            guard let up = up else { throw DesktopFailure("Input could not be created") }
            try post(down)
            up.setIntegerValueField(.eventSourceUserData, value: monitor.marker)
            up.post(tap: .cghidEventTap)
        }
        try check()
        defer { snapshots.removeValue(forKey: reading.id) }
        if method == "replace" {
            let node = try control(reading, id: text(request, "element", limit: 32))
            let expected = try text(request, "expected"), value = try text(request, "text")
            try literal(value)
            guard node.settable, node.value == expected else { throw DesktopFailure("The field changed or is not editable") }
            try check()
            guard AXUIElementSetAttributeValue(node.element, kAXValueAttribute as CFString, value as CFString) == .success else { throw DesktopFailure("This app did not accept replacement") }
        } else if method == "type" {
            let value = try text(request, "text")
            try literal(value)
            let original = try focused(reading, editable: true)
            for character in value {
                guard CFEqual(try focused(reading, editable: true).element, original.element) else { throw DesktopFailure("Keyboard focus changed") }
                let units = Array(String(character).utf16)
                let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
                let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
                units.withUnsafeBufferPointer { buffer in
                    down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                    up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                }
                try pair(down, up)
            }
        } else if method == "key" {
            let key = try text(request, "key", limit: 32)
            if key == "Escape" { monitor.stop("Escape requested"); return ["sent": false] }
            _ = try focused(reading, editable: false)
            let (code, flags) = try keyChord(key)
            let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            down?.flags = flags; up?.flags = []
            try pair(down, up)
        } else {
            let point: CGPoint
            if method == "scroll" { point = CGPoint(x: reading.bounds.midX, y: reading.bounds.midY) }
            else if let id = request["element"] as? String {
                guard request["x"] == nil, request["y"] == nil, let bounds = try control(reading, id: id).bounds else { throw DesktopFailure("Choose a control or coordinates") }
                point = CGPoint(x: bounds.midX, y: bounds.midY)
            } else {
                guard let x = request["x"] as? Int, let y = request["y"] as? Int, abs(x) <= 100000, abs(y) <= 100000 else { throw DesktopFailure("Invalid input coordinates") }
                point = CGPoint(x: x, y: y)
            }
            try safePoint(point, reading: reading)
            try post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
            try safePoint(point, reading: reading)
            if method == "click" {
                try pair(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
            } else {
                guard let delta = request["delta"] as? Int32, delta != 0, abs(delta) <= 10 else { throw DesktopFailure("Invalid scroll delta") }
                try post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: delta * 3, wheel2: 0, wheel3: 0))
            }
        }
        try monitor.check(lease, window: window, intervention: intervention)
        return ["sent": true, "window": String(window.id), "pid": window.pid, "requiresObservation": true, "controlActive": true]
    }
}
