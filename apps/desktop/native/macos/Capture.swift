import AppKit

extension DesktopHost {
    func capture(_ request: [String: Any], window: Target) throws -> Any {
        guard CGPreflightScreenCaptureAccess() else { throw DesktopFailure("Allow Engram in System Settings → Privacy & Security → Screen Recording") }
        let reading = try snapshot(request, window: window)
        let preview = request["preview"] as? Bool == true
        guard (reading.complete || (preview && reading.captureSafe)), !window.minimized else { throw DesktopFailure("The app cannot be captured safely. Observe again") }
        func verifyProtection() throws {
            let fresh = try scan(resolveWindow(window.id, pid: window.pid))
            guard (fresh.complete || (preview && fresh.captureSafe)), fresh.bounds == reading.bounds,
                  fresh.controls.filter({ $0.secret }).compactMap({ $0.bounds }) == reading.controls.filter({ $0.secret }).compactMap({ $0.bounds }) else { throw DesktopFailure("Protected controls changed. Observe again") }
        }
        try verifyProtection()
        let intervention = monitor.inputVersion(window.pid)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("window.png")
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        child.arguments = ["-x", "-o", "-l", String(window.id), "-t", "png", file.path]
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        try child.run()
        let deadline = Date().addingTimeInterval(4)
        while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        if child.isRunning { child.terminate(); throw DesktopFailure("Screen capture timed out") }
        guard child.terminationStatus == 0, let source = NSImage(contentsOf: file), let bitmap = NSBitmapImageRep(data: try Data(contentsOf: file)) else { throw DesktopFailure("Screen capture failed") }
        try verifyProtection()
        // A hidden app that has not drawn yet yields a fully transparent window image; previews report it instead of showing black.
        if preview {
            let drawn = stride(from: 0, to: bitmap.pixelsWide, by: max(1, bitmap.pixelsWide / 16)).contains { x in
                stride(from: 0, to: bitmap.pixelsHigh, by: max(1, bitmap.pixelsHigh / 16)).contains { y in (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0 }
            }
            guard drawn else { throw DesktopFailure("The hidden window has not drawn a preview yet") }
        }
        try requireCurrent(reading, target: resolveWindow(window.id, pid: window.pid))
        guard monitor.inputVersion(window.pid) == intervention else { throw DesktopFailure("The screen changed during capture") }
        if let lease = request["lease"] as? String { try monitor.check(lease, window: window) }
        let ratio = Double(bitmap.pixelsWide) / Double(bitmap.pixelsHigh)
        guard abs(ratio - reading.bounds.width / reading.bounds.height) < 0.02 else { throw DesktopFailure("Capture geometry changed") }
        // Previews are shown at 700px, so a smaller native image keeps large windows under the size limit.
        let scale = preview ? min(1, 800 / reading.bounds.width, 500 / reading.bounds.height) : min(1, 1600 / reading.bounds.width, 1000 / reading.bounds.height)
        let width = Int(reading.bounds.width * scale), height = Int(reading.bounds.height * scale)
        guard width > 0, height > 0, let output = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: output) else { throw DesktopFailure("Cannot allocate screen image") }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        source.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
        NSColor.black.setFill()
        for node in reading.controls where node.secret {
            guard let rect = node.bounds else { NSGraphicsContext.restoreGraphicsState(); throw DesktopFailure("A protected control has unknown geometry") }
            NSRect(x: (rect.minX - reading.bounds.minX) * scale - 2, y: (reading.bounds.maxY - rect.maxY) * scale - 2, width: rect.width * scale + 4, height: rect.height * scale + 4).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        // Previews travel as JPEG so large windows stay under the size limit; evidence captures stay lossless PNG.
        guard let data = output.representation(using: preview ? .jpeg : .png, properties: preview ? [.compressionFactor: 0.8] : [:]), data.count <= 350000 else { throw DesktopFailure("The captured image exceeds the safe size limit") }
        return ["basis": "client-physical", "bounds": rectangle(reading.bounds), "width": width, "height": height, "data": data.base64EncodedString()]
    }
}
