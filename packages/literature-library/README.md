# Literature Library

Repository-local npm package for reference identity, import and Inbox decisions, collection and item lifecycle, metadata commit receipts, duplicate merges, and headless client state.

- `@aipoch/literature-library`: `LibraryTransaction`, duplicate algorithms and batch merge orchestration.
- `@aipoch/literature-library/contracts`: validated inputs, outputs and public domain types.
- `@aipoch/literature-library/client`: injected client workflows for paging, selection, metadata editing, creation recovery and exports. Safe to bundle for browsers; no React or transport dependency.

Construct `LibraryTransaction` with a `LibraryStore` bound to one active transaction. Reads must observe preceding writes; any thrown error must roll back all writes. The host controls admission, commit, events, authorization and foreign relationships. `mergeLiteratureDuplicates` requests one transaction per group and publishes successful groups only after that transaction resolves.

Client owners accept public API callbacks. Compose an owner once per mounted workflow. React scheduling, localization, file transfers and native dialogs remain with the caller. Creation retries retain the original receipt, destination and file until reset; serialize submissions and reset only after pending work completes.

No host source, ORM client, Electron or global `window.api` is imported. Public contracts preserve existing serialized values; this extraction introduces no database migration or new persisted state.

`npm test` builds and runs this package's independent fixtures. From the repository, `npm run check:packages -- --packages=literature-library` also verifies packed production consumption outside the repository.

Unit tests import this package's source entrypoints so coverage measures the code they execute. Packed-consumer checks import the package name and its public exports from a clean production install.
