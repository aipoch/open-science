import Foundation
var result: NSURL?
try FileManager.default.trashItem(at: URL(fileURLWithPath: CommandLine.arguments[1]), resultingItemURL: &result)
print(result!.path!)
