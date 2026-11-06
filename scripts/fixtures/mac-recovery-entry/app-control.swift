import AppKit
import Darwin
import Foundation

func canonical(_ path: String) -> String {
  guard let value = realpath(path, nil) else { return path }
  defer { free(value) }
  return String(cString: value)
}
let wrapper = canonical(CommandLine.arguments[1])
let runtime = canonical(CommandLine.arguments[2])
precondition(wrapper.contains("/mac-recovery-electron-ui-"), "Only this fixture's temporary app can be controlled")
let applications = NSWorkspace.shared.runningApplications.filter { app in
  guard let path = app.bundleURL?.path else { return false }
  return [wrapper, runtime].contains(canonical(path))
}
if CommandLine.arguments.count > 3 && CommandLine.arguments[3] == "terminate-wrapper" {
  for app in applications where canonical(app.bundleURL!.path) == wrapper { _ = app.terminate() }
}
let result = applications.map { app in
  ["pid": app.processIdentifier, "bundlePath": canonical(app.bundleURL!.path), "activationPolicy": app.activationPolicy.rawValue] as [String: Any]
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
