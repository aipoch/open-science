# @aipoch/pdf-translation

Independent PDF translation workflow: extraction and batching, job ownership and recovery,
layout, output generation, checkpoints, usage recording and generated-PDF caching.

## Public API

| Export                    | Responsibility                                                                               | Environment     |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------- |
| `@aipoch/pdf-translation` | `PdfTranslationOwner`, options and inference/checkpoint/local-runtime/lease capability types | Node            |
| `/contracts`              | Validated requests, checkpoints, snapshots                                                   | Node or browser |
| `/text`                   | Batching, language support, numeric and recovery rules                                       | Node or browser |
| `/reader`                 | Source extraction, text reconstruction, layout and presentation helpers                      | Node or browser |
| `/writer`                 | `PdfTranslationWriter`, worker lifecycle and output generation                               | Node            |
| `/storage`                | Checkpoint, cache and usage owners and revisions; database and repository capability types   | Node            |
| `/resources`              | Packaged worker/font resource paths                                                          | Node            |

Import only these capability entries. Internal file paths are not API. Each entry has generated
TypeScript declarations. Required interface changes migrate in-repository consumers together.

## Standalone backends

Supply only the backend you use: `captureTarget` + `runner` for Agent translation,
`captureApiTarget` + `apiRunner` for direct API translation, or `localRunner` for a local model.
No Agent runner, profile cleanup or application settings are required for API-only or local-only use.
`begin` rejects an unavailable route with `PdfTranslationError.code === 'unsupported-model'`
before admitting work. An omitted `targetId` still selects Agent translation for compatibility.
Shutdown drains work and closes the configured runners; usage recovery/flush applies to every route.

```ts
import { PdfTranslationOwner } from '@aipoch/pdf-translation'

const owner = new PdfTranslationOwner({
  usage, // Transactional usage sink owned by this consumer.
  captureApiTarget: async () => ({ providerId: 'my-provider', model: 'my-model' }),
  apiRunner: {
    supportsTarget: () => true,
    run: ({ prompt, systemPrompt, signal }) => translate({ prompt, systemPrompt, signal })
  }
})
try {
  const operation = await owner.begin(
    {
      targetId: 'api',
      resourceRequestKey: 'document:1',
      fingerprint: sourceFingerprint,
      language: '中文',
      glossary: [],
      sources: ['Cell growth is measured.']
    },
    callerLease
  )
  const translated = await owner.translate(
    {
      operationId: operation.operationId,
      sourceIndex: 0,
      source: 'Cell growth is measured.'
    },
    callerLease
  )
} finally {
  await owner.shutdown()
}
```

`translate` above is the consumer's inference implementation; it returns `{ text, stopReason, usage? }`.
The consumer supplies a stable source fingerprint and a caller lease whose signal is aborted on
cancellation. The packed consumer test is a complete executable example using deterministic
inference, and exercises both single-backend configurations through the public package name.

## Ownership and integration

Create one translation owner per service. It owns job state, cancellation, checkpoint progression
and recovery; the writer owns its workers. `PdfTranslationPdfCache.recordLayout` persists the report
through its owner before confirming cache publication; callers must not assemble that ordering.
`confirm` remains a low-level operation for consumers that already own durable report persistence.
Use `pdfTranslationWorkerPath()` when a platform needs to remap a packaged worker path (for example,
Electron ASAR unpacking); do not construct package-internal filenames. Shut down the owners before releasing their host
capabilities. A caller lease invalidated by reload or disconnect stops that caller's operation.
Package tests exercise success, failure, cancellation, retries and cleanup.

Framework identifiers are supplied by the inference adapter; the package does not contain an
application-specific framework allowlist. The host validates its supported frameworks before
admitting a request. Cache publication serializes only owners of the same resolved data root;
unrelated roots do not block each other. Write-admission capabilities need not be reentrant:
pending usage completions flush inside the already-admitted write before a new attempt starts.

Readers may request mixed output with `preserveUnsupported: true` and `preserveUnmatched: true`.
Unmatched source regions then retain their original PDF content, while verified replacements on
the same page continue. The writer protects retained regions from neighboring replacements and
reports their layout failures. Strict callers still reject unmatched sources. Renderer verification
must confirm that retained text and placement survived before displaying or caching the PDF.
The fixed-layout reader also rebuilds a page with original text if post-generation verification fails;
that fallback is checked again, is never published as the translated cache, and runs at most once
per affected page in an automatic recovery sequence.

The desktop translation settings offer an opt-in **Content first** checkbox (off by default).
Its `contentFirst` value is saved in each translation checkpoint and restored when reopening or
switching editions. Historical checkpoints without the option preserve the original PDF layout.
Preparation locates raster images, caption-supported vector diagrams and academic tables with
matching top/header/bottom rules. In Content first mode, text wholly contained in these regions
is excluded from inference requests. The whole table/image stays original; body text and captions
remain eligible. The default layout retains its previous translation admission policy. Uncertain
graphics fall back to ordinary text preparation; page backgrounds and scanned body pages are not
treated as small figures. This policy runs after cached table ownership is applied.
The same local detection also protects tables/images when regenerating historical Content first
editions, without changing saved translations or paragraph indices. New snapshots record atomic
original regions, so table borders, symbols and labels are emitted in one crop rather than as a
list of paragraphs. Original table/figure text is intentionally excluded from reflow text checks.
Content first always retains bibliography text in the source language, even if an older edition
contains translations of it. Extracted formula and code ownership is stored explicitly; these
regions retain original glyphs and code indentation rather than being reclassified as prose.
Captioned pseudocode blocks with numbered/indented control flow use the same code policy.
Inline mathematics stays under the existing identifier/order validation. Inference additionally
requires literal numeric spelling, unit notation, URLs, DOI strings and inline code, and rejects
changed protected occurrences for retry/original fallback. Source superscripts are not rewritten
to caret notation in this mode. Ordinary headings, prose, captions and footnote prose remain eligible.
When selected, the view uses `layout: 'reflow'`: single-column A4 pagination with all
accepted translations, plus original image crops for figures, formulas and untranslated regions.
Page-sized publisher Forms are traversed to locate graphics without duplicating whole source pages.
Pages with no translated replacements are copied intact, so untranslated bibliographies keep their
original columns and pagination. Original footer page numbers are omitted from reflowed pages.
On mixed pages, readable original prose uses text reflow rather than paragraph screenshots.
Column-aware ordering keeps a right-column bibliography after the left-column body; figure
labels without translations are owned by their retained image and are not emitted a second time.
Copied original pages are identified in the preview. Comparison shows an original page once
across its translated continuation pages. Text flow continues across source-page boundaries,
with at least two paragraph lines kept together when possible. Copied original pages end the
current text flow, so bibliography pages remain intact. Each output page records every contributing
source page; comparison and navigation also handle two source pages sharing one output page.
Legacy source IDs and checkpoint indices are preserved.
The reader pins a generation snapshot during translation and keeps the last verified preview
visible. New paragraphs mark the preview as out of date; completion, cancellation or explicit
refresh selects the latest results. A failed refresh leaves the previous preview readable, and
export waits for a preview matching the latest accepted translations.
Output includes source-page mappings and paragraph placements; the reader verifies complete
translated text at those placements, uses them for navigation/highlights, and exports the same PDF.
Reflow candidates bypass the fixed-layout cache. This local step reuses saved text and makes no
inference requests.

Reflow checks native text directions before pagination. Rotated pages and pages with
unsupported text directions retain their complete original page once, including all pages
connected by a translated cross-page paragraph. Other pages continue to use translated text.
The sidebar reports the retained source pages; accepted translations remain readable there.

URI links and direct/named internal destinations are recreated against the output pages.
Literal or verified scientific link labels follow their translated line positions; links inside
retained graphics follow the crop transform. Links from copied pages are also rebuilt so they
cannot point at orphan copies of the old page tree. When a translated link position cannot be
proved, the original page is retained with an `annotations` diagnostic. Fallback extends
across joined paragraphs and connected links so both endpoints remain valid. Internal targets
require a unique owning paragraph or crop; a nearest-paragraph guess is not used. Unresolved
destinations or unsupported link actions retain the complete original document and report the
limitation rather than publish an output with silently missing links. Existing broken links are
not repaired. No extra source-links area is added to the translated document.
Non-link annotations (including comments, highlights and widgets) and AcroForm structures
retain the complete original document with existing diagnostics, preserving annotation
relationships, field values and editability rather than dropping them during reflow.

Exported PDFs preserve the source bookmark titles, hierarchy, styles and expansion state.
Bookmark destinations use the same mapping as internal links, including named destinations.
FitR destinations retain their original target page and all four rectangle coordinates.
Pages whose native bounds do not match the zero-origin viewport also retain their original
content, including unlinked graphics.
An ambiguous destination retains its original page; unsupported actions or malformed bookmark
trees retain the complete original PDF. No nearest-paragraph destination is guessed.

The host supplies inference execution, provider error interpretation, diagnostics, write admission,
source authorization, application paths and storage connections. Model/account/Agent lifetimes,
credential access, global usage aggregation, process supervision and application shutdown stay
in the host. Do not place domain decisions in these adapters.

`PdfTranslationOwner` can run without persistence. Consumers that want resumable editions can
inject `TranslationCheckpointStore`, or use the optional `PdfTranslationCheckpoints` coordinator
with a `TranslationDatabase` implementation. The coordinator owns checkpoint progression,
validation, conflict handling and layout-report reconciliation. Its port exchanges typed domain
snapshots and opaque source/content identities, never SQL statements, database rows or JSON fields.

Consumers own serialization, schema/migrations, connections and resource lifetimes. Transactions
must atomically include source authorization/registration and checkpoint updates; cancellation,
exceptions and failed revision comparisons leave no partial changes. `changedBlock` is an optional
write optimization; a consumer can store complete snapshots. During incremental updates it must
preserve independently pinned layouts and layout reports, unless the commit explicitly replaces
reports. `test/support/checkpoint-memory.ts` demonstrates an object-only transactional consumer;
package workflow tests cover resume, stale writers, authorization and cancellation without a host.

The Open Science SQLite adapter lives in the host. It owns historical identity encoding, JSON
projections, revision sentinel rows and incremental writes, and retains the existing disk format.
The package neither imports nor exports that adapter. Changing a consumer's storage engine or the
package's internal algorithm does not require changing the other side while the public contract
and behavior stay compatible.
Structural results come through the declared `@aipoch/pdf-structure/result` dependency.

## Safety and integration

- **Scope:** PDF translation orchestration and output generation through host-supplied inference and storage.
- **Controls:** Source authorization contracts, caller leases, transactional checkpoints, cancellation,
  and bounded workflow processing preserve the documented ownership rules.
- **Remaining risks:** The inference recipient can receive prepared document content. Translation
  and layout can change meaning, omit text, or misrepresent numbers and units. Checkpoints and usage
  records do not establish translation accuracy or provider-side deletion.
- **Safe integration:** The host must review inference destinations and data permissions, protect
  source/cache/output storage, and enforce execution policy. Retain the original PDF and compare
  consequential passages, tables, and figures before use. See the application's
  [data-recipient notice](https://github.com/aipoch/open-science/blob/main/docs/security.md#data-recipients).

## Build and verification

With declared dependencies installed, run `npm run build`, `npm test`, and `npm pack` here.
Supply local sibling packages as matching npm tarballs when installing outside the repository.
From the repository root, `npm run build:pdf-packages` builds in dependency order and
`npm run check:pdf-packages` checks isolated source builds/tests, production tarball consumers,
strict declarations, browser entries and rejection of private imports. The checker installs online by default and writes evidence outside the source tree. Pass
`--offline` only when the npm cache already contains every required archive.

Host tests retain authorization, transactions, transport, resource assembly and UI integration.
CI selects changed packages and their downstream consumers; host-only changes exclude unchanged
package suites. Global dependency/toolchain changes retain conservative selection. The full
root `npm test` still includes package tests.

## Persistence and compatibility

Extraction preserves checkpoint/usage table names, serialized formats, cache magic and paths,
status values and source identity. No database migration, new state or historical-data conversion
is introduced. The host retains schema ownership and cross-domain transaction boundaries.

### Test ownership

Keep translation acceptance/retry, batching/cancellation, incremental PDF output, cache policy,
checkpoint reconciliation and usage accounting cases in `test/`. Use package-owned fixtures,
caller leases and transactional memory repositories; these suites must run without application
source, Electron or Prisma. Reopen a consumer to test stored progress, while retaining the admitted
writer for operations whose contract includes in-memory reconciliation state.

Application tests cover source/model/error conversion, real caller disconnection, database
transactions and source bindings, data-root migration, usage projection, IPC and ASAR resource
loading. A representative cache/output round trip checks the adapter; the domain-case matrix stays
here. Renaming a host file to `*.integration.test.ts` does not transfer these responsibilities.

### Document information and content-first regeneration

Content-first output preserves ordinary document Info (including custom fields), XMP metadata,
language, independent viewer preferences and embedded files. Attachment file specifications shared
by `Names/EmbeddedFiles` and `AF` stay shared. Ordinary metadata alone does not retain the original
paper: translated body text still reflows. Named destinations (including unreferenced names and
legacy destination dictionaries) and supported opening destinations use the same verified mapping
as links and bookmarks. Page labels follow each output page's primary source page; continuations
keep that source label, and a page combining sources uses its primary source's label. Print ranges
use standard one-based page numbers and include all output pages containing the selected sources.

Structures that cannot be preserved safely retain the exact original PDF with a
`document-structure` layout diagnostic: tagged structure trees, optional-content layers, unsupported
catalog/name-tree features or actions, ambiguous/malformed destinations, invalid page labels or
print ranges, and hidden source-page dependencies in otherwise independent metadata. Nonstandard
zero-based print ranges are not guessed. The existing annotation/form and signature policies still
apply. Text translations remain available in the sidebar after a structural fallback.

Content-first mode does not offer per-paragraph PDF-layout retry. The existing **Update PDF preview**
action can regenerate the whole document from accepted translations, including when the preview
is already current; it does not call a translation model. Text-translation retry and fixed-layout
placement retry keep their existing behavior. The additive diagnostic is saved in the existing
checkpoint layout reports; existing records need no migration. Previously exported PDFs are not
rewritten and must be regenerated to gain this preservation behavior.

Page-sized raster backgrounds are not inserted as ordinary figures beside translated OCR text.
A raster covering more than 85% of the page retains the original page with the existing
`unsupported-layout` diagnostic unless it is contained in an explicit original figure/table region
that does not intersect any translated fragment. Retention extends across joined paragraphs;
independent pages still reflow. This preserves visual content missing from OCR instead of silently
discarding the scan. A verified large figure with a separate caption remains eligible for reflow.
Accepted translations stay available in the sidebar; this adds no state or checkpoint fields.

Original-side internal links retain their source page identity when multiple source pages share a
reflow row. Revealing an annotation from a compared or translated view switches to the original
rendition, scrolls to its source page after that view mounts, and uses the existing region/text
highlight. Figure preparation releases each page's operator-list resources on completion, failure
or cancellation; PDF.js defers cleanup while a shared page is rendering. These fixes introduce no
new saved fields or diagnostic values.
