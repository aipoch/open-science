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
