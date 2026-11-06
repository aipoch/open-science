import AppKit
import ApplicationServices
import Foundation

let expected = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath().path
var result: [String: Any] = ["accessibilityTrusted": AXIsProcessTrusted(), "expectedWrapper": expected]
if AXIsProcessTrusted(), let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first {
  var queue: [(AXUIElement, Int)] = [(AXUIElementCreateApplication(dock.processIdentifier), 0)]
  while !queue.isEmpty {
    let (element, depth) = queue.removeFirst()
    var urlValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXURLAttribute as CFString, &urlValue) == .success,
       let url = urlValue as? URL, url.resolvingSymlinksInPath().path == expected {
      result["dockEntryURL"] = url.path
      break
    }
    if depth < 4 {
      var children: CFTypeRef?
      if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
         let list = children as? [AXUIElement] { queue.append(contentsOf: list.map { ($0, depth + 1) }) }
    }
  }
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
