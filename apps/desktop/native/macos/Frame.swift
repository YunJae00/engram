import AppKit

final class WorkBorder: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemTeal.setStroke()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 3, dy: 3), xRadius: 12, yRadius: 12)
        path.lineWidth = 4
        path.stroke()
    }
}
final class ApplicationFrame {
    private var panel: NSPanel?
    private var timer: Timer?
    func hide() { timer?.invalidate(); timer = nil; panel?.orderOut(nil) }
    func show(_ window: Target) throws -> String {
        let bounds = try window.bounds
        if panel == nil {
            let view = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            view.isOpaque = false; view.backgroundColor = .clear; view.hasShadow = false
            view.ignoresMouseEvents = true; view.level = .floating
            view.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            view.contentView = WorkBorder()
            panel = view
        }
        let height = NSScreen.screens.first?.frame.height ?? 0
        panel?.setFrame(NSRect(x: bounds.minX - 3, y: height - bounds.maxY - 3, width: bounds.width + 6, height: bounds.height + 6), display: true)
        panel?.orderFrontRegardless()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            guard let current = try? resolveWindow(window.id, pid: window.pid), current.foreground, !current.minimized else { self?.panel?.orderOut(nil); return }
            guard let rect = try? current.bounds else { self?.hide(); return }
            self?.panel?.setFrame(NSRect(x: rect.minX - 3, y: height - rect.maxY - 3, width: rect.width + 6, height: rect.height + 6), display: true)
            self?.panel?.orderFrontRegardless()
        }
        return String(panel!.windowNumber)
    }
}
