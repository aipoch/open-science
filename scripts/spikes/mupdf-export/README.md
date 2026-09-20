# MuPDF annotation export spike

Standalone evaluation of `mupdf@1.28.1`. These scripts are not imported by the application and do
not add a production dependency, database field, migration, enum, or download UI. Generated PDFs,
engine files, private input snapshots and measurements belong in the ignored `.dev-isolate/` tree.
Do not commit the engine or user documents.

## Scope

- Native Highlight, Underline, Squiggly, StrikeOut and Square annotations with appearance streams.
- Unicode comments, multiline selections, five colors and Text annotations for page/document notes.
- Normalized application rectangles -> PDF.js viewport inverse -> PDF user coordinates -> MuPDF
  page transform. Exercise intrinsic 0/90/180/270 rotation, viewer rotation, offset CropBox and UserUnit.
- Preserve source page content streams, extracted text, annotation/link properties and page boxes.
- Reopen using PDF.js and pypdf; check stable `/NM`, exact comments, printable/unlocked flags,
  nonempty `/AP/N`, positions and a comment edit/save round trip using pypdf.
- Fresh child-process measurements separate WASM import from load/annotate/save time, CPU and RSS.

The exporter rejects password-protected inputs. This is a bounded spike, not a safe production PDF
pipeline. Production still needs permissions/signature policy, cancellation, quotas, verified engine
acquisition, atomic output publication and asynchronous worker integration.

## Reproduce

Use Node 22 with the repository dependencies already installed (`pdfjs-dist@5.4.624`). Fixture and
object validation scripts need Python with `reportlab` and `pypdf`; they are evaluation-only tools.
Rendering needs Poppler. No application package manifest changes are necessary.

Run from the worktree root. Fetch the pinned official npm tarball into
`.dev-isolate/mupdf-spike/`, verify its SHA-512 SRI before extraction, then use its
`package/dist/mupdf.js`. No package install scripts are needed.

```text
URL: https://registry.npmjs.org/mupdf/-/mupdf-1.28.1.tgz
SRI: sha512-Gi11Ow2G1SlrXKJNZBL1eAIGFVih5+4ZKqjptamTVaj/5hnlrcVrVbyb7lHE2lfFKdxZPyv9ZtfOOq7XgjzEig==
```

```sh
python3 scripts/spikes/mupdf-export/fixtures.py .dev-isolate/mupdf-spike/input

node scripts/spikes/mupdf-export/spike.mjs \
  .dev-isolate/mupdf-spike/input/fixture.pdf \
  .dev-isolate/mupdf-spike/input/fixture-marks.json \
  .dev-isolate/mupdf-spike/output/pdf/annotation-specimen.pdf \
  .dev-isolate/mupdf-spike/package/dist/mupdf.js

python3 scripts/spikes/mupdf-export/verify.py \
  .dev-isolate/mupdf-spike/input/fixture.pdf \
  .dev-isolate/mupdf-spike/output/pdf/annotation-specimen.pdf \
  .dev-isolate/mupdf-spike/output/pdf/annotation-specimen-prepared.json

node scripts/spikes/mupdf-export/spike.mjs \
  .dev-isolate/mupdf-spike/input/dense.pdf \
  .dev-isolate/mupdf-spike/input/dense-marks.json \
  .dev-isolate/mupdf-spike/output/dense-annotated.pdf \
  .dev-isolate/mupdf-spike/package/dist/mupdf.js

pdftoppm -scale-to 1400 -png \
  .dev-isolate/mupdf-spike/output/pdf/annotation-specimen.pdf \
  .dev-isolate/mupdf-spike/output/specimen
```

`spike.mjs` accepts application records as `{id, kind, color, note, selector}`. A selector uses the
existing `quads`/`rect`, normalized x/y/width/height, pageNumber and pageRotation. The real-source
snapshot must come from the exact immutable PDF version; validate its checksum before running.
The runner does not access or mutate the application database. Synthetic inputs use `rawRects`
to create normalized rectangles independently and assert their inverse mapping.

Each run writes `*-prepared.json` and `*-results.json` next to the output. The optional fifth
argument controls repetitions (default 3); each repetition starts a fresh exporter process.
The output is a separate file; the source is not modified. Inputs/outputs must be different paths.

## Interpretation and limits

### Browser annotation-layer regression

PDF.js creates assistive `.overlaidText` elements inside native annotations. Its matching
`pdf_viewer.css` clips these elements to zero dimensions. A viewer missing that rule shows a second
copy of highlighted text with browser-default yellow backgrounds and an inherited font size.
PDF object validation and canvas-only screenshots cannot detect this HTML-layer failure.

Use the independent, read-only viewer to test the exported bytes with the installed PDF.js script
and its **matching complete stylesheet**. It is diagnostic tooling, not the application's renderer.
It serves only the selected PDF, viewer HTML and PDF.js assets, on loopback. Stop with Ctrl+C.

```sh
node scripts/spikes/mupdf-export/check-viewer.mjs \
  .dev-isolate/mupdf-spike/output/pdf/literature-annotated.pdf

node scripts/spikes/mupdf-export/serve-viewer.mjs \
  .dev-isolate/mupdf-spike/output/pdf/literature-annotated.pdf
```

Open `http://127.0.0.1:5198/` and `/?page=2`. Confirm highlights align with the original text,
without a visible duplicate. `window.renderCheck` exposes the actual DOM bounds; every assistive
mark must have zero width/height and `overflow: hidden`. The page reports a visible error if that
invariant fails. `window.renderError` reports loading/rendering/validation failures.

The former `missing-style` query switch has been removed: old links now render normally too.
Fault injection belongs in browser tests, never in a user-facing preview URL. A negative-control
test may remove the `.overlaidText` CSS rule through its browser automation context, observe visible
duplicates, then reload and assert recovery. Check both single-line and multiline highlights. Do not
flatten annotations or remove comments to work around a viewer stylesheet defect.

`check-viewer.mjs` verifies HTTP routes, paired assets and byte-identical PDF delivery. It does **not**
replace real-browser checks of `renderCheck`, screenshots or popup/comment interaction. The browser
diagnostic also does not certify the production reader or a third-party application's integration.

### Measurement and format limits

- `importMs`: local module/WASM initialization with warm filesystem cache, not network download.
- `exportMs`: PDF parse, annotations, save and output write; excludes input read, selection conversion
  and independent verification. `totalMs` includes import/input read, but not OS process launch.
- CPU is summed process CPU time, not utilization percentage. Peak RSS is the child exporter's
  high-water mark, not incremental app memory or the PDF.js validation parent's memory.
- The dense fixture is 200 repeated text/vector pages and 4,000 marks. It is not a large scanned PDF
  benchmark. Desktop processes may run concurrently; measurements are diagnostic, not release budgets.
- Current axis-aligned selectors do not preserve arbitrary tilted/vertical glyph baselines. Do not
  generalize the tested page rotations to all writing directions.
- Page/document notes use native Text icons; the spike places document notes on page 1. This is not
  a production UX decision. App tags, comment threads and two-way annotation synchronization are absent.
- A native annotation with a valid appearance is not proof that every viewer exposes its editing UI.
  PDF.js/pypdf/Poppler checks do not certify Acrobat, macOS Preview or mobile readers.
- Full PDF rewriting is used, without baking/rasterizing annotations. Digitally signed documents,
  encrypted PDFs, malformed inputs, very large scans and repeat export from an already-exported PDF
  are not certified. No deduplication policy is implemented for the latter.

MuPDF offers AGPL and commercial licensing. Technical success does not resolve the project's
licensing choice; downloading it on demand does not make that decision disappear. See the
[official license](https://mupdf.readthedocs.io/en/latest/license.html).

## pdf-lib comparison

`export-pdf-lib.mjs` evaluates `pdf-lib@1.17.1` against the exact same prepared records and checks.
It uses low-level annotation dictionaries and custom compressed vector appearance streams. These
are **our adapter**, not built-in pdf-lib markup APIs. Original page content is never painted over
or normalized. Unicode comments live in `/Contents`; they are not embedded as visible page text.

Supply the pinned library's standalone `dist/pdf-lib.min.js` (UMD) or its installed `cjs/index.js`.
A bundled Codex workspace runtime may already provide it; no app package change is required. The
sixth runner argument selects the engine; the default remains MuPDF for existing commands.

```sh
node scripts/spikes/mupdf-export/spike.mjs \
  .dev-isolate/mupdf-spike/input/fixture.pdf \
  .dev-isolate/mupdf-spike/input/fixture-marks.json \
  .dev-isolate/pdf-lib-spike/output/pdf/annotation-specimen.pdf \
  /absolute/path/to/pdf-lib/dist/pdf-lib.min.js 3 pdf-lib

python3 scripts/spikes/mupdf-export/verify.py \
  .dev-isolate/mupdf-spike/input/fixture.pdf \
  .dev-isolate/pdf-lib-spike/output/pdf/annotation-specimen.pdf \
  .dev-isolate/pdf-lib-spike/output/pdf/annotation-specimen-prepared.json

node scripts/spikes/mupdf-export/serve-viewer.mjs \
  .dev-isolate/pdf-lib-spike/output/pdf/annotation-specimen.pdf 5200
```

Repeat with `literature` and `dense` inputs and run MuPDF again in the same session. Run benchmarks
sequentially in fresh children; compare medians of at least three runs. Do not compare old timings
from another machine/session. Inspect all seven specimen pages (rotation/CropBox/UserUnit), the
real document's first two pages and actual hover/click comments in the shared PDF.js viewer.
Use Poppler plus `verify.py` as independent checks; no claims of Acrobat/Preview UI certification.

The shared diagnostic viewer caps popup comment height and allows internal scrolling. PDF.js's
default popup stylesheet otherwise expands the 500-line fixture beyond the viewport for both
writers. This affects only this preview HTML, not exported bytes or the production reader. Verify
that the comment's scrollHeight exceeds clientHeight and its complete text remains accessible.

The appearance policies differ: this adapter uses straight rectangular highlights, fixed-width
lines, zigzag squiggles and a simple note icon; MuPDF generates its own shapes. The same color and
opacity values are used, but pixel identity is not an acceptance criterion. PDF.js may render Text
annotation icons using its own UI. Both writers retain semantic annotation types and editable
comments. Long comments in object streams compress differently, so output size is not solely a
measure of engine efficiency. Each writer uses its normal compressed save settings.

The pdf-lib worker deliberately rejects encrypted PDFs through its normal load path. No signature
preservation, arbitrary text baselines, tag export, reply threads, deduplication or import/sync policy
is added. Its low-level appearance code and memory growth at high annotation counts need separate
production review. Choosing a writer does not require a database migration or replacing PDF.js.

## Selected writer: pdf-lib

The follow-up selects **pdf-lib 1.17.1 for the annotated-download writer**; retain PDF.js for reading
and the existing PdfAnnotation storage. MuPDF remains comparison evidence, not a production
fallback or dependency. Selection is based on the tested annotation set, small JS payload, MIT
license and acceptable measured export cost. This is a writer decision, not implementation of the
production download workflow. No app package/schema/UI changes are included here.

The pdf-lib adapter leaves appearance command streams below 1 KiB uncompressed. Compressing each
small path allocated a DEFLATE workspace for little or no file-size saving; skipping that work
reduces buffer churn without caching fixture-specific appearances, forcing GC, changing mark
geometry or removing comments. Long paths still use flate compression. The optional fourth input
to `verify.py` is a reference PDF: it checks every named annotation's decoded appearance, comments,
coordinates, subtype, color and opacity against the pre-optimization output.

Follow-up measurements (same macOS M2 Pro, Node 22, three fresh children; medians, not product budgets):

| Input | MuPDF export / RSS | Selected pdf-lib export / RSS |
| --- | --- | --- |
| 200 pages / 4,000 marks | 1,257 ms / 185 MiB (previous comparison) | 562 ms / 194 MiB |
| 24 image pages / 240 areas / 43.6 MB | 129 ms / 357 MiB | 148 ms / 149 MiB |

The before/after compression-only control in this follow-up measured 790 -> 541 ms, CPU 950 ->
673 ms and peak RSS 295 -> 188 MiB; all 4,000 decoded appearance streams remained byte-identical.
Normal run-to-run variation explains the later 562 ms / 194 MiB result. The image workload contains
seeded high-entropy JPEG pages, not clinical scans or a representative literature corpus. No
universal speed/memory advantage is claimed. All original measurement exclusions still apply.
Reproduce the optional image workload with
`python3 scripts/spikes/mupdf-export/fixtures.py <ignored-input-directory> --image-heavy`
(also requires Pillow), then pass its `image-heavy.pdf` and `image-heavy-marks.json` to the runner.

### Independent macOS check

The optional `verify-pdfkit.swift` uses Apple's installed PDFKit to check all expected native types,
Unicode contents, printable appearances, page assignment and a native comment-edit/save round trip.
It also renders each page to PNG for visual inspection. It requires macOS and its existing command
line SDK; it does not add Swift or PDFKit to the application build. Supply a disposable output
folder, never the source PDF's location.

```sh
swiftc -module-cache-path .dev-isolate/pdf-lib-spike/swift-cache \
  scripts/spikes/mupdf-export/verify-pdfkit.swift \
  -o .dev-isolate/pdf-lib-spike/verify-pdfkit

.dev-isolate/pdf-lib-spike/verify-pdfkit \
  .dev-isolate/pdf-lib-spike/output/pdf/annotation-specimen.pdf \
  .dev-isolate/pdf-lib-spike/output/pdf/annotation-specimen-prepared.json \
  .dev-isolate/pdf-lib-spike/pdfkit-check
```

The selected writer passed on the 50-mark specimen and the real literature PDF. PDFKit removed
`/NM` identifiers on its subsequent save for both engines, while retaining types/comments. Export
therefore remains one-way; stable IDs in our output do not promise preservation by external editors.
Do not relax the PDF object tests or claim external round-trip synchronization on this evidence.
PDFKit is an additional independent reader, not certification of the Preview or Acrobat GUI.

Production implementation must keep export off the reading/scrolling path, load the writer only
when requested, support cancellation and bounded concurrency/resources, and publish a separate
file atomically. Password-protected, signed or malformed inputs need an explicit policy before
release. Cross-viewer interactive/printing QA and a larger real corpus remain release checks;
these do not change the selected writer for the current annotation-export scope.
