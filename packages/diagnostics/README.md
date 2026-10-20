# @aipoch/diagnostics

Common diagnostic logging, credential redaction, operation timing, bounded flush, process error summaries and startup probes. The package builds and tests independently, uses only Node builtins at runtime, and never imports application source or Electron.

## Public entries

| Import                     | Purpose                                                                                         | Environment     |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------- |
| `@aipoch/diagnostics`      | Credential-key classification, text redaction and log status types                              | Browser or Node |
| `@aipoch/diagnostics/node` | JSONL logging, correlation, operation timing, flush, process error summaries and startup probes | Node >=22.13    |

```ts
import { redactSensitiveText } from '@aipoch/diagnostics'
import { createLogger, initLogger, flushLogs } from '@aipoch/diagnostics/node'

initLogger({ logDir: '/application/logs', mirrorToConsole: false })
createLogger('example').info('request completed', { durationMs: 12 })
await flushLogs()
redactSensitiveText('apiKey=example')
```

The Node entry owns one log sink per process/module instance, shared by CommonJS and ESM imports. Initialize it once in application composition. A worker has its own isolated module state. Consumers use declared exports; formatting and other implementation details are private. The browser entry loads no Node builtins.

Console mirroring defaults to readable text. Hosts can set `consoleFormat: 'json'` to mirror the same bounded, redacted JSON line written to the file, including time, level, run ID and optional correlation ID. `mirrorToConsole: false` disables either format. Debug/info retain stdout and warn/error retain stderr; file filtering, rotation and flush behavior are unchanged.

## Ownership

This package owns common diagnostic mechanics and their tests. The host supplies log directories, correlation values, event payloads, lifecycle wiring and startup probe operations. The host remains responsible for selecting appropriate business information before logging it; generic redaction cannot decide which domain fields may be disclosed.

Diagnose inspection, Session export, database queries, Session/Notebook/settings projections, archive creation, cancellation, worker orchestration and their fixtures remain in the application's `session-diagnostics` module. There is no Session package entry, database schema, application storage reader, `tar` dependency or host repository dependency here. Changing a business table or persisted document does not require updating this package.

## Safety and integration

- **Scope:** Local diagnostic mechanics and generic credential redaction, not domain-specific anonymization.
- **Controls:** Credential-pattern masking, bounded output, rotation, and flush behavior reduce
  accidental exposure and resource use for the supplied log events.
- **Remaining risks:** Patient identifiers, unpublished findings, private paths, or secrets in
  unexpected formats may remain. The configured directory contains readable files, and console
  mirroring can disclose records to another collector. Redaction is not export consent or encryption.
- **Safe integration:** Log only necessary business fields, protect the log directory, review console
  destinations, and inspect the exact content before sharing. The host owns retention and report
  authorization. See the application's
  [diagnostic precautions](https://github.com/aipoch/open-science/blob/main/docs/security.md#diagnostics).

## Development and acceptance

```sh
npm install --ignore-scripts
npm run build
npm run typecheck
npm test
npm pack
```

Package tests cover logging, privacy budgets, cross-platform text handling, operation timing, bounded flush and startup probe cleanup. Host tests cover application composition and business integration through public exports. The repository's `npm run check:diagnostics-package` builds and tests outside the checkout, installs the tarball in a separate consumer, verifies CJS/ESM singleton identity and private export rejection, compiles the browser entry and exercises logging/redaction after deleting the copied sources.

Host-only CI changes may skip unchanged upstream package unit tests. Package changes retain downstream contract/integration checks; shared build inputs and uncertain impact retain conservative coverage. Test ownership counts are reported separately from actual Ubuntu execution time.

## Compatibility and persistence

Existing log records, filenames, rotation, queue bounds, fatal synchronous writes, redaction markers, operation outcomes and flush behavior are retained. The logger writes only to its configured directory. Storage probes create temporary files only within the explicitly supplied probe directory and clean them up. No application database, migration, persistent setting, storage version or new status value is introduced. Historical Session/document compatibility remains the responsibility of the host Diagnose feature.
