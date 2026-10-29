import AppKit
import ApplicationServices

final class InputMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private var counter: UInt64 = 0
    private var lastInput = Date.distantPast
    private var escaped = false
    private var lease: String?
    private var expires = Date.distantPast
    private var target: (CGWindowID, pid_t)?
    private var used = Set<String>()
    private var tap: CFMachPort?
    let marker: Int64 = Int64.random(in: 1...Int64.max)
    var revoked: ((String, String) -> Void)?
    func state() -> (intervention: UInt64, idle: Int, escaped: Bool, lease: String?) {
        lock.lock(); defer { lock.unlock() }
        return (counter, min(86_400_000, Int(Date().timeIntervalSince(lastInput) * 1000)), escaped, lease)
    }
    func stop(_ reason: String) {
        lock.lock()
        let old = lease; lease = nil; target = nil
        lock.unlock()
        if let old = old { revoked?(old, reason) }
    }
    func bind(_ window: Target, grant: String, intervention: UInt64) throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard UUID(uuidString: grant) != nil, !used.contains(grant), used.count < 128,
              counter == intervention, !escaped, lease == nil else { throw DesktopFailure("Control approval expired, was interrupted, or has already been used") }
        used.insert(grant)
        let id = UUID().uuidString
        lease = id; target = (window.id, window.pid); expires = Date().addingTimeInterval(600)
        return id
    }
    func check(_ id: String, window: Target, intervention: UInt64? = nil) throws {
        lock.lock(); defer { lock.unlock() }
        guard lease == id, target?.0 == window.id, target?.1 == window.pid, Date() < expires,
              !escaped, intervention == nil || counter == intervention else {
            throw DesktopFailure("Computer control stopped or user input changed. Request fresh control")
        }
    }
    func start() throws {
        let ready = DispatchSemaphore(value: 0)
        Thread.detachNewThread { [self] in
            let mask: CGEventMask = [CGEventType.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .scrollWheel].reduce(0) { $0 | (1 << $1.rawValue) }
            tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, pointer in
                let monitor = Unmanaged<InputMonitor>.fromOpaque(pointer!).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    monitor.stop("Input monitoring was interrupted")
                    if let tap = monitor.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                } else if event.getIntegerValueField(.eventSourceUserData) != monitor.marker {
                    monitor.lock.lock()
                    monitor.counter &+= 1
                    monitor.lastInput = Date()
                    if type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53 { monitor.escaped = true }
                    let escape = monitor.escaped
                    monitor.lock.unlock()
                    monitor.stop(escape ? "Escape pressed" : "User input changed")
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque())
            guard let tap = tap else { ready.signal(); return }
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            ready.signal()
            CFRunLoopRun()
        }
        guard ready.wait(timeout: .now() + 3) == .success, tap != nil else { throw DesktopFailure("Allow input monitoring and accessibility before computer control") }
    }
    func post(_ event: CGEvent, lease: String, window: Target, intervention: UInt64) throws {
        try check(lease, window: window, intervention: intervention)
        guard window.foreground else { throw DesktopFailure("The foreground app changed before input") }
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        event.post(tap: .cghidEventTap)
    }
}
