import AppKit
import ApplicationServices

func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
guard ProcessInfo.processInfo.environment["RUNNER_ENVIRONMENT"] == "github-hosted" else { fail("disposable hosted runner required") }
let operation = CommandLine.arguments[1]
guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { fail("Hosted GUI accessibility or event posting permission is unavailable") }
if operation == "permissions" { print("Hosted GUI permission available"); exit(0) }
let bundle = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().standardizedFileURL.path
let desktop = NSWorkspace.shared
func matches(_ app: NSRunningApplication) -> Bool { app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == bundle }
func trigger(_ key: CGKeyCode, target: NSRunningApplication) {
    guard target.isActive else { fail("intended target is not frontmost") }
    for down in [true,false] {
        guard let event = CGEvent(keyboardEventSource:nil, virtualKey:key, keyDown:down) else { fail("cannot create key event") }
        event.flags = .maskCommand
        event.post(tap:.cghidEventTap)
    }
}
func attribute(_ element: AXUIElement,_ name:String) -> CFTypeRef? {
    var v:CFTypeRef?; return AXUIElementCopyAttributeValue(element,name as CFString,&v) == .success ? v : nil
}
if operation == "quit" {
    guard let app = desktop.frontmostApplication, matches(app) else { fail("expected installed app in foreground") }
    trigger(12,target:app)
} else if operation == "finder" {
    guard let app = desktop.frontmostApplication, app.bundleIdentifier == "com.apple.finder" else { fail("expected Finder in foreground") }
    trigger(31,target:app)
} else if operation == "dock" {
    guard let dock=desktop.runningApplications.first(where:{$0.bundleIdentifier=="com.apple.dock"}) else { fail("no Dock") }
    var todo=[AXUIElementCreateApplication(dock.processIdentifier)]
    while let el=todo.popLast() {
        if let url=attribute(el,kAXURLAttribute) as? URL, url.resolvingSymlinksInPath().standardizedFileURL.path==bundle {
            guard AXUIElementPerformAction(el,kAXPressAction as CFString) == .success else { fail("Dock refused tile press") }; exit(0)
        }
        todo += (attribute(el,kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }
    fail("no Dock tile for exact installed app")
} else if operation=="visible" {
    for app in desktop.runningApplications where matches(app) {
        let el=AXUIElementCreateApplication(app.processIdentifier)
        if !(attribute(el,kAXWindowsAttribute) as? [AXUIElement] ?? []).isEmpty {
            print(app.processIdentifier); exit(0)
        }
    }
    fail("no application window")
} else { fail("invalid action") }
