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
        let region = NSView(frame: NSRect(x: 30, y: 40, width: 420, height: 60))
        region.setAccessibilityElement(true)
        region.setAccessibilityRole(.group)
        region.setAccessibilityLabel("Fixture region")
        window.contentView?.addSubview(region)
        var parent = region
        for _ in 0..<6 {
            let wrapper = NSView(frame: parent.bounds)
            wrapper.setAccessibilityElement(true)
            wrapper.setAccessibilityRole(.group)
            parent.addSubview(wrapper)
            parent = wrapper
        }
        let nested = NSTextField(labelWithString: "Nested result")
        nested.frame = parent.bounds
        nested.setAccessibilityLabel("Nested result")
        parent.addSubview(nested)
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.makeFirstResponder(text)
        text.stringValue = "owned fixture initial"
        FileHandle.standardOutput.write(Data("\(window.windowNumber)\n".utf8))
        app.run()
    }
}
