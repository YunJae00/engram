import AppKit
import ApplicationServices
import CryptoKit

struct DesktopFailure: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}
func elementBounds(_ element: AXUIElement) throws -> CGRect {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else {
        throw DesktopFailure("The app did not expose window geometry")
    }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
          [point.x, point.y, dimensions.width, dimensions.height].allSatisfy({ $0.isFinite }),
          dimensions.width > 0, dimensions.height > 0 else { throw DesktopFailure("Invalid window geometry") }
    return CGRect(origin: point, size: dimensions)
}
func rectangle(_ bounds: CGRect) -> [String: Double] {
    ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]
}
func sensitive(_ value: String) -> Bool {
    value.range(of: #"(?i)\b(sign[ -]?in|log[ -]?in|password|passkey|credential|authentication|verification code|security code|terminal|keychain|system settings|system preferences|security settings)\b|로그인|비밀번호|암호|인증"#, options: .regularExpression) != nil
}
func sensitiveReason(_ value: String) -> String {
    let pattern = #"(?i)sign[ -]?in|log[ -]?in|password|passkey|credential|authentication|verification code|security code|terminal|keychain|system settings|system preferences|security settings|로그인|비밀번호|암호|인증"#
    guard let range = value.range(of: pattern, options: .regularExpression) else { return "protected" }
    return String(value[range])
}
func protectedApplication(_ identifier: String) -> Bool {
    ["com.apple.systempreferences", "com.apple.securityagent", "com.apple.loginwindow"].contains(identifier.lowercased()) || sensitive(identifier)
}
func sensitiveControl(_ role: String, _ subrole: String, _ label: String) -> Bool {
    if subrole == kAXSecureTextFieldSubrole { return true }
    if role == kAXWindowRole { return sensitive(label) }
    if role == kAXStaticTextRole || role == kAXTextAreaRole { return false }
    return label.range(of: #"(?i)^(sign[ -]?in|log[ -]?in|password|passkey|credential|authentication|verification code|security code|로그인|비밀번호|암호|인증)$"#, options: .regularExpression) != nil
}
struct Target {
    let id: CGWindowID
    let pid: pid_t
    let element: AXUIElement
    let title: String
    var foreground: Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let focused = attribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute) else { return false }
        return CFEqual(focused, element)
    }
    var minimized: Bool { attribute(element, kAXMinimizedAttribute) as? Bool ?? false }
    var bounds: CGRect { get throws { try elementBounds(element) } }
}
func resolveWindow(_ id: CGWindowID, pid: pid_t) throws -> Target {
    guard AXIsProcessTrusted() else { throw DesktopFailure("Allow Engram in System Settings → Privacy & Security → Accessibility") }
    guard let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]],
          let info = windows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }), let owner = info[kCGWindowOwnerPID as String] as? Int32,
          owner > 0, owner != getpid(), owner != getppid(), pid == 0 || owner == pid,
          let application = NSRunningApplication(processIdentifier: owner),
          application.activationPolicy == .regular,
          let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: rawBounds) else { throw DesktopFailure("This window is unavailable or requires manual control") }
    if sensitive(application.localizedName ?? "") || protectedApplication(application.bundleIdentifier ?? "") {
        throw DesktopFailure("This application surface requires manual control (application: \(application.bundleIdentifier ?? "protected"))")
    }
    let app = AXUIElementCreateApplication(owner)
    AXUIElementSetMessagingTimeout(app, 1)
    guard let candidates = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { throw DesktopFailure("This app did not expose its windows") }
    let matches = candidates.filter { element in
        guard let rect = try? elementBounds(element) else { return false }
        return abs(rect.minX - bounds.minX) < 2 && abs(rect.minY - bounds.minY) < 2 && abs(rect.width - bounds.width) < 2 && abs(rect.height - bounds.height) < 2
    }
    guard matches.count == 1, let window = matches.first else { throw DesktopFailure("The window identity is ambiguous. Observe it again") }
    let title = stringAttribute(window, kAXTitleAttribute)
    guard !sensitive(title) else { throw DesktopFailure("This application surface requires manual control (window: \(sensitiveReason(title)))") }
    return Target(id: id, pid: owner, element: window, title: "\(title) — \(application.localizedName ?? "App")")
}
struct Control {
    let id: String
    var depth = 0
    var childCount = 0
    var subtreeTruncated = false
    let element: AXUIElement
    let role: String
    let name: String
    let secret: Bool
    let bounds: CGRect?
    let enabled: Bool
    let settable: Bool
    let pressable: Bool
    var value: String { secret ? "" : String(stringAttribute(element, kAXValueAttribute).prefix(20000)) }
}
struct Snapshot {
    let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let target: Target
    let bounds: CGRect
    let controls: [Control]
    let focus: AXUIElement?
    let complete: Bool
    let at = Date()
    var captureSafe: Bool { complete || !controls.contains { $0.secret } }
}
func transparentGroup(role: String, name: String, value: String, identifier: String, actionable: Bool) -> Bool {
    role == kAXGroupRole && name.isEmpty && value.isEmpty && identifier.isEmpty && !actionable
}
func scan(_ target: Target, root: AXUIElement? = nil, skeleton: Bool = false) throws -> Snapshot {
    let bounds = try target.bounds
    var stack = [(root ?? target.element, 0, false)], controls: [Control] = [], visited: [AXUIElement] = []
    let deadline = Date().addingTimeInterval(2)
    var complete = true
    while let (element, depth, inheritedSecret) = stack.popLast() {
        if Date() > deadline || controls.count >= 500 { complete = false; break }
        guard !visited.contains(where: { CFEqual($0, element) }) else { continue }
        visited.append(element)
        let role = stringAttribute(element, kAXRoleAttribute)
        let subrole = stringAttribute(element, kAXSubroleAttribute)
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].map { stringAttribute(element, $0) }.first { !$0.isEmpty } ?? ""
        let secret = inheritedSecret || sensitiveControl(role, subrole, label)
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        var actions: CFArray?
        let hasActions = AXUIElementCopyActionNames(element, &actions) == .success
        let press = hasActions && ((actions as? [String]) ?? []).contains(kAXPressAction)
        if secret && (try? elementBounds(element)) == nil { complete = false }
        let skip = hasActions && !secret && transparentGroup(role: role, name: label, value: stringAttribute(element, kAXValueAttribute),
            identifier: stringAttribute(element, kAXIdentifierAttribute), actionable: settable.boolValue || !((actions as? [String]) ?? []).isEmpty)
        if !skip { controls.append(Control(id: String(controls.count + 1), depth: depth, element: element, role: role, name: secret ? "Protected control" : String(label.prefix(500)), secret: secret, bounds: try? elementBounds(element), enabled: attribute(element, kAXEnabledAttribute) as? Bool ?? true, settable: settable.boolValue && !secret, pressable: (press || ((try? elementBounds(element)) != nil && ["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton"].contains(role))) && !secret)) }
        var rawChildren: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren)
        if status == .success, let children = rawChildren as? [AXUIElement] {
            if !skip { controls[controls.count - 1].childCount = children.count }
            if !skip && depth >= (skeleton ? 3 : 40) && !children.isEmpty {
                controls[controls.count - 1].subtreeTruncated = true
                complete = false
            } else { for child in children.reversed() { stack.append((child, depth + (skip ? 0 : 1), secret)) } }
        } else if status != .attributeUnsupported && status != .noValue { complete = false }
    }
    if !stack.isEmpty {
        for index in controls.indices where controls[index].childCount > 0 { controls[index].subtreeTruncated = true }
    }
    let rawFocus = attribute(AXUIElementCreateApplication(target.pid), kAXFocusedUIElementAttribute)
    let focus = rawFocus.flatMap { value -> AXUIElement? in CFGetTypeID(value) == AXUIElementGetTypeID() ? unsafeBitCast(value, to: AXUIElement.self) : nil }
    return Snapshot(target: target, bounds: bounds, controls: controls, focus: focus, complete: complete && root == nil)
}
func requireCurrent(_ snapshot: Snapshot, target: Target) throws {
    guard snapshot.target.id == target.id, snapshot.target.pid == target.pid,
          Date().timeIntervalSince(snapshot.at) < 30,
          CFEqual(snapshot.target.element, target.element), try target.bounds == snapshot.bounds else {
        throw DesktopFailure("The window changed. Read it again before acting")
    }
}
func catalog() -> [(id: String, name: String, url: URL, aliases: [String])] {
    var result: [(String, String, URL, [String])] = []
    for root in ["/Applications", "/System/Applications", "/System/Cryptexes/App/System/Applications", NSHomeDirectory() + "/Applications"] {
        guard let iterator = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { continue }
        for case let url as URL in iterator {
            if url.pathExtension == "app" {
                iterator.skipDescendants()
                guard let bundle = Bundle(url: url.resolvingSymlinksInPath()), let identity = bundle.bundleIdentifier else { continue }
                let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? url.deletingPathExtension().lastPathComponent
                if sensitive(name) || sensitive(identity) { continue }
                let id = SHA256.hash(data: Data(url.path.utf8)).map { String(format: "%02x", $0) }.joined()
                result.append((id, name, url, appAliases(url: url)))
                if result.count >= 4096 { return result }
            }
        }
    }
    return result
}

func appAliases(url: URL?) -> [String] {
    guard let url = url, let bundle = Bundle(url: url) else { return [] }
    var values = [bundle.bundleIdentifier ?? "", url.deletingPathExtension().lastPathComponent]
    for key in ["CFBundleDisplayName", "CFBundleName", "CFBundleExecutable"] {
        values.append(bundle.infoDictionary?[key] as? String ?? "")
        values.append(bundle.localizedInfoDictionary?[key] as? String ?? "")
    }
    for locale in bundle.localizations.prefix(64) {
        guard let path = bundle.path(forResource: "InfoPlist", ofType: "strings", inDirectory: nil, forLocalization: locale),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { continue }
        for key in ["CFBundleDisplayName", "CFBundleName"] { values.append(info[key] as? String ?? "") }
    }
    return Array(Set(values.filter { !$0.isEmpty }))
}
