// macOS-only, independent native reader check. Never linked into the application.
import AppKit
import Foundation
import PDFKit

let arguments = CommandLine.arguments
precondition(arguments.count == 4, "Usage: verify-pdfkit <export.pdf> <prepared.json> <output-directory>")
let input = URL(fileURLWithPath: arguments[1])
let destination = URL(fileURLWithPath: arguments[3], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let marks = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: arguments[2]))) as! [[String: Any]]
let expected = Dictionary(uniqueKeysWithValues: marks.map { ($0["id"] as! String, $0) })
let types = ["highlight": "Highlight", "underline": "Underline", "squiggly": "Squiggly", "strikethrough": "StrikeOut", "area": "Square", "page-note": "Text", "document-note": "Text"]
guard let document = PDFDocument(url: input), !document.isLocked else { fatalError("Unable to read PDF") }
var seen = Set<String>()
var selected: PDFAnnotation?
for index in 0..<document.pageCount {
    let page = document.page(at: index)!
    for annotation in page.annotations {
        guard let name = annotation.value(forAnnotationKey: .name) as? String,
              let mark = expected[name] else { continue }
        precondition(seen.insert(name).inserted, "Duplicate annotation ID")
        precondition(annotation.type == types[mark["kind"] as! String], "Native annotation type changed")
        precondition(annotation.contents == (mark["note"] as? String ?? ""), "Unicode comment changed")
        precondition(annotation.hasAppearanceStream && annotation.shouldPrint, "Missing printable appearance")
        precondition((mark["pageNumber"] as! Int) == index + 1, "Wrong annotation page")
        if selected == nil { selected = annotation }
    }
    // Native thumbnail drawing applies page rotation and CropBox through PDFKit.
    let image = page.thumbnail(of: NSSize(width: 900, height: 1100), for: .cropBox)
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent("page-\(index + 1).png"))
}
precondition(seen == Set(expected.keys), "Missing native annotations")
let changedId = selected!.value(forAnnotationKey: .name) as! String
let changedNote = "PDFKit 独立编辑：保留中文和评论 / native editor round trip"
selected!.contents = changedNote
let beforeSave = (0..<document.pageCount).map { index in
    document.page(at: index)!.annotations.map { [$0.type ?? "", $0.contents ?? ""] }
}
let editedURL = destination.appendingPathComponent("native-edited.pdf")
precondition(input.standardizedFileURL != editedURL.standardizedFileURL)
precondition(document.write(to: editedURL), "Native save failed")
let reopened = PDFDocument(url: editedURL)!
var retainedIds = 0
var nativeAnnotationCount = 0
precondition(reopened.pageCount == document.pageCount)
for index in 0..<reopened.pageCount {
    let annotations = reopened.page(at: index)!.annotations
    // PDFKit can omit /NM when rewriting. Compare all types/comments without claiming ID stability.
    precondition(annotations.map { [$0.type ?? "", $0.contents ?? ""] } == beforeSave[index], "Native save changed annotation content")
    nativeAnnotationCount += annotations.count
    for annotation in annotations {
        if let name = annotation.value(forAnnotationKey: .name) as? String, expected[name] != nil {
            retainedIds += 1
        }
    }
}
let report: [String: Any] = ["reader": "Apple PDFKit", "pages": document.pageCount, "annotations": seen.count, "commentsExact": true, "nativeEditRoundTrip": true, "nativeSavedAnnotationCount": nativeAnnotationCount, "retainedIdsAfterNativeSave": retainedIds, "changedId": changedId, "changedNote": changedNote]
let reportData = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
try reportData.write(to: destination.appendingPathComponent("result.json"))
print(String(data: reportData, encoding: .utf8)!)
