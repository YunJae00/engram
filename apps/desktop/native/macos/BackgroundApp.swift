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
        let appPath = entry.url.resolvingSymlinksInPath().path
        let alreadyOpen = NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.resolvingSymlinksInPath().path == appPath }
        let started = ProcessInfo.processInfo.systemUptime
        var launched: NSRunningApplication?
        var launchFinished = false
        var launchError: Error?
        var changed = false
        var cycles = 0
        var hiddenMs = 0.0
        var firstFlashMs: Double?
        var foregroundSince: Double?
        var lastActivation = started
        var lastSample = started
        var hidden: NSRunningApplication?
        var unhiddenAt: Double?
        func hasWindow(_ pid: pid_t) -> Bool {
            let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
            return windows.contains { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
        }
        // Start watching before the launch callback: PWAs can activate before it arrives.
        let timer = Timer(timeInterval: 0.02, repeats: true) { timer in
            let now = ProcessInfo.processInfo.systemUptime
            let front = NSWorkspace.shared.frontmostApplication
            let targetFront = front != nil && (front?.processIdentifier == launched?.processIdentifier || front?.bundleURL?.resolvingSymlinksInPath().path == appPath)
            if targetFront {
                changed = true
                lastActivation = now
                if foregroundSince == nil { foregroundSince = lastSample }
                if cycles < 3, let front = front, hidden?.processIdentifier != front.processIdentifier {
                    _ = front.hide()
                    cycles += 1
                    hidden = front
                    launched = front
                    unhiddenAt = nil
                }
            } else if let since = foregroundSince {
                let duration = (now - since) * 1000
                hiddenMs += duration
                if firstFlashMs == nil { firstFlashMs = duration }
                foregroundSince = nil
            }
            lastSample = now
            let windowVerified = launched.map { hasWindow($0.processIdentifier) } ?? false
            if let app = hidden, windowVerified && now - lastActivation >= 1 {
                app.unhide()
                hidden = nil
                unhiddenAt = now
            }
            let settled = windowVerified && hidden == nil && now - (unhiddenAt ?? started) >= 0.5 && now - started >= 3
            guard (launchFinished && (launchError != nil || settled)) || now - started >= 6 else { return }
            timer.invalidate()
            hidden?.unhide()
            if let since = foregroundSince {
                let duration = (now - since) * 1000
                hiddenMs += duration
                if firstFlashMs == nil { firstFlashMs = duration }
            }
            if previous?.processIdentifier != launched?.processIdentifier,
               previous?.bundleURL?.resolvingSymlinksInPath().path != appPath,
               NSWorkspace.shared.frontmostApplication?.processIdentifier != previous?.processIdentifier { _ = restoreForeground(previous) }
            if let error = launchError { completion(.failure(error)); return }
            let restored = NSWorkspace.shared.frontmostApplication?.processIdentifier == previous?.processIdentifier
            completion(.success(["requested": true, "opened": true, "name": entry.name, "requiresObservation": true,
                "alreadyOpen": alreadyOpen, "title": entry.name, "before": before, "after": frontInfo(),
                "previousFrontPid": previous?.processIdentifier ?? 0, "pid": launched?.processIdentifier ?? 0,
                "windowVerified": windowVerified, "foregroundChanged": changed, "foregroundRestored": restored,
                "hiddenMs": Int(hiddenMs.rounded()), "firstFlashMs": Int((firstFlashMs ?? 0).rounded()), "cycles": cycles]))
        }
        RunLoop.main.add(timer, forMode: .common)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = false
        configuration.addsToRecentItems = false
        // Reopen running apps too: a process without a window needs a reopen event.
        NSWorkspace.shared.openApplication(at: entry.url, configuration: configuration) { app, error in
            DispatchQueue.main.async { launched = app; launchError = error; launchFinished = true }
        }
    }
}
