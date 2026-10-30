import AppKit
import ApplicationServices

final class DesktopHost {
    let monitor = InputMonitor()
    let frame = ApplicationFrame()
    var snapshots: [String: Snapshot] = [:]
    var documents: [String: LiveRead] = [:]
    private var prepared: (String, UInt64, CGWindowID)?
    func text(_ request: [String: Any], _ key: String, limit: Int = 2000) throws -> String {
        guard let value = request[key] as? String, value.count <= limit, !value.contains("\0") else { throw DesktopFailure("Invalid \(key)") }
        return value
    }
    func target(_ request: [String: Any]) throws -> Target {
        guard let id = UInt32(try text(request, "window", limit: 20)), let pid = request["pid"] as? Int32, pid >= 0 else { throw DesktopFailure("Choose a valid app window") }
        return try resolveWindow(id, pid: pid)
    }
    func snapshot(_ request: [String: Any], window: Target) throws -> Snapshot {
        let id = try text(request, "snapshot", limit: 100)
        guard let value = snapshots[id] else { throw DesktopFailure("Read the app before acting") }
        try requireCurrent(value, target: window)
        return value
    }
    func control(_ snapshot: Snapshot, id: String) throws -> Control {
        guard let value = snapshot.controls.first(where: { $0.id == id }), value.enabled, !value.secret else { throw DesktopFailure("Control is unavailable or protected") }
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].map { stringAttribute(value.element, $0) }.first { !$0.isEmpty } ?? ""
        guard stringAttribute(value.element, kAXRoleAttribute) == value.role,
              stringAttribute(value.element, kAXSubroleAttribute) != kAXSecureTextFieldSubrole,
              !sensitiveControl(stringAttribute(value.element, kAXRoleAttribute), stringAttribute(value.element, kAXSubroleAttribute), label), String(label.prefix(500)) == value.name,
              (try? elementBounds(value.element)) == value.bounds else { throw DesktopFailure("Control changed. Read the app again") }
        return value
    }
    func state(_ window: Target) -> [String: Any] {
        ["foreground": window.foreground, "idleMs": monitor.state().idle, "minimized": window.minimized]
    }
    func observe(_ window: Target, quiet: Bool, focusedOnly: Bool = false) throws -> [String: Any] {
        let result = try scan(window)
        snapshots = snapshots.filter { Date().timeIntervalSince($0.value.at) < 30 }
        if snapshots.count >= 16 { snapshots.removeAll() }
        snapshots[result.id] = result
        if quiet {
            return ["window": String(window.id), "pid": window.pid, "title": window.title, "snapshot": result.id,
                "controls": result.controls.map { node -> [String: Any] in
                    ["id": node.id, "type": node.role, "name": node.name, "value": node.value, "enabled": node.enabled,
                     "offscreen": node.bounds.map { !$0.intersects(result.bounds) } ?? true,
                     "focused": attribute(node.element, kAXFocusedAttribute) as? Bool ?? false, "secret": node.secret,
                     "can": ["set": node.settable, "press": node.pressable, "text": !node.secret]]
                }, "texts": result.controls.filter { !$0.secret && !$0.value.isEmpty }.map { ["id": $0.id, "text": $0.value] },
                "skippedControls": result.complete ? 0 : 1, "skippedTexts": result.complete ? 0 : 1, "ms": 0, "state": state(window)]
        }
        let focus = try? focused(result, editable: false)
        let protected = result.controls.filter { $0.secret }.compactMap { $0.bounds }
        return ["snapshot": result.id, "scope": focusedOnly ? "focus" : "window", "bounds": rectangle(result.bounds), "captureBounds": rectangle(result.bounds),
            "focusedEditable": focus?.settable ?? false, "focusedControl": focus.map { String(CFHash($0.element)) } ?? "",
            "protectedBounds": protected.map(rectangle), "truncated": !result.complete, "captureSafe": result.complete,
            "nodes": result.controls.filter { !focusedOnly || (focus != nil && CFEqual($0.element, focus!.element)) }.compactMap { node -> [String: Any]? in
                guard let bounds = node.bounds else { return nil }
                return ["id": node.id, "runtimeId": String(CFHash(node.element)), "name": node.name, "controlType": node.role, "value": node.value,
                        "enabled": node.enabled, "password": node.secret, "bounds": rectangle(bounds),
                        "offscreen": !bounds.intersects(result.bounds), "actions": ["type": node.settable, "replace": node.settable]]
            }]
    }
    func receive(_ request: [String: Any]) throws -> Any {
        let method = try text(request, "method", limit: 32)
        if method == "stop" { monitor.stop("Computer control stopped"); frame.hide(); snapshots.removeAll(); documents.removeAll(); prepared = nil; return ["stopped": true] }
        if method == "inputState" {
            let current = monitor.state()
            return ["intervention": String(current.intervention), "idleMs": current.idle, "escaped": current.escaped, "working": current.lease != nil]
        }
        if method == "listApps" { return catalog().map { ["id": $0.id, "name": $0.name] } }
        if method == "openApp" {
            let id = try text(request, "app", limit: 64)
            guard let entry = catalog().first(where: { $0.id == id }), !monitor.state().escaped else { throw DesktopFailure("Choose an app from the catalog") }
            guard NSWorkspace.shared.open(entry.url) else { throw DesktopFailure("The app could not open") }
            return ["requested": true, "name": entry.name, "requiresObservation": true]
        }
        if method == "listWindows" {
            let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            return ["windows": windows.compactMap { item -> [String: Any]? in
                guard item[kCGWindowLayer as String] as? Int == 0, let id = item[kCGWindowNumber as String] as? UInt32,
                      let window = try? resolveWindow(id, pid: 0) else { return nil }
                return ["window": String(id), "pid": window.pid, "title": window.title, "foreground": window.foreground, "minimized": window.minimized]
            }]
        }
        let window = try target(request)
        if let lease = request["lease"] as? String { try monitor.check(lease, window: window) }
        if method == "applicationFrameHide" { frame.hide(); return ["hidden": true] }
        if method == "applicationFrame" { return ["window": try frame.show(window)] }
        if ["documentRead", "documentEdit", "documentCompose"].contains(method) { return try document(request, method: method, window: window) }
        if method == "capture" { return try capture(request, window: window) }
        if ["click", "type", "replace", "key", "scroll"].contains(method) { return try act(request, method: method, window: window) }
        if method == "inspectWindow" || method == "activateWindow" {
            if method == "activateWindow" {
                guard !monitor.state().escaped else { throw DesktopFailure("Escape pressed") }
                AXUIElementSetAttributeValue(window.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                NSRunningApplication(processIdentifier: window.pid)?.activate(options: [])
                guard AXUIElementPerformAction(window.element, kAXRaiseAction as CFString) == .success else { throw DesktopFailure("The window could not be activated") }
            }
            return ["window": String(window.id), "pid": window.pid, "title": window.title, "minimized": window.minimized,
                    "foreground": window.foreground, "bounds": rectangle(try window.bounds), "visualBounds": rectangle(try window.bounds)]
        }
        if method == "quietState" { return state(window) }
        if method == "quietScan" || method == "observe" {
            if let focused = request["focusedOnly"], !(focused is Bool) { throw DesktopFailure("Invalid observation scope") }
            if request["focusedOnly"] as? Bool == true && request["lease"] == nil { throw DesktopFailure("Focused observation requires computer control") }
            return try observe(window, quiet: method == "quietScan", focusedOnly: request["focusedOnly"] as? Bool == true)
        }
        if method == "quietRead" {
            let reading: Snapshot
            if request["snapshot"] != nil { reading = try snapshot(request, window: window) } else { reading = try scan(window) }
            let selected = request["control"] as? String
            let value = reading.controls.filter { !$0.secret && (selected == nil || $0.id == selected) }.map { $0.value.isEmpty ? $0.name : $0.value }.joined(separator: "\n")
            return ["text": String(value.suffix(20000)), "chars": value.count, "headClipped": value.count > 20000]
        }
        if method == "quietSet" || method == "quietPress" {
            let before = monitor.state()
            guard !before.escaped, !(window.foreground && before.idle < 4000) else { throw DesktopFailure("The person is using this app") }
            let reading = try snapshot(request, window: window)
            let node = try control(reading, id: text(request, "control", limit: 32))
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            defer { snapshots.removeValue(forKey: reading.id) }
            if method == "quietSet" {
                guard node.settable else { throw DesktopFailure("This control does not take text") }
                let value = try text(request, "text")
                if let expected = request["expected"] as? String, expected != node.value { throw DesktopFailure("The field changed. Read it again") }
                guard monitor.state().intervention == before.intervention else { throw DesktopFailure("User input changed") }
                guard AXUIElementSetAttributeValue(node.element, kAXValueAttribute as CFString, value as CFString) == .success else { throw DesktopFailure("This control does not take text") }
                let actual = node.value
                return ["landed": actual == value, "exact": actual == value, "value": actual, "ms": 0, "control": node.id, "foregroundChanged": front != NSWorkspace.shared.frontmostApplication?.processIdentifier]
            }
            guard node.pressable else { throw DesktopFailure("This control cannot be pressed") }
            guard monitor.state().intervention == before.intervention else { throw DesktopFailure("User input changed") }
            guard AXUIElementPerformAction(node.element, kAXPressAction as CFString) == .success else { throw DesktopFailure("This control cannot be pressed") }
            return ["pressed": node.name, "control": node.id, "foregroundChanged": front != NSWorkspace.shared.frontmostApplication?.processIdentifier]
        }
        if method == "prepare" {
            let grant = try text(request, "grant", limit: 64)
            guard UUID(uuidString: grant) != nil, !monitor.state().escaped else { throw DesktopFailure("Fresh control approval is required") }
            let current = monitor.state().intervention
            NSRunningApplication(processIdentifier: window.pid)?.activate(options: [])
            AXUIElementPerformAction(window.element, kAXRaiseAction as CFString)
            prepared = (grant, current, window.id)
            return ["intervention": String(current)]
        }
        if method == "bind" {
            let grant = try text(request, "grant", limit: 64)
            guard let prior = prepared, prior.0 == grant, prior.2 == window.id,
                  String(prior.1) == (try text(request, "intervention", limit: 20)) else { throw DesktopFailure("Control preparation changed") }
            prepared = nil
            let lease = try monitor.bind(window, grant: grant, intervention: prior.1)
            return ["lease": lease, "window": String(window.id), "pid": window.pid, "expiresInMs": 600000]
        }
        if method == "work" || method == "idle" {
            try monitor.check(text(request, "lease", limit: 100), window: window)
            return ["working": method == "work"]
        }
        throw DesktopFailure("Unsupported desktop method: \(method)")
    }
}
