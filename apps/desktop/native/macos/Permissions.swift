import AppKit
import ApplicationServices
import IOKit.hid

func permissionState() -> [String: Bool] {
    ["accessibility": AXIsProcessTrusted(),
     "screenRecording": CGPreflightScreenCaptureAccess(),
     "inputMonitoring": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted]
}

// Wraps InputMonitor so a missing event tap leaves the helper answering instead of exiting.
final class HostMonitor: @unchecked Sendable {
    let input = InputMonitor()
    private var running = false
    var marker: Int64 { input.marker }
    var revoked: ((String, String) -> Void)? { get { input.revoked } set { input.revoked = newValue } }
    func state() -> (intervention: UInt64, idle: Int, escaped: Bool, lease: String?) { input.state() }
    func inputVersion(_ pid: pid_t) -> UInt64 { input.inputVersion(pid) }
    func stop(_ reason: String) { input.stop(reason) }
    func bind(_ window: Target, grant: String, intervention: UInt64) throws -> String { try input.bind(window, grant: grant, intervention: intervention) }
    func check(_ id: String, window: Target, intervention: UInt64? = nil) throws { try input.check(id, window: window, intervention: intervention) }
    func post(_ event: CGEvent, lease: String, window: Target, intervention: UInt64) throws { try input.post(event, lease: lease, window: window, intervention: intervention) }
    func start() { try? ensureRunning() }
    func ensureRunning() throws {
        if running { return }
        guard permissionState()["inputMonitoring"] == true else { throw DesktopFailure("Allow Engram in System Settings → Privacy & Security → Input Monitoring") }
        do { try input.start(); running = true } catch { throw DesktopFailure("Input monitoring could not start. Quit and reopen Engram") }
    }
}
