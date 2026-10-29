import AppKit

@main struct Fixture {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let window = NSWindow(contentRect: NSRect(x: 80, y: 120, width: 500, height: 320), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Engram owned macOS fixture"
        let text = NSTextField(frame: NSRect(x: 30, y: 220, width: 420, height: 30))
        text.stringValue = "owned fixture initial"
        text.setAccessibilityLabel("Fixture message")
        let secret = NSSecureTextField(frame: NSRect(x: 30, y: 160, width: 420, height: 30))
        secret.stringValue = "fixture-secret-never-export"
        secret.setAccessibilityLabel("Private password")
        window.contentView?.addSubview(text)
        window.contentView?.addSubview(secret)
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.makeFirstResponder(text)
        text.stringValue = "owned fixture initial"
        FileHandle.standardOutput.write(Data("\(window.windowNumber)\n".utf8))
        app.run()
    }
}
