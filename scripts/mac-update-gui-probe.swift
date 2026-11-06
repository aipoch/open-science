import AppKit
import CoreGraphics

// An actual Aqua window is required. No headless Electron probe can satisfy this gate.
if CommandLine.arguments.count > 1, let pid = Int32(CommandLine.arguments[1]) {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let owned = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    print("{\"pid\":\(pid),\"onScreenWindows\":\(owned.count)}")
    exit(owned.isEmpty ? 1 : 0)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 480, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Open-Science isolated update GUI probe"
window.contentView = NSTextField(labelWithString: "Disposable CI GUI readiness probe")
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let owned = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == getpid() && ($0[kCGWindowLayer as String] as? Int) == 0 }
    let result: [String: Any] = ["pid": getpid(), "visible": window.isVisible, "onScreenWindows": owned.count, "windowNumber": window.windowNumber]
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    let passed = window.isVisible && !owned.isEmpty
    window.orderOut(nil)
    exit(passed ? 0 : 1)
}
app.run()
