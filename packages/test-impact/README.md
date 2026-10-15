# Test impact diagnostics

Private static dependency tooling for immutable Git revisions. Requires Node 24 and Git.

```sh
npm run analyze:test-impact -- --revision HEAD
# After building, output JSON without npm/build logs:
node packages/test-impact/dist/cli.js --revision HEAD --config scripts/ci/test-impact-config.json
```

The report combines implementation and declaration dependencies, retaining unresolved imports,
revision, engine version and source aliases. `canPruneTests: false`: missing edges do not prove
independence. Module ownership and runtime contracts remain in repository manifests; this tool
does not apply them or change existing consumer generation and test selection.

The public API is `analyzeRevision({ repository, revision, configuration? })`.
JSON configuration accepts `packageRegistry` and `sourcePaths`; see
[`test-impact-config.json`](../../scripts/ci/test-impact-config.json) for the repository setup.
Candidate JavaScript configuration is never executed. A trusted CI caller must supply a trusted
tool and configuration. Invalid paths, incomplete extraction and resource-limit failures return
errors; temporary snapshots are cleaned up and no persistent cache is written.

```sh
npm test -- packages/test-impact/src
npm run check:packages -- --packages=test-impact
```

The verifier builds and tests an isolated copy, then checks the installed tarball's API, CLI,
types and private-import boundary. Source Regression's `static-impact` mode runs it on all three OSes.
