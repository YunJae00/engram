import AppKit
import ApplicationServices

// A results page exceeds one scan's control cap inside the guide sidebar; the
// video list is a later sibling, so later children are tried first.
func firstWatchLink(_ target: Target) throws -> Control? {
    func isWatch(_ control: Control) -> Bool {
        control.role == "AXLink" && !control.secret && control.name.count > 8 &&
            (((attribute(control.element, kAXURLAttribute) as? URL)?.absoluteString ?? stringAttribute(control.element, kAXURLAttribute)).contains("/watch?"))
    }
    var scans = 0
    func find(_ root: AXUIElement?, depth: Int) throws -> Control? {
        guard scans < 40, depth < 12 else { return nil }
        scans += 1
        let part = try scan(target, root: root)
        if let link = part.controls.first(where: isWatch) { return link }
        if part.complete { return nil }
        for child in try scan(target, root: root, skeleton: true).controls.filter({ $0.depth == 1 }).reversed() {
            if let link = try find(child.element, depth: depth + 1) { return link }
        }
        return nil
    }
    return try find(nil, depth: 0)
}

@main struct BackgroundProbe {
    static func frontmost() -> [String: Any] {
        let app = NSWorkspace.shared.frontmostApplication
        return ["pid": app?.processIdentifier ?? 0, "bundleIdentifier": app?.bundleIdentifier ?? "", "name": app?.localizedName ?? ""]
    }
    static func windows(_ pid: pid_t) -> [[String: Any]] {
        (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []).filter {
            ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 && !(($0[kCGWindowName as String] as? String) ?? "").isEmpty
        }
    }
    static func title(_ id: CGWindowID, pid: pid_t) -> String {
        windows(pid).first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }?[kCGWindowName as String] as? String ?? ""
    }
    static func main() {
        NSApplication.shared.setActivationPolicy(.accessory)
        let host = DesktopHost()
        let before = frontmost()
        var result: [String: Any] = ["frontmostApplicationBefore": before, "path": "production backgroundText + backgroundPress (AX selection, typed keys, focus-key)"]
        do {
            guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]),
                  let info = windows(pid).first, let number = info[kCGWindowNumber as String] as? NSNumber else {
                throw DesktopFailure("Pass the background YouTube PID with a named window")
            }
            let id = number.uint32Value
            try host.monitor.start()
            let target = try resolveWindow(id, pid: pid)
            guard !target.foreground, target.title.contains("YouTube") else { throw DesktopFailure("Choose the background YouTube PWA") }
            let snapshot = try scan(target)
            guard let field = snapshot.controls.first(where: { $0.role == kAXComboBoxRole && $0.settable && !$0.secret }) else {
                throw DesktopFailure("No YouTube search field exposed")
            }
            let version = host.monitor.inputVersion(pid)
            let value = field.value == "jazz piano" ? "relaxing music" : "jazz piano"
            result["window"] = String(id)
            result["pid"] = pid
            result["fieldBefore"] = field.value
            try host.backgroundText(field, value: value, window: target, inputVersion: version)
            let how = "typed"
            usleep(600_000)
            let exact = field.value == value
            result["set"] = ["how": how, "landed": exact, "exact": exact, "value": field.value]
            guard exact else { throw DesktopFailure("Field replacement was not exact") }
            let after = try scan(target)
            guard let button = after.controls.first(where: { $0.role == kAXButtonRole && ["Search", "검색"].contains($0.name) && !$0.secret }) else {
                throw DesktopFailure("No YouTube search button exposed")
            }
            let searchBefore = title(id, pid: pid)
            let pressHow = try host.backgroundPress(button, window: target, inputVersion: version)
            var focusedElement: CFTypeRef?
            let focusStatus = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute as CFString, &focusedElement)
            result["searchFocus"] = ["applicationFocusedElementStatus": focusStatus.rawValue, "targetFocused": attribute(button.element, kAXFocusedAttribute) as? Bool ?? false]
            for _ in 0..<30 {
                if title(id, pid: pid).contains(value) { break }
                usleep(200_000)
            }
            let searchTitle = title(id, pid: pid)
            result["search"] = ["how": pressHow, "before": searchBefore, "after": searchTitle, "queryObserved": searchTitle.contains(value)]
            guard searchTitle.contains(value), searchTitle != searchBefore else { throw DesktopFailure("Search navigation was not observed") }
            usleep(1_000_000)
            guard let link = try firstWatchLink(target) else { throw DesktopFailure("No first video link exposed") }
            let linkHow = try host.backgroundPress(link, window: target, inputVersion: version)
            for _ in 0..<30 {
                if title(id, pid: pid) != searchTitle { break }
                usleep(200_000)
            }
            let videoTitle = title(id, pid: pid)
            result["video"] = ["how": linkHow, "link": link.name, "before": searchTitle, "after": videoTitle, "titleChanged": !videoTitle.isEmpty && videoTitle != searchTitle]
            guard !videoTitle.isEmpty, videoTitle != searchTitle else { throw DesktopFailure("Video link navigation was not observed") }
            guard pressHow == "focus-key", linkHow == "focus-key" else { throw DesktopFailure("Search and video must both use focus-key") }
            result["passed"] = true
        } catch { result["error"] = String(describing: error); result["passed"] = false }
        let after = frontmost()
        let identical = NSDictionary(dictionary: before).isEqual(to: after)
        result["frontmostApplicationAfter"] = after
        result["frontmostIdentical"] = identical
        if !identical { result["passed"] = false }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
        if result["passed"] as? Bool != true { exit(1) }
    }
}
