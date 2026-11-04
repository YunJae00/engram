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
func chromiumFamily(url: URL) -> Bool {
    guard let bundle = Bundle(url: url.resolvingSymlinksInPath()) else { return false }
    if bundle.executableURL?.lastPathComponent == "app_mode_loader" { return true }
    let id = bundle.bundleIdentifier ?? ""
    if ["com.google.Chrome", "org.chromium", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser", "com.vivaldi", "com.operasoftware"].contains(where: { id.hasPrefix($0) }) { return true }
    let frameworks = (try? FileManager.default.contentsOfDirectory(atPath: url.appendingPathComponent("Contents/Frameworks").path)) ?? []
    return frameworks.contains { name in name.hasSuffix(".framework") && ["Chrome", "Chromium", "Electron"].contains(where: { name.contains($0) }) }
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
        func mainWindow(_ pid: pid_t) -> [String: Any]? {
            let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
            let main = mainWindowID(pid)
            let candidates = windows.filter { item in
                guard (item[kCGWindowOwnerPID as String] as? Int32) == pid, (item[kCGWindowLayer as String] as? Int) == 0,
                      let raw = item[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw) else { return false }
                return bounds.width > 100 && bounds.height > 100
            }
            return candidates.first { ($0[kCGWindowNumber as String] as? UInt32) == main } ?? candidates.max { lhs, rhs in
                func area(_ item: [String: Any]) -> Double {
                    guard let raw = item[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw) else { return 0 }
                    return bounds.width * bounds.height
                }
                return area(lhs) < area(rhs)
            }
        }
        let existing = NSWorkspace.shared.runningApplications.first { $0.bundleURL?.resolvingSymlinksInPath().path == appPath }
        let alreadyOpen = existing.map { mainWindow($0.processIdentifier) != nil } ?? false
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
        var userUnhidden = false
        var hiddenInput: UInt64?
        var hiddenConfirmed = false
        var probeStarted: Double?
        var probeTimer: Timer?
        var drawsHidden = false
        let chromium = chromiumFamily(url: entry.url)
        var hiddenFallback = chromium
        var drawnSamples = 0
        // Start watching before the launch callback: PWAs can activate before it arrives.
        let timer = Timer(timeInterval: 0.02, repeats: true) { timer in
            let now = ProcessInfo.processInfo.systemUptime
            let front = NSWorkspace.shared.frontmostApplication
            let targetFront = front != nil && (front?.processIdentifier == launched?.processIdentifier || front?.bundleURL?.resolvingSymlinksInPath().path == appPath)
            if hidden?.isHidden == true { hiddenConfirmed = true }
            if hiddenConfirmed, let app = hidden, !app.isHidden, let version = hiddenInput, self.monitor.state().intervention != version {
                userUnhidden = true
                self.hiddenApps.remove(app.processIdentifier)
                hidden = nil
            }
            if targetFront {
                changed = true
                lastActivation = now
                if foregroundSince == nil { foregroundSince = lastSample }
                if !userUnhidden { _ = restoreForeground(previous) }
                if chromium, cycles < 3, hidden == nil, let front = front {
                    _ = front.hide()
                    cycles += 1
                    hidden = front
                    launched = front
                }
                if !alreadyOpen, !userUnhidden, !hiddenFallback, let front = front, !front.isHidden {
                    _ = front.hide()
                    cycles += 1
                    hidden = front
                    self.hiddenApps.insert(front.processIdentifier)
                    hiddenInput = self.monitor.state().intervention
                    _ = restoreForeground(previous)
                    launched = front
                }
            } else if let since = foregroundSince {
                let duration = (now - since) * 1000
                hiddenMs += duration
                if firstFlashMs == nil { firstFlashMs = duration }
                foregroundSince = nil
            }
            lastSample = now
            let windowVerified = launched.map { mainWindow($0.processIdentifier) != nil } ?? false
            if chromium, let app = hidden, windowVerified && now - lastActivation >= 1 {
                _ = app.unhide()
                hidden = nil
                _ = restoreForeground(previous)
            }
            if !alreadyOpen, !userUnhidden, !hiddenFallback, hidden == nil, let app = launched, windowVerified {
                _ = app.hide()
                hidden = app
                self.hiddenApps.insert(app.processIdentifier)
                hiddenInput = self.monitor.state().intervention
            }
            if !alreadyOpen, !userUnhidden, !hiddenFallback, !drawsHidden, let app = hidden, app.isHidden, windowVerified {
                if probeStarted == nil {
                    probeStarted = now
                    let probe = Timer(timeInterval: 0.05, repeats: true) { timer in
                        guard let target = hidden, target.isHidden, !userUnhidden, !hiddenFallback else { timer.invalidate(); return }
                        let id = mainWindow(target.processIdentifier)?[kCGWindowNumber as String] as? UInt32
                        let image = id.flatMap { hiddenProbeImage($0, until: min(probeStarted! + 2, started + 6)) }
                        drawnSamples = image.map { previewHasDrawn($0) } == true ? drawnSamples + 1 : 0
                        drawsHidden = drawnSamples >= 2
                        if drawsHidden { timer.invalidate() }
                    }
                    probeTimer = probe
                    RunLoop.main.add(probe, forMode: .common)
                }
                if !drawsHidden && (now - probeStarted! >= 2 || now - started >= 6) {
                    hiddenFallback = true
                    self.hiddenApps.remove(app.processIdentifier)
                    _ = app.unhide()
                    hidden = nil
                    _ = restoreForeground(previous)
                }
            }
            let settled = windowVerified && (!chromium || hidden == nil) && (alreadyOpen || userUnhidden || hiddenFallback || (drawsHidden && launched?.isHidden == true)) && now - lastActivation >= 1 && now - started >= 3
            guard (launchFinished && (launchError != nil || settled)) || now - started >= 6 else { return }
            timer.invalidate()
            probeTimer?.invalidate()
            if chromium { _ = hidden?.unhide(); hidden = nil }
            if let since = foregroundSince {
                let duration = (now - since) * 1000
                hiddenMs += duration
                if firstFlashMs == nil { firstFlashMs = duration }
            }
            if !userUnhidden, previous?.processIdentifier != launched?.processIdentifier,
               previous?.bundleURL?.resolvingSymlinksInPath().path != appPath,
               NSWorkspace.shared.frontmostApplication?.processIdentifier != previous?.processIdentifier { _ = restoreForeground(previous) }
            if let error = launchError { completion(.failure(error)); return }
            let restored = NSWorkspace.shared.frontmostApplication?.processIdentifier == previous?.processIdentifier
            completion(.success(["requested": true, "opened": true, "name": entry.name, "requiresObservation": true,
                "hiddenFallback": chromium ? "chromium-does-not-draw-hidden" : hiddenFallback ? "no-draw-while-hidden" : "",
                "hidden": !alreadyOpen && !userUnhidden && !hiddenFallback && (launched?.isHidden ?? false), "alreadyOpen": alreadyOpen, "title": entry.name, "before": before, "after": frontInfo(),
                "previousFrontPid": previous?.processIdentifier ?? 0, "pid": launched?.processIdentifier ?? 0,
                "window": launched.flatMap { mainWindow($0.processIdentifier)?[kCGWindowNumber as String] as? UInt32 }.map { String($0) } ?? "",
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
