"""Independent PDF object/appearance verification, including an editable-note round trip."""

import hashlib
import io
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject

original_path, output_path, marks_path = map(Path, sys.argv[1:4])
original = PdfReader(original_path)
result = PdfReader(output_path)
marks = {m["id"]: m for m in json.loads(marks_path.read_text())}
seen = set()
for before, after in zip(original.pages, result.pages, strict=True):
    assert hashlib.sha256(before.get_contents().get_data()).digest() == hashlib.sha256(after.get_contents().get_data()).digest(), "Page content stream changed"
    assert before.mediabox == after.mediabox
    assert before.cropbox == after.cropbox
    assert before.rotation == after.rotation
    for ref in after.get("/Annots", []):
        annotation = ref.get_object()
        name = annotation.get("/NM")
        if name not in marks:
            continue
        assert name not in seen
        seen.add(name)
        expected = marks[name]
        assert annotation["/Contents"] == expected.get("note", "")
        assert len(annotation["/AP"]["/N"].get_object().get_data()) > 0
        assert not annotation.get("/F", 0) & (64 | 128 | 512), "Annotation is locked"
        if expected["kind"] == "area":
            # /Rect includes the appearance border; /RD describes its inset.
            rect, inset = annotation["/Rect"], annotation["/RD"]
            selected = [rect[0] + inset[0], rect[1] + inset[1], rect[2] - inset[2], rect[3] - inset[3]]
            assert all(abs(a - b) < .002 for a, b in zip(selected, expected["pdfRect"]))
assert seen == marks.keys(), f"Missing stable IDs: {marks.keys() - seen}"

# Optional pre-optimization output: compression changes must preserve the decoded appearance.
if len(sys.argv) > 4:
    reference = PdfReader(Path(sys.argv[4]))
    def named_annotations(reader):
        return {a.get("/NM"): a for page in reader.pages for ref in page.get("/Annots", [])
                if (a := ref.get_object()).get("/NM") in marks}
    before_marks, after_marks = named_annotations(reference), named_annotations(result)
    assert before_marks.keys() == after_marks.keys() == marks.keys()
    for name, after in after_marks.items():
        before = before_marks[name]
        for key in ["/Subtype", "/Rect", "/QuadPoints", "/C", "/CA", "/Contents"]:
            assert before.get(key) == after.get(key), f"Changed {key}: {name}"
        assert before["/AP"]["/N"].get_object().get_data() == after["/AP"]["/N"].get_object().get_data(), f"Appearance changed: {name}"

# Another library can edit /Contents and save, without flattening the annotation.
writer = PdfWriter(clone_from=result)
first_id = next(iter(marks))
changed = "独立编辑器修改后的评论 / edited with pypdf"
for page in writer.pages:
    for ref in page.get("/Annots", []):
        annotation = ref.get_object()
        if annotation.get("/NM") == first_id:
            annotation[NameObject("/Contents")] = TextStringObject(changed)
buffer = io.BytesIO()
writer.write(buffer)
reopened = PdfReader(buffer)
found = [ref.get_object() for page in reopened.pages for ref in page.get("/Annots", []) if ref.get_object().get("/NM") == first_id]
assert len(found) == 1 and found[0]["/Contents"] == changed
print(json.dumps({"pages": len(result.pages), "nativeAnnotations": len(seen), "nonemptyAppearances": True, "contentStreamsUnchanged": True, "stableIds": True, "independentCommentEdit": True, "referenceAppearanceUnchanged": True if len(sys.argv) > 4 else None}))
