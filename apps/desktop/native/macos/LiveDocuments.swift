import AppKit

struct LiveRead {
    let window: CGWindowID
    let pid: pid_t
    let at = Date()
    let request: [String: Any]
    let result: [String: Any]
}
extension DesktopHost {
    func document(_ request: [String: Any], method: String, window: Target) throws -> Any {
        let lease = try text(request, "lease", limit: 100)
        try monitor.check(lease, window: window)
        guard window.foreground, let bundle = NSRunningApplication(processIdentifier: window.pid)?.bundleIdentifier,
              ["com.microsoft.Word", "com.microsoft.Excel", "com.microsoft.Powerpoint"].contains(bundle) else { throw DesktopFailure("Choose an open Word, Excel, or PowerPoint document in front") }
        var args = request
        args["bundle"] = bundle
        args["windowTitle"] = stringAttribute(window.element, kAXTitleAttribute)
        if method != "documentRead" {
            let snapshot = try text(request, "snapshot", limit: 100)
            guard let prior = documents.removeValue(forKey: snapshot), prior.window == window.id, prior.pid == window.pid,
                  Date().timeIntervalSince(prior.at) < 180 else { throw DesktopFailure("Read this live document again before editing") }
            args["observed"] = prior.result
            args["readArgs"] = prior.request
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = directory.appendingPathComponent("request.json"), output = directory.appendingPathComponent("output.json"), errors = directory.appendingPathComponent("error.txt")
        try JSONSerialization.data(withJSONObject: ["op": method, "args": args]).write(to: input)
        FileManager.default.createFile(atPath: output.path, contents: nil)
        FileManager.default.createFile(atPath: errors.path, contents: nil)
        let out = try FileHandle(forWritingTo: output), err = try FileHandle(forWritingTo: errors)
        defer { try? out.close(); try? err.close() }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        let script = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("Office.js")
        child.arguments = ["-l", "JavaScript", script.path, input.path]
        child.standardOutput = out; child.standardError = err
        try child.run()
        let deadline = Date().addingTimeInterval(method == "documentCompose" ? 24 : 6)
        do {
            while child.isRunning {
                try monitor.check(lease, window: window)
                guard window.foreground, Date() < deadline else { throw DesktopFailure("Document operation stopped. Changes may be partial; read again before continuing") }
                Thread.sleep(forTimeInterval: 0.02)
            }
        } catch { child.terminate(); throw error }
        try monitor.check(lease, window: window)
        guard child.terminationStatus == 0 else {
            let message = String(data: try Data(contentsOf: errors), encoding: .utf8) ?? "Office automation failed"
            throw DesktopFailure(String(message.prefix(500)))
        }
        let data = try Data(contentsOf: output)
        guard data.count <= 500000, var result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DesktopFailure("Invalid live document response") }
        if method == "documentRead" {
            documents = documents.filter { Date().timeIntervalSince($0.value.at) < 180 }
            if documents.count >= 16 { documents.removeAll() }
            let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            documents[id] = LiveRead(window: window.id, pid: window.pid, request: request, result: result)
            result["snapshot"] = id
        }
        result.removeValue(forKey: "identity")
        result.removeValue(forKey: "structure")
        return result
    }
}
