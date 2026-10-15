# Test impact diagnostics

Private development/CI tooling for static dependency evidence from an immutable Git commit.
Requires Node 24 and Git. It does not run the application, select tests, or retire consumers.

```sh
npm run analyze:test-impact -- --revision HEAD
# After building, print only JSON (useful for redirecting to a report file):
node packages/test-impact/dist/cli.js --revision HEAD --config scripts/ci/test-impact-config.json
```

The root command builds this package first. Existing generate:module-consumers, test:module,
and test:affected commands keep their existing implementations and semantics.

```ts
import { analyzeRevision } from '@aipoch/test-impact'
const report = await analyzeRevision({
  repository: '/path/to/repository',
  revision: 'HEAD',
  configuration: {
    packageRegistry: 'scripts/ci/package-test-boundaries.json',
    sourcePaths: { '@/*': ['src/renderer/src/*'] }
  }
})
```

Configuration is supplied by the caller as JSON; candidate tsconfig, Vite and dependency-cruiser
JavaScript configurations are never loaded. An optional package registry supplies public source
mappings from package metadata in the selected revision. Missing or unsupported exports fail;
no private wildcard aliases are added. Repository module ownership, consumer and runtime manifests
remain outside this package and are not applied by this first static diagnostic.

The analyzer materializes exact regular Git blobs in an owned temporary directory, canonicalizes
its path, and runs a fixed dependency-cruiser worker with restricted resolution. The worker does
not search installed candidate dependencies or inherit NODE_OPTIONS/NODE_PATH. Node filesystem
permissions add a boundary; this is not a sandbox for executing hostile JavaScript. A future
trusted CI gate must obtain this tool, dependencies and configuration from trusted policy code.

The graph unions runtime-preferred and declaration-preferred resolution. Report schema version 1
contains the commit, engine version, effective source aliases, relative file identities, known dependencies and unresolved
specifiers. `purpose: diagnostic` and `canPruneTests: false` are deliberate: computed/escaped loaders
are not fully enumerated, runtime contracts are not applied, and unresolved bare imports are not
automatically classified as harmless external dependencies. Zero edges do not prove independence.

Unsafe/nonportable Git paths, case/Unicode collisions, symlinks, gitlinks, missing input evidence,
outside targets, snapshots over 256 MiB, analyzer timeout (180 seconds) and excessive output fail
with a nonzero CLI exit. No partial graph is reported as successful. Snapshots are removed on
success and failure; no persistent cache or business data is written. The CLI prints to stdout.

```sh
npm test -- packages/test-impact/src
npm run check:packages -- --packages=test-impact
```

The focused package verifier builds/tests an isolated copy, installs its tarball into another
clean directory, and checks its exported API, CLI, types and private-import boundary.
