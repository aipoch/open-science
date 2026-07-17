# Open-source Office preview implementation

Date: 2026-07-16
Status: implemented and verified
Scope: read-only preview for managed local files; no editing and no third-party upload

## Decision

Use a dedicated browser renderer for each Office format. The renderer process consumes bytes from the existing managed-file IPC boundary and dynamically imports only the implementation needed for the current file.

| Formats  | Package                                                                                                                    | Pinned version | License    |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | -------------: | ---------- |
| DOCX     | [`docx-preview`](https://github.com/VolodymyrBaydalka/docxjs)                                                              |        `0.4.0` | Apache-2.0 |
| XLS/XLSX | [`@file-viewer/renderer-spreadsheet`](https://github.com/flyfish-dev/file-viewer/tree/main/packages/renderers/spreadsheet) |       `2.1.29` | Apache-2.0 |
| PPTX     | [`@aiden0z/pptx-renderer`](https://github.com/aiden0z/pptx-renderer)                                                       |        `1.2.4` | Apache-2.0 |

Package preflight uses [`saxes`](https://github.com/lddubeau/saxes) `6.0.0` (ISC) for strict, streaming XML validation without constructing an attacker-controlled DOM.

This route is fully local, requires no Office installation or conversion service, and fits the existing per-format preview registry. It also avoids shipping an editor or a second file-workbench UI.

Supported formats are `.docx`, `.xls`, `.xlsx`, and `.pptx`. Legacy `.doc` and `.ppt`, encrypted packages, malformed packages, and ZIP64 packages intentionally fall back to the normal unsupported-preview state.

## Why per-format renderers

No single mature open-source browser package met all of these requirements at the time of evaluation:

- acceptable coverage across Word, Excel, and PowerPoint;
- direct offline rendering from local bytes;
- preview-only integration without an editor;
- auditable source and transitive runtime dependencies;
- compatibility with a sandboxed Electron renderer;
- bounded startup and package-size impact.

Dedicated renderers provide a smaller behavioral surface and let each format use the strongest available implementation. They are loaded with dynamic imports, so Office parsing code is not part of application startup.

## Integration

The byte path remains inside the existing managed-file boundary:

```text
PreviewFileItem.path
  -> preload previewResources capability IPC
  -> main-process path validation, stat metadata, and bounded range reads
  -> Uint8Array in the sandboxed renderer
  -> package validation
  -> format-specific renderer
```

The implementation adds `word`, `spreadsheet`, and `presentation` preview formats to the existing registry. It shares one Office lifecycle adapter for loading, timeout, cancellation, failure fallback, and cleanup.

No renderer receives an unrestricted local filesystem path. No temporary copy or conversion file is created.

## Format notes

### DOCX

`docx-preview` has a stable byte-oriented API and the longest maintenance history of the selected packages. The integration disables alternative HTML chunks and comments, does not execute macros or embedded objects, and blocks document links inside the preview surface.

DOCX pagination and font substitution can differ from Microsoft Word because this remains browser layout. Legacy `.doc` is not supported.

### XLS and XLSX

The standalone Flyfish spreadsheet renderer combines a SheetJS-compatible parser with a virtualized table. Only the independent renderer is used; the full Office preset and React wrapper are not installed.

Parsing is forced into a self-hosted module Worker. The adapter handshakes one Worker and injects that same instance into the renderer, preventing the upstream constructor path from falling back to main-thread parsing. Readiness is not reported until the first progressive-render callback.

The adapter also observes the renderer's initial error state. An upstream `parseError` that does not emit a progressive-render callback fails immediately instead of waiting for the outer 30-second timeout.

The renderer depends on `styled-exceljs@0.21.1`, also declared as Apache-2.0. Its provenance and lockfile integrity remain part of dependency-upgrade review because it is maintained as a SheetJS-compatible fork.

### PPTX

`@aiden0z/pptx-renderer` parses OOXML directly into HTML/SVG. The integration enables its recommended ZIP limits, lazy slide/media parsing, and a windowed slide list. PDF embedding is disabled.

The viewer is constructed explicitly before `open()`, so an instance is always available for cleanup when package loading or initial rendering fails.

Animations, videos, uncommon SmartArt, legacy `.ppt`, and exact Microsoft font metrics can degrade or remain unsupported.

## Security and resource limits

Office files are attacker-controlled containers. The preview boundary therefore applies these controls before handing bytes to a third-party renderer:

- maximum compressed Office file size: 50 MiB, checked against authoritative main-process stat metadata before any range transfer;
- maximum compressed DOCX size: 10 MiB, also checked before transfer, because DOCX rendering is main-thread DOM work;
- maximum ZIP entries: 4,000;
- maximum actual decompressed entry size: 32 MiB;
- maximum actual decompressed total: 32 MiB for DOCX and 256 MiB otherwise;
- actual streaming DEFLATE byte counts must match central-directory metadata;
- local-header and central-directory filenames must match byte-for-byte, and Unicode Path extra fields are rejected so validation and rendering cannot resolve different OOXML part names;
- relationship XML is limited to 4 MiB per entry, parsed before rendering, and all external relationships are rejected;
- captured XML is validated one entry at a time and released instead of accumulating across the package;
- every DOCX XML part is limited to 8 MiB and counted with streaming SAX before renderer DOM work, with per-part limits of 100,000 elements and a depth of 128;
- encrypted, multi-disk, ZIP64, unsupported compression, and invalid package layouts are rejected;
- a 30-second preview deadline covers validation, Worker startup, parsing, and first paint;
- DOCX resources are inlined to avoid detached Blob URLs; each render owns a child target that is detached on file change, preventing an unabortable stale renderer from overwriting the current preview;
- render instances and generated DOM are disposed on failure, file change, timeout, and unmount, including spreadsheet parse errors and PPTX `open()` failures.

The Electron renderer retains `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. CSP permits only the application's bundled Worker and font resources. Main-process external navigation accepts only HTTP(S), while clicks generated inside Office content are suppressed.

## Verification record

The original implementation was exercised in the real Electron shell with generated DOCX, XLS, XLSX, and PPTX samples. Verification covered multipage Word content, formulas and multiple spreadsheet tabs, and a two-slide presentation with text and a table. Request interception observed no HTTP(S) traffic during any Office preview.

The packaged macOS application was also launched from its `app.asar`; the Office chunks and local Workers loaded successfully, preload APIs were present, and the test session produced no console errors or warnings.

Automated coverage includes format detection, managed byte routing and pre-read limits, ambiguous ZIP filename rejection, package limits and malformed metadata, real DEFLATE expansion counting, external relationship rejection, complexity limits across all DOCX XML parts, legacy XLS magic detection, same-instance Worker injection, spreadsheet parse-error propagation, stale-render isolation, PPTX failure cleanup, lifecycle cancellation, first paint, CSP, and external-navigation policy. A real PDF.js 5 smoke test loads a generated PDF and builds its page rendering operators rather than mocking the engine.

## Accepted limitations

- Browser-rendered Office documents are not pixel-identical to Microsoft Office.
- DOCX parsing itself cannot be interrupted while synchronous library work owns the renderer thread; the lower compressed and expanded limits are the hard boundary for that path.
- The spreadsheet renderer is newer than `docx-preview`; pinned versions, audit results, Worker behavior, and real sample output should be rechecked on every upgrade.
- Supporting legacy `.doc` or `.ppt` would require a separate conversion layer such as LibreOffice-to-PDF and is outside this preview-only browser implementation.
