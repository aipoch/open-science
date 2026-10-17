# PDF structure extraction

An in-repository npm package for bounded, offline PDF figure/table extraction. It has its own
build, declarations, dependencies, worker assets and tests. It supports ordinary Node >=22.13.0.

## Public API

- `@aipoch/pdf-structure`: `createPdfStructureEngine`, `readWorkerResult`, and engine/runtime types.
- `@aipoch/pdf-structure/result`: result schemas, decoding-budget validation,
  `decodePdfStructureResult`, `parsePdfStructureResult`, and result/identity types. This entry is
  browser-safe and does not load native libraries or Node modules.

No implementation paths are exported. `readWorkerResult` is the bounded worker protocol decoder
for integrations that supply their own supervisor; most consumers should use the engine.

```ts
import { createPdfStructureEngine } from '@aipoch/pdf-structure'
import { parsePdfStructureResult } from '@aipoch/pdf-structure/result'

const engine = createPdfStructureEngine({ modelRecipe })
const recipe = await engine.describe()
const job = engine.start({ inputPath, model, identity, signal, onProgress })
try {
  const result = parsePdfStructureResult(await job.result, identity)
  // Persist result and job.thumbnails through the caller's cache owner.
} finally {
  await job.stop()
}
```

`modelRecipe` is the complete immutable recipe, including its revision and asset checksums. All
fields participate in the engine fingerprint. `model.assets` supplies verified local asset paths;
the package never downloads models or chooses an application model revision. The current worker
requires the existing Table Transformer detection/structure weights and ONNX Web 1.29.0 WASM
runtime. Model files live together, including `ort.wasm.min.mjs`, its WASM module and binary.

`identity` contains a UUID extraction ID, SHA-256 engine/source fingerprints, source byte length,
and 1–5 page numbers. Input is limited to 50 MiB. Supply a **disposable immutable PDF snapshot in
its own job directory**. The supervisor can remove that snapshot when its parent disappears.
Never pass an original document or a directory shared with other jobs. The caller owns authorization,
snapshot acquisition, model leases, cache publication, scheduling and lease release.

The default runtime owns a single ordinary Node child with Worker threads. An application can
inject `runtime.spawn(entry)` and `runtime.stop(child)` to use its process-tree supervisor. `stop`
must confirm termination before resolving. Engine stop waits for conversion before deleting scratch;
a rejection requires retry and retention of the caller's file/model leases. Each start needs a unique
job directory. This package adds no persistent queue, database, or application states.

## Development and verification

```sh
npm ci
npm run build
npm test
npm run test:pack
```

Run these in this directory. Root application installation also builds this package. Package tests
use package-relative fixture paths and need no application setup or database. The full repository
`npm test` still includes them; the CI package selector can exclude this unchanged upstream package
when only a downstream application changes. Host cache, source-authority and owner tests remain in
`src/main/literature/pdf-structure` and continue to run with the application.

`test:pack` installs the real tarball in a fresh temporary consumer, checks public exports and
TypeScript declarations, rejects internal imports, and starts/cancels the real worker. To additionally
exercise successful inference with existing reviewed local assets and a real PDF:

```sh
npm run test:pack -- --model-assets /absolute/model-assets --pdf /absolute/paper.pdf --page 1 --expect-elements
```

The test copies input into its own job directory, validates result identities and thumbnails, and
removes temporary files only after the job has stopped. Model assets and original PDFs are read-only.
Tests do not download weights. Standard npm dependency installation may require registry access.

The extraction resources and existing result format are unchanged by this move. No historical-data
migration, new state enumeration, or cache-directory change is introduced. Fingerprints remain equal
for identical model recipes, resource bytes and installed dependency versions.

Result-schema and worker-decoding matrices belong to this package's `test/` directory, including
geometry, source provenance, decoding budgets and historical optional fields. Host tests retain
representative result/thumbnail cache round trips, source authority, model leases and process
supervision. Do not duplicate every decoder case through the host cache or lifecycle owner.
