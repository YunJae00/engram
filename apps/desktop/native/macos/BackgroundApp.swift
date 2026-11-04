import AppKit
import ApplicationServices

func restoreForeground(_ previous: NSRunningApplication?) -> Bool {
    guard let previous = previous, !previous.isTerminated else { return false }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == previous.processIdentifier { return false }
    return previous.activate(options: []) && NSWorkspace.shared.frontmostApplication?.processIdentifier == previous.processIdentifier
}
func foregroundReceipt(_ previous: NSRunningApplication?) -> [String: Any] {
    let changed = previous?.processIdentifier != NSWorkspace.shared.frontmostApplication?.processIdentifier
    return ["foregroundChanged": changed, "foregroundRestored": changed && restoreForeground(previous)]
}
extension DesktopHost {
    func openApp(_ request: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) throws {
        let id = try text(request, "app", limit: 64)
        guard let entry = catalog().first(where: { $0.id == id }), !monitor.state().escaped else { throw DesktopFailure("Choose an app from the catalog") }
        let previous = NSWorkspace.shared.frontmostApplication
        func frontInfo() -> [String: Any] {
            let front = NSWorkspace.shared.frontmostApplication
            let element = AXUIElementCreateApplication(front?.processIdentifier ?? 0)
            let raw = attribute(element, kAXFocusedWindowAttribute)
            let window = raw.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? unsafeBitCast($0, to: AXUIElement.self) : nil }
            return ["pid": front?.processIdentifier ?? 0, "title": window.map { stringAttribute($0, kAXTitleAttribute) } ?? ""]
        }
        let before = frontInfo()
        var alreadyOpen = false
        let finish: (NSRunningApplication?, Error?) -> Void = { app, error in
            if let error = error { completion(.failure(error)); return }
            var result: [String: Any] = alreadyOpen ? ["foregroundChanged": false, "foregroundRestored": false] : foregroundReceipt(previous)
            result.merge(["requested": true, "name": entry.name, "requiresObservation": true,
                          "alreadyOpen": alreadyOpen, "title": entry.name, "before": before, "after": frontInfo(),
                          "previousFrontPid": previous?.processIdentifier ?? 0, "pid": app?.processIdentifier ?? 0]) { _, next in next }
            completion(.success(result))
        }
        if let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL == entry.url }) {
            alreadyOpen = true
            finish(running, nil)
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = false
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: entry.url, configuration: configuration) { app, error in
            DispatchQueue.main.async { finish(app, error) }
        }
    }
}
