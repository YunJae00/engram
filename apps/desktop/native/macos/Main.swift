import AppKit

final class Connection: @unchecked Sendable {
    private let lock = NSLock()
    private var epoch = 0
    private var pending: [Int: Date] = [:]
    func register(_ id: Int, _ expires: Double?) {
        lock.lock(); defer { lock.unlock() }
        pending[id] = min(Date().addingTimeInterval(30), Date(timeIntervalSince1970: (expires ?? (Date().timeIntervalSince1970 * 1000 + 30000)) / 1000))
    }
    func cancel(_ id: Int) { lock.lock(); pending.removeValue(forKey: id); lock.unlock() }
    func valid(_ id: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return pending[id].map { $0 > Date() } ?? false }
    func cancel() { lock.lock(); epoch += 1; lock.unlock() }
    func generation() -> Int { lock.lock(); defer { lock.unlock() }; return epoch }
    func send(_ value: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count <= 524287 else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }
}
@main struct Main {
    static func main() {
        let connection = Connection()
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "--self-test" {
            do {
                try literal("한글🙂")
                for invalid in ["", "line\nfeed", String(repeating: "x", count: 2001)] {
                    do { try literal(invalid); fatalError("Unsafe literal accepted") } catch {}
                }
                for invalid in ["Command+Q", "Control+Alt+Delete", "Shift+Escape"] {
                    do { _ = try keyChord(invalid); fatalError("Unsafe chord accepted") } catch {}
                }
                precondition(" \n\t".trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                let selectAll = try keyChord("Control+A")
                precondition(selectAll.1 == .maskCommand)
                precondition(sensitiveReason("Account alice@example.test — Sign in 123456") == "Sign in")
                precondition(sensitiveReason("로그인 — private account") == "로그인")
                precondition(sensitive("Password") && sensitive("비밀번호") && !sensitive("Quarterly report"))
                precondition(!sensitiveControl(kAXTextAreaRole, "", "Discuss terminal and 로그인 here"))
                precondition(!sensitiveControl(kAXStaticTextRole, "", "password"))
                precondition(sensitiveControl(kAXTextFieldRole, kAXSecureTextFieldSubrole, "Message"))
                precondition(sensitiveControl(kAXGroupRole, "", "Sign in"))
                var pixels = [UInt8](repeating: 0, count: 96 * 96 * 4)
                func previewFixture(_ mode: Int) -> CGImage {
                    for y in 0..<96 { for x in 0..<96 {
                        let offset = (y * 96 + x) * 4
                        let color: [UInt8] = mode == 0 ? [0, 0, 0, 0] : y < 40 ? [255, 0, 0, 255] : mode == 1 ? [255, 255, 255, 255] : x < 32 ? [255, 0, 0, 255] : x < 64 ? [0, 255, 0, 255] : [0, 0, 255, 255]
                        for channel in 0..<4 { pixels[offset + channel] = color[channel] }
                    } }
                    return pixels.withUnsafeMutableBytes { bytes in
                        CGContext(data: bytes.baseAddress, width: 96, height: 96, bitsPerComponent: 8, bytesPerRow: 96 * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
                    }
                }
                precondition(!previewHasDrawn(previewFixture(0)))
                precondition(!previewHasDrawn(previewFixture(1)))
                precondition(previewHasDrawn(previewFixture(2)))
                let input = InputMonitor()
                let initial = input.inputVersion(100)
                let posted = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
                posted.setIntegerValueField(.eventSourceUserData, value: input.marker)
                let intervention = input.state().intervention
                let target = Target(id: 1, pid: 100, element: AXUIElementCreateApplication(100), title: "Owned self-test")
                let safeNode = Control(id: "0", element: target.element, role: kAXTextFieldRole, name: "Text", secret: false, bounds: nil, enabled: true, settable: false, pressable: false)
                let secretNode = Control(id: "1", element: target.element, role: kAXTextFieldRole, name: "Password", secret: true, bounds: nil, enabled: true, settable: false, pressable: false)
                precondition(Snapshot(target: target, bounds: .zero, controls: [safeNode], focus: nil, complete: false).captureSafe)
                precondition(!Snapshot(target: target, bounds: .zero, controls: [safeNode, secretNode], focus: nil, complete: false).captureSafe)
                precondition(Snapshot(target: target, bounds: .zero, controls: [secretNode], focus: nil, complete: true).captureSafe)
                let grant = UUID().uuidString
                let lease = try input.bind(target, grant: grant, intervention: intervention)
                input.receiveInput(.keyDown, event: posted)
                precondition(input.state().intervention == intervention)
                precondition(input.inputVersion(100) == initial && !input.state().escaped)
                input.noteMove()
                precondition(input.state().intervention == intervention && input.state().idle < 100)
                precondition(input.inputVersion(100) == initial && input.state().lease == lease)
                input.noteInput(pid: 200, escape: false)
                precondition(input.inputVersion(100) == initial && input.state().lease == nil)
                do { _ = try input.bind(target, grant: grant, intervention: intervention); fatalError("Used grant accepted") }
                catch { precondition(String(describing: error).contains("already been used")) }
                do { _ = try input.bind(target, grant: UUID().uuidString, intervention: intervention); fatalError("Intervened grant accepted") }
                catch { precondition(String(describing: error).contains("after approving")) }
                input.noteInput(pid: 100, escape: false)
                precondition(input.inputVersion(100) > initial)
                input.noteInput(pid: 200, escape: true)
                precondition(input.state().escaped)
                do { _ = try input.bind(target, grant: UUID().uuidString, intervention: input.state().intervention); fatalError("Escape accepted") }
                catch { precondition(String(describing: error).contains("Escape")) }
                connection.send(["selfTest": "passed"])
            } catch { connection.send(["selfTest": "failed", "error": String(describing: error)]); exit(1) }
            return
        }
        guard args.count == 3, args[1] == "--owner-pid", let owner = Int32(args[2]), owner > 1, getppid() == owner else {
            connection.send(["type": "fatal", "error": "A valid parent --owner-pid is required"]); return
        }
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let host = DesktopHost()
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { host.restoreHiddenApps(); exit(0) }
        termination.resume()
        host.monitor.revoked = { lease, reason in
            connection.send(["type": "revoked", "lease": lease, "reason": reason])
            DispatchQueue.main.async { host.frame.hide(); host.documents.removeAll(); host.snapshots.removeAll() }
        }
        do { try host.monitor.start() }
        catch { connection.send(["type": "fatal", "error": String(describing: error)]); return }
        let watchdog = DispatchSource.makeTimerSource(queue: .global())
        watchdog.schedule(deadline: .now() + 1, repeating: 1)
        watchdog.setEventHandler {
            if getppid() != owner || kill(owner, 0) != 0 { DispatchQueue.main.async { host.restoreHiddenApps(); host.monitor.stop("Owner exited"); exit(0) } }
        }
        watchdog.resume()
        connection.send(["type": "ready", "protocol": 2, "control": true])
        Thread.detachNewThread {
            while let line = readLine() {
                guard line.utf8.count <= 65536, let data = line.data(using: .utf8),
                      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = request["id"] as? Int else {
                    host.monitor.stop("Invalid request"); exit(2)
                }
                if request["method"] as? String == "cancel", let target = request["target"] as? Int {
                    connection.cancel(target)
                    connection.send(["id": id, "result": ["cancelled": true]])
                    continue
                }
                connection.register(id, request["expiresAt"] as? Double)
                if request["method"] as? String == "stop" { connection.cancel(); host.monitor.stop("Computer control stopped") }
                let epoch = connection.generation()
                DispatchQueue.main.async {
                    let finish: (Result<Any, Error>) -> Void = { outcome in
                        defer { connection.cancel(id) }
                        do {
                            let result = try outcome.get()
                            guard connection.generation() == epoch else { throw DesktopFailure("Computer action was cancelled") }
                            guard connection.valid(id) else { throw DesktopFailure("The request was cancelled after dispatch; read the app before retrying") }
                            connection.send(["id": id, "result": result])
                        } catch {
                            if ["click", "type", "replace", "scroll", "key", "bind", "prepare", "documentEdit", "documentCompose"].contains(request["method"] as? String ?? "") { host.monitor.stop(String(describing: error)); host.snapshots.removeAll() }
                            connection.send(["id": id, "error": String(describing: error)])
                        }
                    }
                    do {
                        guard connection.valid(id) else { throw DesktopFailure("The request expired or was cancelled before execution; it was not run") }
                        guard connection.generation() == epoch else { throw DesktopFailure("Computer action was cancelled") }
                        if request["method"] as? String == "openApp" { try host.openApp(request, completion: finish) }
                        else { finish(.success(try host.receive(request))) }
                    } catch { finish(.failure(error)) }
                }
            }
            connection.cancel(); DispatchQueue.main.async { host.restoreHiddenApps(); host.monitor.stop("Connection closed"); exit(0) }
        }
        app.run()
    }
}
