# @aipoch/notebook-syntax

Tree-sitter grammars and bounded PowerShell syntax parsing. Built and versioned with Open Science; usable as an independent npm tarball.

Node >=22.13.0. Run `npm run build`, `npm run typecheck` and `npm test` in this package.
The repository command `npm run check:notebook-packages` copies each package outside the repository, installs only declared dependencies, runs its checks, and consumes `npm pack` output in a clean application.

Only documented `exports` are public. Do not import `src` or `dist` paths. Public interfaces remain stable; changes requiring caller migration are made atomically in this repository.

The main export owns parser initialization and grammar lifetimes. `withParsedNotebookSource` deletes its tree after the callback: return detached facts, never retain tree nodes. Bundled WASM is resolved relative to this package, independent of the application resource directory. `./powershell` accepts a caller-selected executable; the host owns provisioning, version selection and authorization.
