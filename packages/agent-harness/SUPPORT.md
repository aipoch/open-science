# Public API and support contract

This is an experimental 0.1 package. A passing local candidate is not a published release.
Only the following package exports and their generated TypeScript declarations are public:

| Entry                                    | Purpose                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@aipoch/agent-harness`                  | `openAgentSession`, model/tool/store contracts, local stores, context compaction and low-level runner/tool helpers |
| `@aipoch/agent-harness/mcp`              | `loadMcpTools` and MCP client/lease contracts; no SDK or connection manager is installed by the core               |
| `@aipoch/agent-harness/chat-completions` | Chat Completions streaming adapter and safe protocol diagnostics                                                   |
| `@aipoch/agent-harness/responses`        | Responses streaming adapter                                                                                        |
| `@aipoch/agent-harness/messages`         | Messages streaming adapter                                                                                         |

`src/*`, `dist/*` deep imports and undocumented implementation details are private. Use the exports
above with ESM `import` or CommonJS `require`; both resolve the same CommonJS implementation.
Runtime dependencies are empty. Node.js **22.13.0 or newer** is required; browsers, Electron renderer
contexts and other JavaScript runtimes are not certified targets.

## Compatibility and durable state

Within a published 0.1.x line, patch releases must preserve public types and observable contracts:
permission checks, event ordering, cancellation/drain, unknown results and checkpoint recovery.
An incompatible API change requires a new minor version while pre-1.0, explicit release notes and
migration instructions. This policy does not imply that all pre-1.0 APIs are permanently frozen.

Checkpoint format is currently `version: 1`; journal records have their own version/checksum and
monotonic revision. Unsupported or corrupt input is rejected, never silently treated as an empty
conversation. There is no automatic JSON-store/journal-store migration, damaged-tail truncation or
stale-lock takeover. Keep original data and use an explicit host recovery/migration procedure.
A future format change must identify reader/writer compatibility separately from API compatibility.
Do not let an older writer overwrite state produced by a newer incompatible writer.

`AgentStore.commit` is compare-and-swap. The host must fence prior workers and maintain one active
writer per execution domain. `started`/`unknown` tool outcomes must be reconciled using an external
receipt or authoritative execution status before continuation; they are not safe retries.
Neither checkpoints nor MCP provide exactly-once external side effects. A returned tool result and
an uncertain transport failure have different meanings.

## Ownership

| Package                                                                  | Host/application                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Model/tool loop, streaming events, bounded steps, cancellation admission | Provider credentials, account invalidation, current route and model capabilities                                 |
| Checkpoint ordering, recovery states and configured store contract       | Store location, worker fencing, recovery authority and lifecycle ownership                                       |
| One automatic summary policy, projection and tool-pair preservation      | Accurate request measurement, model context/output limits, evidence-retention guidance                           |
| Tool validation/authorization/guard sequence and optional MCP mapping    | Actual permission decisions, sandbox, MCP client/server lifetime and execution drain                             |
| Portable history and usage records; missing usage stays unknown          | UI, branches, skills, persistent delegation scheduling, jobs, artifacts, billing and product completion criteria |

The package does not provision a sandbox or MCP server, register an application backend, create
accounts, obtain credentials or select a provider. A host can supply native `AgentTool` capabilities
or use the optional MCP adapter. No other harness in a host must migrate to use this package.
`dispose()` cannot terminate a tool that ignores cancellation: the host must stop/fence its worker.
Local file stores use local filesystem locks and atomic replacement, not distributed leases.

## Validation scope

Automated standalone acceptance covers package tests, real child-process/MCP/HTTP recovery,
journal crash boundaries, public ESM/CJS and TypeScript consumers installed from the actual tarball.
The maintained CI matrix targets Linux x64/ARM64, Windows and macOS on Node 22.13.0 and Node 24; a workflow file is
not evidence that a remote run has passed. Consult the receipt for the exact platform/runtime/source.
Local x64 execution through emulation is recorded separately from native x64 runner certification.
macOS ARM64 has local acceptance evidence. Windows, Linux desktop sandbox, physical power loss,
storage-device caches and cross-machine network partitions remain separate environment checks.

| Protocol/capability  | Evidence and limits                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat Completions     | Deterministic protocol and host integration tests; provider-specific behavior and account certification remain separate                        |
| Responses / Messages | Native contract and host integration tests; provider-specific behavior and account certification remain separate                               |
| MCP                  | SDK-backed stdio and HTTP recovery tests; third-party authorization/services remain host-specific                                              |
| Automatic compaction | Current-model structured continuation summary with stable request prefix; no per-step forced summary or alternate product modes                |
| Performance          | Fixed-model paired runtime and local persistence stress evidence; shared provider cache and small samples do not establish a universal ranking |

Large histories still require content verification and cold replay. Keep large tool data in host
artifacts where appropriate. Mutable checkpoint submissions can incur full boundary copies; local
store benchmarks are not a database concurrency, memory-capacity or physical-disk certification.

## Reproducible candidate verification

From a source checkout, without installing the application's dependencies:

```sh
npm run check:agent-harness-standalone -- --output out/agent-harness-acceptance
```

Use an empty output directory. The command stages only explicit package/fixture inputs, installs a
locked test dependency graph with lifecycle scripts disabled, builds and packs the package, installs
the tarball into a separate consumer with no build dependencies, and runs recovery tests against the
installed package. Tests are mandatory and skipped tests fail acceptance. It makes no model calls.

The output contains source SHA256s, Git revision and dirty state, exact Node/platform/architecture,
resolved test tools and dependency lock, compiled-file hashes, tarball SHA256/SHA512 integrity,
public export/declaration inventory, test reports and logs. The installed file bytes must match the
candidate source/build. Failed runs retain a failed receipt; an existing directory is never replaced.
Temporary staging is removed. The standalone lane does not install Electron or host business code.

For delivery, retain the tarball and its receipt together, verify the tarball digest, require a passing
receipt for the declared target, and match input hashes to the intended source revision. A dirty
working-tree receipt identifies a local candidate; its Git HEAD alone is not the source identity.
These receipts are unsigned build evidence, not registry provenance or release attestation.
Publishing, signing, tags and application default routing require a separate release decision.

## Delegation scope

`createDelegationTool` is an additive experimental root export. It supports isolated in-process child
sessions, explicit capability/authorization configuration, bounded concurrency, final text/portable
media, persisted waiting references, cancellation with awaited cleanup, and child usage receipts. It is not a sandbox, process supervisor
or durable task queue. A supplied store preserves child evidence; interrupted effects and pre-existing
child IDs require host reconciliation. It does not automatically resume waiting children, recursively
inject delegation, or take ownership of host-created subprocesses. Media payloads share the result
allowance; provider-private references and oversized blocks are explicitly omitted. Waiting requires
a host-supplied store; the host validates parent-child identity and resumes through the existing
session APIs. Process-tree reaping and shared connection leases remain host responsibilities.

The host currently exposes the three native protocols through its optional built-in Agent, using
revocable loopback credentials. API keys, OAuth refresh and provider session headers remain host
responsibilities. Subscription authentication and proprietary provider paths remain host-owned.
A configured account, local authentication fixture or provider model catalog is not a successful live
certification. Image support does not imply universal multimodal support. Native PDF, document,
audio and video behavior remains protocol- and model-specific; these have deterministic contract
tests and host integration tests, while live provider certification, uploaded or remote media, media
generation and provider-hosted tools remain separate.
Large-media admission requires host-owned model-specific budgets; JSON byte length alone is not proof
that expanded PDF/video/audio fits the context window.
