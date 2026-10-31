import AppKit

final class Connection: @unchecked Sendable {
    private let lock = NSLock()
    private var epoch = 0
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
                let selectAll = try keyChord("Control+A")
                precondition(selectAll.1 == .maskCommand)
                precondition(sensitive("Password") && sensitive("비밀번호") && !sensitive("Quarterly report"))
                precondition(!sensitiveControl(kAXTextAreaRole, "", "Discuss terminal and 로그인 here"))
                precondition(!sensitiveControl(kAXStaticTextRole, "", "password"))
                precondition(sensitiveControl(kAXTextFieldRole, kAXSecureTextFieldSubrole, "Message"))
                precondition(sensitiveControl(kAXGroupRole, "", "Sign in"))
                let input = InputMonitor()
                let initial = input.inputVersion(100)
                input.noteInput(pid: 200, escape: false)
                precondition(input.inputVersion(100) == initial)
                input.noteInput(pid: 100, escape: false)
                precondition(input.inputVersion(100) > initial)
                input.noteInput(pid: 200, escape: true)
                precondition(input.state().escaped)
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
        host.monitor.revoked = { lease, reason in
            connection.send(["type": "revoked", "lease": lease, "reason": reason])
            DispatchQueue.main.async { host.frame.hide(); host.documents.removeAll(); host.snapshots.removeAll() }
        }
        do { try host.monitor.start() }
        catch { connection.send(["type": "fatal", "error": String(describing: error)]); return }
        let watchdog = DispatchSource.makeTimerSource(queue: .global())
        watchdog.schedule(deadline: .now() + 1, repeating: 1)
        watchdog.setEventHandler {
            if getppid() != owner || kill(owner, 0) != 0 { host.monitor.stop("Owner exited"); exit(0) }
        }
        watchdog.resume()
        connection.send(["type": "ready", "protocol": 2, "control": true])
        Thread.detachNewThread {
            while let line = readLine() {
                guard line.utf8.count <= 65536, let data = line.data(using: .utf8),
                      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = request["id"] as? Int else {
                    host.monitor.stop("Invalid request"); exit(2)
                }
                if request["method"] as? String == "stop" { connection.cancel(); host.monitor.stop("Computer control stopped") }
                let epoch = connection.generation()
                DispatchQueue.main.async {
                    do {
                        guard connection.generation() == epoch else { throw DesktopFailure("Computer action was cancelled") }
                        let result = try host.receive(request)
                        guard connection.generation() == epoch else { throw DesktopFailure("Computer action was cancelled") }
                        connection.send(["id": id, "result": result])
                    } catch {
                        if ["click", "type", "replace", "scroll", "key", "bind", "prepare", "documentEdit", "documentCompose"].contains(request["method"] as? String ?? "") { host.monitor.stop(String(describing: error)); host.snapshots.removeAll() }
                        connection.send(["id": id, "error": String(describing: error)])
                    }
                }
            }
            connection.cancel(); host.monitor.stop("Connection closed"); exit(0)
        }
        app.run()
    }
}
