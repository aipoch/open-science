# Literature Library

Repository-local npm package for reference identity, import and Inbox decisions, collection and item lifecycle, metadata commit receipts, duplicate merges, and headless client state.

- `@aipoch/literature-library`: `LibraryImporter`, `LibraryTransaction`, duplicate algorithms and batch merge orchestration.
- `@aipoch/literature-library/item`: lightweight item snapshot validation without catalog, discovery, journal or screening workflows.
- `@aipoch/literature-library/contracts`: validated inputs, outputs and public domain types.
- `@aipoch/literature-library/client`: injected client workflows for paging, selection, metadata editing, creation recovery and exports. Safe to bundle for browsers; no React or transport dependency.

Construct `LibraryTransaction` with a `LibraryStore` bound to one active transaction. Reads must observe preceding writes; any thrown error must roll back all writes. The host controls admission, commit, events, authorization and foreign relationships. `mergeLiteratureDuplicates` requests one transaction per group and publishes successful groups only after that transaction resolves.

Client owners accept public API callbacks. Compose an owner once per mounted workflow. React scheduling, localization, file transfers and native dialogs remain with the caller. Creation retries retain the original receipt, destination and file until reset; serialize submissions and reset only after pending work completes.

No host source, ORM client, Electron or global `window.api` is imported. Public contracts preserve existing serialized values; this extraction introduces no database migration or new persisted state.

`npm test` builds and runs this package's independent fixtures. From the repository, `npm run check:packages -- --packages=literature-library` also verifies packed production consumption outside the repository.

Unit tests import this package's source entrypoints so coverage measures the code they execute. Packed-consumer checks import the package name and its public exports from a clean production install.

## Import-only consumers

Use `LibraryImporter` with the exported `LibraryImportStore` when only importing or previewing
references. Its eight storage methods cover identity lookup, ordinary collections, item creation,
restoration and metadata supplementation. It requires no project, Inbox, screening, merge or PDF
annotation methods. `LibraryTransaction` inherits this implementation and adds the full Library
workflows; existing consumers retain the same API and transaction rules.

```ts
import { LibraryImporter, type LibraryImportStore } from '@aipoch/literature-library'

// The adapter implements LibraryImportStore inside an active transaction.
const receipt = await database.transaction(async (store: LibraryImportStore) => {
  const importer = new LibraryImporter(store)
  const preview = await importer.inspectImportItems(items, [])
  // Present preview before committing in an interactive workflow; import rechecks identities.
  return importer.importItems(items, undefined, 'reuse')
})
```

The caller must roll back **all** writes when an operation rejects, including after partial writes.
Implement ordinary collection methods even if the consumer currently imports into the library root;
returning a missing collection must reject collection-specific import rather than silently dropping
membership. `test/packed-runtime.mjs` demonstrates a consumer that provides exactly this port.

## Host and future plugin boundary

These packages are headless domain capabilities. A host adapter owns database connections,
transactions, permissions, immutable file leases and cross-domain reference protection. The
Open-Science host uses two explicit integration ports:

- `ContentRepository` requires `ContentReferences`: bulk reference discovery followed by a final
  check in the deletion transaction. `persistentContentReferences` owns the Prisma table queries
  for uploads, artifacts, Literature attachments and Inbox PDFs. It remains installed for the
  database lifetime, including when Literature is disabled; lookup failures retain content.
- Session export accepts an optional `PackageLiteratureSource`. The Literature adapter supplies
  validated live version identities and item metadata. Ordinary sessions and already archived
  snapshots work without it; export of live Literature references fails when it is absent.
  Imported snapshots remain package-owned Upload copies rather than creating Library rows.

Renderer consumers use `src/renderer/src/pages/literature/public/` entries: `page` for lazy
Library mounting, `queries` for paged reads and candidate selection, `events` for invalidation subscriptions, and
`components` for journal attributes. Search and Workspace no longer import private page files.
The entrypoints remain host React/transport integrations; the architecture guard prevents new
private imports and keeps the full Library page out of eager entrypoints. The shared workflow
dialog frame lives in renderer UI so PDF annotation reconciliation does not depend on Literature
import UI. Released database migrations remain immutable and host-owned; disabling a feature
must not remove its tables or migration ledger.

These are host integration contracts, not npm exports of this package. Schema migrations,
file lifecycle authority and UI registration remain host-owned. Package independence and these
ports do not yet establish plugin unloadability: disabling a future plugin must preserve durable
references and historical metadata, and removing its schema needs a separate migration policy.

The public-entry design follows capability-based subpaths supported by
[Node exports](https://nodejs.org/api/packages.html#package-entry-points). The separation of domain
capabilities from integrations is comparable to [Citation.js core and format plugins](https://github.com/citation-js/citation-js)
and [Tiptap's headless API](https://tiptap.dev/docs/editor/getting-started/overview).

## Renderer host ports and lifecycle

The renderer integration requires `LiteratureRendererProvider` from `public/host`. Its explicit
host port supplies the Library transport, selected navigation/project/tag/settings state, project
creation UI and PDF preview/reveal callbacks. The application adapter is
`src/renderer/src/lib/literature-renderer-host.ts`; the feature contains no `window.api` access or
runtime imports of application stores, Home or Workspace implementations. Shared React UI, browser
DOM APIs, i18n and host contract types remain renderer integration dependencies.

Keep the host stable while mounted. Page switches within the provider retain pending attachment
operations; unmounting the provider releases subscriptions. Mount a new provider for a new plugin
instance, including when reusing the same host ports: journal caches and attachment operations are
isolated by provider identity, so a late response from the old instance cannot populate the new one.
Changing a mounted provider's host is rejected; replace its React `key` to remount deliberately.

```tsx
import { LiteratureRendererProvider } from './pages/literature/public/host'
import { LiteratureLibraryPage } from './pages/literature/public/page'

;<LiteratureRendererProvider key={pluginInstanceId} host={hostPorts}>
  <LiteratureLibraryPage />
</LiteratureRendererProvider>
```

`public/queries` exports `createLiteratureQueries(getApi)` for non-React hosts. It reads the supplied
transport at invocation time and has no React, global bridge or page dependency. Package-only
consumers can use `createLiteratureClient` from `@aipoch/literature-library/client` directly.

Backend lifecycle uses existing host owners rather than a second plugin manager:

1. Unmount UI and stop admitting new commands: `registerLiteratureApplicationCommands` returns an
   idempotent `uninstall()` and `whenIdle()`. Uninstall aborts admitted cancellable PDF imports;
   `whenIdle()` waits for their rollback and for admitted non-cancellable operations to settle.
2. Dispose the functions returned by `AgentMcpHttpHost.registerLiterature` and
   `registerLiteratureLibrary`. They stop only their own capability's requests, abort active lookup,
   and cannot unregister a newer installation, even if it reuses the same handler.
3. Await command quiescence and the existing batch-job `close()` / screening `dispose()` owners
   before releasing their database or file dependencies. A drain timeout is not permission to
   remove durable data; keep ownership until the pending operation settles.
4. Recreate stopped owners and register again to enable the feature. Keep migrations, persisted
   references, PDFs, annotations, citation styles and archived export metadata with the host.
   Uninstalling capability registration never deletes these records.

These ports support integration and controlled teardown; they do not add a marketplace, dynamic
plugin loader, or a separately published React UI package. Packed npm domain packages remain the
standalone consumption boundary.
