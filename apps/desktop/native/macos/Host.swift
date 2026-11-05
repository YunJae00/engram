import AppKit
import ApplicationServices

final class DesktopHost {
    var hiddenApps = Set<pid_t>()
    func restoreHiddenApps() {
        for pid in hiddenApps { NSRunningApplication(processIdentifier: pid)?.unhide() }
        hiddenApps.removeAll()
    }
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
        let id = id.first == "c" || id.first == "e" ? String(id.dropFirst()) : id
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
    func observe(_ window: Target, quiet: Bool, focusedOnly: Bool = false, find: String? = nil, root: AXUIElement? = nil, skeleton: Bool = false) throws -> [String: Any] {
        let result = try scan(window, root: root, skeleton: skeleton, find: find)
        snapshots = snapshots.filter { Date().timeIntervalSince($0.value.at) < 30 }
        if snapshots.count >= 16, let oldest = snapshots.min(by: { $0.value.at < $1.value.at })?.key { snapshots.removeValue(forKey: oldest) }
        snapshots[result.id] = result
        if quiet {
            let matches = result.controls.filter { find == nil || $0.name.localizedCaseInsensitiveContains(find!) || $0.value.localizedCaseInsensitiveContains(find!) }
            return ["window": String(window.id), "pid": window.pid, "title": window.title, "snapshot": result.id,
                "bounds": rectangle(result.bounds), "mode": skeleton ? "skeleton" : "full", "truncated": !result.complete,
                "searchComplete": result.complete, "controls": matches.map { node -> [String: Any] in
                    ["depth": node.depth, "childCount": node.childCount, "subtreeTruncated": node.subtreeTruncated, "id": "c" + node.id, "type": node.role, "name": node.name, "value": node.value, "enabled": node.enabled,
                     "offscreen": node.bounds.map { !$0.intersects(result.bounds) } ?? true,
                     "focused": attribute(node.element, kAXFocusedAttribute) as? Bool ?? false, "secret": node.secret,
                     "can": ["set": node.settable, "press": node.pressable, "text": !node.secret]]
                }, "texts": matches.filter { !$0.secret && !$0.value.isEmpty }.map { ["id": "c" + $0.id, "text": $0.value] },
                "skippedControls": result.complete ? 0 : 1, "skippedTexts": result.complete ? 0 : 1, "ms": 0, "state": state(window)]
        }
        let focus = try? focused(result, editable: false)
        let protected = result.controls.filter { $0.secret }.compactMap { $0.bounds }
        return ["mode": skeleton ? "skeleton" : "full", "snapshot": result.id, "scope": focusedOnly ? "focus" : "window", "bounds": rectangle(result.bounds), "captureBounds": rectangle(result.bounds),
            "focusedEditable": focus?.settable ?? false, "focusedControl": focus.map { String(CFHash($0.element)) } ?? "",
            "protectedBounds": protected.map(rectangle), "truncated": !result.complete, "captureSafe": result.captureSafe,
            "nodes": result.controls.filter { !focusedOnly || (focus != nil && CFEqual($0.element, focus!.element)) }.compactMap { node -> [String: Any]? in
                guard let bounds = node.bounds else { return nil }
                return ["depth": node.depth, "childCount": node.childCount, "subtreeTruncated": node.subtreeTruncated, "id": "e" + node.id, "runtimeId": String(CFHash(node.element)), "name": node.name, "controlType": node.role, "value": node.value,
                        "enabled": node.enabled, "password": node.secret, "bounds": rectangle(bounds),
                        "offscreen": !bounds.intersects(result.bounds), "actions": ["click": node.pressable, "type": node.settable, "replace": node.settable]]
            }]
    }
    func receive(_ request: [String: Any]) throws -> Any {
        let method = try text(request, "method", limit: 32)
        if method == "stop" { monitor.stop("Computer control stopped"); frame.hide(); snapshots.removeAll(); documents.removeAll(); prepared = nil; return ["stopped": true] }
        if method == "inputState" {
            let current = monitor.state()
            return ["intervention": String(current.intervention), "idleMs": current.idle, "escaped": current.escaped, "working": current.lease != nil]
        }
        if method == "unhideApp" {
            guard let pid = request["pid"] as? Int32, pid > 0, let activate = request["activate"] as? Bool else { throw DesktopFailure("Choose a valid app") }
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return ["hidden": false] }
            hiddenApps.remove(pid)
            app.unhide()
            if activate { app.activate(options: []) }
            return ["hidden": app.isHidden]
        }
        if method == "listApps" { return catalog().map { ["id": $0.id, "name": $0.name, "aliases": $0.aliases] as [String: Any] } }
        if method == "listWindows" {
            guard AXIsProcessTrusted() else { throw DesktopFailure("Allow Engram in System Settings → Privacy & Security → Accessibility") }
            let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            return ["windows": windows.compactMap { item -> [String: Any]? in
                guard item[kCGWindowLayer as String] as? Int == 0, let id = item[kCGWindowNumber as String] as? UInt32 else { return nil }
                do {
                    let window = try resolveWindow(id, pid: 0)
                    return ["aliases": appAliases(url: NSRunningApplication(processIdentifier: window.pid)?.bundleURL), "window": String(id), "pid": window.pid, "bounds": rectangle(try window.bounds), "title": window.title, "foreground": window.foreground, "hidden": NSRunningApplication(processIdentifier: window.pid)?.isHidden ?? false, "minimized": window.minimized]
                } catch {
                    guard String(describing: error).hasPrefix("This application surface requires manual control"),
                          let pid = item[kCGWindowOwnerPID as String] as? Int32,
                          let app = NSRunningApplication(processIdentifier: pid) else { return nil }
                    return ["aliases": appAliases(url: app.bundleURL), "window": String(id), "pid": pid,
                            "title": app.localizedName ?? "App", "minimized": false, "protected": true, "barrier": String(describing: error)]
                }
            }]
        }
        let previous = NSWorkspace.shared.frontmostApplication
        let quiet = ["quietSet", "quietPress", "quietRead"].contains(method)
        defer { if quiet { _ = restoreForeground(previous) } }
        let window = try target(request)
        var foregroundRestored = false
        if let pid = request["restoreForegroundPid"] as? Int32, window.foreground {
            foregroundRestored = restoreForeground(NSRunningApplication(processIdentifier: pid))
        }
        if let lease = request["lease"] as? String { try monitor.check(lease, window: window) }
        if method == "applicationFrameHide" { frame.hide(); return ["hidden": true] }
        if method == "applicationFrame" { return ["window": try frame.show(window)] }
        if ["documentRead", "documentEdit", "documentCompose"].contains(method) { return try document(request, method: method, window: window) }
        if method == "capture" { return try capture(request, window: window) }
        if ["click", "type", "replace", "key", "scroll"].contains(method) { return try act(request, method: method, window: window) }
        if method == "inspectWindow" || method == "activateWindow" {
            if method == "inspectWindow" && request["unminimize"] as? Bool == true && window.minimized {
                guard AXUIElementSetAttributeValue(window.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success,
                      !window.minimized else { throw DesktopFailure("The window is minimized and cannot be shown in the preview card") }
            }
            if method == "activateWindow" {
                guard !monitor.state().escaped else { throw DesktopFailure("Escape pressed") }
                AXUIElementSetAttributeValue(window.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                NSRunningApplication(processIdentifier: window.pid)?.unhide()
                NSRunningApplication(processIdentifier: window.pid)?.activate(options: [])
                guard AXUIElementPerformAction(window.element, kAXRaiseAction as CFString) == .success else { throw DesktopFailure("The window could not be activated") }
            }
            return ["mainWindow": mainWindowID(window.pid).map { String($0) } ?? "", "window": String(window.id), "pid": window.pid, "title": window.title, "minimized": window.minimized,
                    "hidden": NSRunningApplication(processIdentifier: window.pid)?.isHidden ?? false, "foreground": window.foreground, "foregroundRestored": foregroundRestored, "bounds": rectangle(try window.bounds), "visualBounds": rectangle(try window.bounds)]
        }
        if method == "quietState" { return state(window) }
        if method == "quietScan" || method == "observe" {
            if let focused = request["focusedOnly"], !(focused is Bool) { throw DesktopFailure("Invalid observation scope") }
            if request["focusedOnly"] as? Bool == true && request["lease"] == nil { throw DesktopFailure("Focused observation requires computer control") }
            let mode = request["mode"] as? String ?? "full"
            guard mode == "full" || mode == "skeleton", request["mode"] == nil || request["mode"] is String,
                  (request["root"] == nil) == (request["snapshot"] == nil), !(mode == "skeleton" && request["root"] != nil) else { throw DesktopFailure("Invalid observation mode or root") }
            let root: AXUIElement?
            if request["root"] != nil { root = try control(snapshot(request, window: window), id: text(request, "root", limit: 32)).element }
            else { root = nil }
            return try observe(window, quiet: method == "quietScan", focusedOnly: request["focusedOnly"] as? Bool == true, find: request["find"] as? String, root: root, skeleton: mode == "skeleton")
        }
        if method == "quietRead" {
            let reading: Snapshot
            if request["snapshot"] != nil { reading = try snapshot(request, window: window) } else { reading = try scan(window) }
            let selected = (request["control"] as? String).map { $0.first == "c" ? String($0.dropFirst()) : $0 }
            let value = reading.controls.filter { !$0.secret && (selected == nil || $0.id == selected) }.map { $0.value.isEmpty ? $0.name : $0.value }.joined(separator: "\n")
            return ["text": String(value.suffix(20000)), "chars": value.count, "headClipped": value.count > 20000].merging(foregroundReceipt(previous)) { _, next in next }
        }
        if method == "quietSet" || method == "quietPress" {
            guard request["state"] == nil && request["action"] == nil else { throw DesktopFailure("Desired-state provider actions are not supported by this platform; no action was sent") }
            let before = monitor.state()
            let inputVersion = monitor.inputVersion(window.pid)
            guard !before.escaped, !(window.foreground && before.idle < 4000) else { throw DesktopFailure("The person is using this app") }
            let reading = try snapshot(request, window: window)
            let node = try control(reading, id: text(request, "control", limit: 32))
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            defer { snapshots.removeValue(forKey: reading.id) }
            if method == "quietSet" {
                guard node.settable else { throw DesktopFailure("This control does not take text") }
                let value = try text(request, "text")
                let existing = node.value
                if let expected = request["expected"] as? String {
                    guard expected == existing else { throw DesktopFailure("The field changed. Read it again") }
                } else if !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw DesktopFailure("The field already holds text. Pass its exact value as expected to replace it") }
                guard !monitor.state().escaped, monitor.inputVersion(window.pid) == inputVersion,
                      !(window.foreground && monitor.state().idle < 4000) else { throw DesktopFailure("The person is using this app") }
                let how: String
                do { how = try backgroundSet(node, value: value, window: window, inputVersion: inputVersion) }
                catch let error as DesktopFailure where error.description == "The app's key window is not this window" {
                    return ["landed": false, "exact": false, "value": node.value, "ms": 0, "message": error.description, "control": "c" + node.id].merging(foregroundReceipt(previous)) { _, next in next }
                }
                let actual = node.value
                return ["how": how, "message": actual == value ? "" : "The app did not take background text; its own search or field may need the person", "landed": actual == value, "exact": actual == value, "value": actual, "ms": 0, "control": "c" + node.id, "foregroundChanged": front != NSWorkspace.shared.frontmostApplication?.processIdentifier].merging(foregroundReceipt(previous)) { _, next in next }
            }
            if let key = request["key"] as? String {
                return try quietKey(key, node: node, window: window, inputVersion: inputVersion).merging(foregroundReceipt(previous)) { _, next in next }
            }
            guard node.pressable else { throw DesktopFailure("This control cannot be pressed") }
            guard !monitor.state().escaped, monitor.inputVersion(window.pid) == inputVersion,
                      !(window.foreground && monitor.state().idle < 4000) else { throw DesktopFailure("The person is using this app") }
            let how: String
            do { how = try backgroundPress(node, window: window, inputVersion: inputVersion) }
            catch let error as DesktopFailure where error.description == "The app's key window is not this window" {
                return ["landed": false, "pressed": "", "message": error.description, "control": "c" + node.id].merging(foregroundReceipt(previous)) { _, next in next }
            }
            return ["how": how, "pressed": node.name, "control": "c" + node.id, "foregroundChanged": front != NSWorkspace.shared.frontmostApplication?.processIdentifier].merging(foregroundReceipt(previous)) { _, next in next }
        }
        if method == "prepare" {
            let grant = try text(request, "grant", limit: 64)
            guard UUID(uuidString: grant) != nil, !monitor.state().escaped else { throw DesktopFailure("Fresh control approval is required") }
            let current = monitor.state().intervention
            NSRunningApplication(processIdentifier: window.pid)?.unhide()
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
