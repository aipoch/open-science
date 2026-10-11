# @aipoch/pdf-translation

Independent PDF translation workflow: extraction and batching, job ownership and recovery,
layout, output generation, checkpoints, usage recording and generated-PDF caching.

## Public API

| Export | Responsibility | Environment |
| --- | --- | --- |
| `@aipoch/pdf-translation` | `PdfTranslationOwner`, options and inference/checkpoint/local-runtime/lease capability types | Node |
| `/contracts` | Validated requests, checkpoints, snapshots | Node or browser |
| `/text` | Batching, language support, numeric and recovery rules | Node or browser |
| `/reader` | Source extraction, text reconstruction, layout and presentation helpers | Node or browser |
| `/writer` | `PdfTranslationWriter`, worker lifecycle and output generation | Node |
| `/storage` | Checkpoint, cache and usage owners and revisions; database and repository capability types | Node |
| `/resources` | Packaged worker/font resource paths | Node |

Import only these capability entries. Internal file paths are not API. Each entry has generated
TypeScript declarations. Required interface changes migrate in-repository consumers together.

## Ownership and integration

Create one translation owner per service. It owns job state, cancellation, checkpoint progression
and recovery; the writer owns its workers. Shut down the owners before releasing their host
capabilities. A caller lease invalidated by reload or disconnect stops that caller's operation.
Package tests exercise success, failure, cancellation, retries and cleanup.

The host supplies inference execution, provider error interpretation, diagnostics, write admission,
source authorization, application paths and storage connections. Model/account/Agent lifetimes,
credential access, global usage aggregation, process supervision and application shutdown stay
in the host. Do not place domain decisions in these adapters.

The storage implementation owns translation checkpoint and usage rules. Authorization and
PDF document registration execute in the **same host database transaction** as checkpoint writes.
It never creates a separate database or migrates the application's schema. The shared
`@aipoch/pdf-document-contract` defines PDF source identity; structural results come through
`@aipoch/pdf-structure/result`. Both are declared dependencies, without host source imports.

## Build and verification

With declared dependencies installed, run `npm run build`, `npm test`, and `npm pack` here.
Supply local sibling packages as matching npm tarballs when installing outside the repository.
From the repository root, `npm run build:pdf-packages` builds in dependency order and
`npm run check:pdf-packages` checks isolated source builds/tests, production tarball consumers,
strict declarations, browser entries and rejection of private imports. The checker uses an
existing npm cache (`--offline`) and writes its evidence outside the source tree by default.

Host tests retain authorization, transactions, transport, resource assembly and UI integration.
CI selects changed packages and their downstream consumers; host-only changes exclude unchanged
package suites. Global dependency/toolchain changes retain conservative selection. The full
root `npm test` still includes package tests.

## Persistence and compatibility

Extraction preserves checkpoint/usage table names, serialized formats, cache magic and paths,
status values and source identity. No database migration, new state or historical-data conversion
is introduced. The host retains schema ownership and cross-domain transaction boundaries.
