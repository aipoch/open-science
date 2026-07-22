# Open-source Office preview implementation

Date: 2026-07-22
Status: implemented with automated verification
Scope: read-only preview for managed local files; no editing and no third-party upload

## Decision

Use a dedicated sandboxed `WebContentsView` runtime for Office previews, with a format-specific adapter selected inside that isolated renderer. The runtime consumes an owner-scoped managed-file capability over the local preview protocol and dynamically imports only the implementation needed for the current file.

| Formats  | Package                                                                                                                    | Pinned version | License    |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | -------------: | ---------- |
| DOCX     | [`docx-preview`](https://github.com/VolodymyrBaydalka/docxjs)                                                              |        `0.4.0` | Apache-2.0 |
| XLS/XLSX | [`@file-viewer/renderer-spreadsheet`](https://github.com/flyfish-dev/file-viewer/tree/main/packages/renderers/spreadsheet) |        `2.2.3` | Apache-2.0 |
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

The byte path remains inside the managed-file boundary and never enters the parent UI renderer:

```text
PreviewFileItem.path
  -> parent preload Office preview IPC
  -> main-process path validation, authoritative stat, and runtime supervision
  -> owner-scoped capability for one sandboxed Office WebContentsView
  -> local preview protocol streaming from a pinned file handle
  -> Uint8Array in the isolated Office runtime
  -> package validation
  -> format-specific renderer
```

The implementation adds `word`, `spreadsheet`, and `presentation` preview formats to the existing registry. The parent renderer owns only status UI, download/retry actions, host measurement, and native-view positioning. One supervisor owns timeout, memory, cancellation, capability, and child-process cleanup for all Office formats.

No renderer receives an unrestricted local filesystem path. No temporary copy or conversion file is created.

## Format notes

### DOCX

`docx-preview` has a stable byte-oriented API and the longest maintenance history of the selected packages. The integration disables alternative HTML chunks and comments, does not execute macros or embedded objects, and blocks document links inside the preview surface.

DOCX pagination and font substitution can differ from Microsoft Word because this remains browser layout. Legacy `.doc` is not supported.

### XLS and XLSX

The standalone Flyfish spreadsheet renderer combines a SheetJS-compatible parser with a virtualized table. Only the independent renderer is used; the full Office preset and React wrapper are not installed.

Parsing is forced into a self-hosted module Worker inside the isolated Office runtime. The adapter handshakes one Worker and injects that same instance into the renderer, preventing the upstream constructor path from falling back to runtime-main-thread parsing. Readiness is not reported until the first progressive-render callback.

The adapter also observes the renderer's initial error state. An upstream `parseError` that does not emit a progressive-render callback fails immediately instead of waiting for the outer 30-second timeout.

The renderer depends on `styled-exceljs@0.21.1`, also declared as Apache-2.0. Its provenance and lockfile integrity remain part of dependency-upgrade review because it is maintained as a SheetJS-compatible fork.

### PPTX

`@aiden0z/pptx-renderer` parses OOXML directly into HTML/SVG. The integration enables its recommended ZIP limits, lazy slide/media parsing, and a windowed slide list. PDF embedding is disabled. A pinned-version adapter installs the bounded media URL cache with runtime shape checks and reads the lazy resolver through the public `presentationData` getter.

The viewer is constructed explicitly before `open()`, so an instance is always available for cleanup when package loading or initial rendering fails.

Animations, videos, uncommon SmartArt, legacy `.ppt`, and exact Microsoft font metrics can degrade or remain unsupported.

## Security and resource limits

Office files are attacker-controlled containers. The preview boundary therefore applies these controls before handing bytes to a third-party renderer:

- maximum compressed Office file size: 40 MiB for DOCX, XLS, XLSX, and PPTX, checked against authoritative main-process stat metadata before capability creation;
- maximum ZIP entries: 4,000;
- maximum actual decompressed entry size: 32 MiB, except XLSX worksheet parts may use the 256 MiB total-expansion budget;
- maximum actual decompressed total: 128 MiB for DOCX and 256 MiB for XLSX/PPTX;
- maximum PPTX media total: 192 MiB;
- actual streaming DEFLATE byte counts must match central-directory metadata;
- local-header and central-directory filenames must match byte-for-byte, and Unicode Path extra fields are rejected so validation and rendering cannot resolve different OOXML part names;
- relationship XML is limited to 4 MiB per entry and parsed before rendering; external active-resource relationships are rejected, while hyperlinks are retained as text and neutralized in the preview UI;
- captured XML is validated one entry at a time and released instead of accumulating across the package;
- every DOCX XML part is limited to 8 MiB and counted with streaming SAX before renderer DOM work, with per-part limits of 100,000 elements and a depth of 128;
- encrypted, multi-disk, ZIP64, unsupported compression, and invalid package layouts are rejected;
- preview deadlines cover validation, Worker startup, parsing, and first paint: 30 seconds by default and 120 seconds above 20 MiB; retry uses one fixed doubled allowance rather than compounding;
- the supervisor terminates a runtime whose process usage exceeds 1,536 MiB;
- DOCX resources are inlined to avoid detached Blob URLs; each render owns a child target that is detached on file change, preventing an unabortable stale renderer from overwriting the current preview;
- render instances and generated DOM are disposed on failure, file change, timeout, and unmount, including spreadsheet parse errors and PPTX `open()` failures.

The Office runtime uses `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false` in a unique in-memory partition. CSP permits only bundled code, local capability reads, Blob-backed Workers, and document assets. Permission requests, downloads, navigation, popup creation, and external network requests are denied inside the runtime.

## Verification record

Automated coverage includes format detection, main-process admission and snapshot enforcement, strict protocol streaming, process isolation and memory supervision, ambiguous ZIP filename rejection, format-specific package limits, real DEFLATE expansion counting, external relationship rejection, complexity limits across all DOCX XML parts, legacy XLS magic detection, same-instance Worker injection, spreadsheet parse-error propagation, stale-render isolation, PPTX windowing and pinned-version contract checks, lifecycle cancellation, first paint, CSP, and navigation policy.

Release verification should still exercise real small and large Office samples in the packaged Electron shell, including resize behavior, process teardown, retry deadlines, download-only fallbacks, and confirmation that the Office runtime makes no HTTP(S) requests.

## Accepted limitations

- Browser-rendered Office documents are not pixel-identical to Microsoft Office.
- DOCX library work cannot be interrupted while it owns the Office runtime thread; the 40 MiB compressed limit, 128 MiB expanded limit, timeout, and supervised process boundary contain that path without blocking the parent UI renderer.
- The spreadsheet renderer is newer than `docx-preview`; pinned versions, audit results, Worker behavior, and real sample output should be rechecked on every upgrade.
- Supporting legacy `.doc` or `.ppt` would require a separate conversion layer such as LibreOffice-to-PDF and is outside this preview-only browser implementation.
