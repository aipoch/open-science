# PDF notes and annotations

## Ownership and persistence

A note belongs to an immutable managed PDF version, not to the conversation that happened to display
it. The document identity includes source kind, managed file ID, version ID, checksum, and (for
project-managed uploads/artifacts) project ID. Merely having the same filename or bytes does not
merge two independently managed files.

| Source                     | Owner                            | Sharing                                                    | Lifetime                                                                                   |
| -------------------------- | -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Literature attachment      | Attachment version               | Library and every project/session referencing that version | Trash hides it; permanently deleting the attachment/item removes notes and Tag assignments |
| Project upload/artifact    | Project + managed file version   | Every session opening that version                         | Deleting the creating conversation retains notes; deleting the project removes them        |
| New version or copied file | Its own managed version identity | Separate notebook                                          | Notes are not silently reassigned to different bytes                                       |

`PdfAnnotation` stores the ID, source identity, versioned selector JSON, mark kind/color, comment,
origin (`user`/`imported`), optional native subtype, and timestamps. `sessionId` records the context
that created the annotation and may be absent for creation through a global modal.
`sourceSessionId` records the managed file's original context. Neither field filters the document's
notebook. Undo restores the original creation context and timestamp.

Selectors represent text (quote, text offset, page and normalized quads), an area (page and normalized
rectangle), a page note, or a document note. Coordinates are independent of zoom. Area cards show a
coordinate preview; they do not persist a raster crop of the PDF. Changes do not rewrite source PDF
bytes. Export writes a separate annotated PDF.

Tags use the existing global `Tag`/`TagAssignment` model with resource type `pdf.annotation`.
Annotation changes and associations commit in one SQLite transaction. A deleted global Tag is also
removed from undo replay. `PdfAnnotationImport` stores a document-level native import receipt,
including native PDF object references: deleting an imported mark does not cause it to reappear on
reopening the document.

This is an **unreleased feature**. The final schema replaces the development schema; compatibility
with earlier branch-only annotation databases is intentionally not supported. Clear only the
isolated PDF review data when changing those development schemas. Existing production data from
main still receives the normal application migration sequence; no production data reset is added.
One migration, `0043_pdf_annotations`, creates both final tables and their indexes and constraints.
It reuses the existing global Tag tables without introducing intermediate PDF schemas or backfills.

## Architecture and correctness

- **Main process:** validated application commands → annotation service → repository transactions.
  Creation resolves an immutable file version and verifies its content lease, source identity and
  checksum. A supplied active session retains its mutation/read-only authority checks; direct
  document operations check the live project and its deletion intent. Library operations validate
  their attachment owner. Renderer-provided paths are never trusted as file-read authority.
- **Renderer:** the workspace supplies editing authority without eagerly fetching all its PDFs.
  Each open PDF owns one document-scoped `PdfAnnotationsProvider`, reused between the PDF overlay,
  full notebook and notes sidebar. A direct Tag/search modal also owns just one provider.
- **Synchronization:** list IPC uses bounded keyset pages. A single-record change reads and merges
  that record; an unscoped batch event refreshes only the open document. Local commands and remote
  reconciliation share a queue; overlays prevent an older paged response overwriting a committed
  edit. Tag metadata changes do not reload the notebook.
- **Conflicts and history:** updates/deletes use `expectedUpdatedAt` compare-and-swap tokens. The
  last 100 local history operations support undo/redo per document; external edits invalidate the
  affected document's stale history. History is in memory, not a durable audit log. It is not
  restored after restarting or closing the owning preview.
- **Search and navigation:** global search includes saved notes and text quotes under Library,
  alongside references and collections. It reads SQLite text, never renders or reparses a PDF.
  Selecting a search result previews the note and quoted text separately in the detail pane; its
  source action (or double-click/Enter on the result) opens the PDF modal. Settings Tags also open
  the PDF modal directly, without changing the current page or opening the bibliographic modal
  first. File/version identity drives location recovery.

Chat message annotations, saved Bookmarks and temporary “Read with agent” context remain separate
resources. They are not automatically duplicated into the PDF notebook. A PDF mark's saved comment
belongs here; text attached to a chat message belongs to that message. Session packages do not
implicitly transfer this document notebook. An annotated PDF or Markdown/CSV export is the explicit
portable output.

## Interaction

- Original PDF, Figures & Tables, and Notes & Annotations share a compact tab bar; narrow labels
  truncate with tooltips. Toolbar actions remain on one row at narrow widths.
- Native text/area marks can be selected, edited, recolored, tagged and deleted. Backspace/Delete
  acts on the selected mark outside editable fields. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z use document
  history. Tooltips behave consistently in modal and side preview.
- Cards do not navigate when their body is clicked. Their source-arrow action returns to the PDF.
  Quotes/comments have bounded multiline previews; editing exposes the full comment.
- Tags follow the global order, use an internal hover/focus remove button, and collapse overflow
  rather than increasing the card header's height. The add control stays in a stable position.
- One Add note menu creates page or document notes. Page and Tags share the metadata row; Save and
  Cancel remain separate from the tag chooser. Search/filter controls are initially collapsed.
  Notebook search waits 250 ms after typing, suspends filtering during IME composition, and clears
  immediately. Search result rows keep comments and quoted excerpts on separate lines.
- At sufficient **reader-container** width (1120 px after navigation), a notes toggle opens a
  right-hand sidebar. Its default width is 320 px, adjustable from 300–420 px while reserving at
  least 752 px for the reader. All notes are grouped by page; Current page follows the PDF page.
  Narrowing the reader hides the sidebar without discarding its draft. The full notebook remains
  accessible at every width. Left navigation and right notes use opposite tab-bar corners.

## Performance and limits

The page/source index avoids scanning every annotation on every visible PDF page. The notebook
initially mounts 100 cards, with **Load more** adding 100 at a time. Search, filters and export still
operate on the whole loaded document; this is progressive rendering, not a virtualized list.
Editing keeps the active card mounted. The provider still loads all records for that document in
100-record IPC pages, so data transfer, indexing and sorting remain proportional to its size.

Native PDF parsing runs in a main-process worker with one active parser lane and throttled progress.
Only persistence takes the session mutation barrier. The importer caps supported marks at 500 and
unsupported records at 5000 and reports truncation; it does not silently claim a complete import.
PDF export runs in a renderer worker, with a 128 MiB input cap, a 20,000-mark cap and a 90-second
timeout. Markdown and CSV are the note export formats.

Notebook and parser measurements, reproduction commands and their limitations are documented in
[pdf-native-annotation-benchmark.md](pdf-native-annotation-benchmark.md). Remaining scaling work:

1. Global note search uses SQLite substring predicates over comments/quote JSON, not FTS. Measure
   large real libraries before introducing a separately synchronized text index.
2. Repeated Load more can eventually mount the full document. Continuous scrolling through tens of
   thousands of notes warrants variable-height virtualization; current-page view remains bounded
   by that page's marks.
3. Open views have separate command/history owners. Events synchronize their records, but there is
   no shared cross-window undo stack. Multiple open PDFs also retain their own loaded annotation
   arrays and can request the shared Tag snapshot concurrently.
4. Current tests do not establish GPU/frame-rate guarantees for image-heavy PDFs or all platforms.
   PDF canvas overscan is unchanged; reducing it without evidence can expose blank pages.
