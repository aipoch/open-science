# Test ownership

The extraction preserves domain cases and separates application policy assertions. Paths below are relative
to this package unless prefixed `host:` (the repository `src/` tree).

| Original behavior                                                                                   | Package evidence                                                                                                                                                 | Host evidence / split                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider/model metadata, regions, vision, endpoints, native reasoning values                        | `src/providers/lookup.test.ts`                                                                                                                                   | Default selection, discovered aliases/legacy names, unknown-context fallback move to `host:shared/provider-model-policy.test.ts`. Repeated default assertions consolidate into one vendor/region table.    |
| Five reasoning preference slots, custom presets, labels and defaults                                | Native unique values in lookup tests                                                                                                                             | Entire original preset matrix in `host:shared/reasoning-effort.test.ts`; `reasoning-effort-presets.test.ts` freezes the old slot mapping for all 17 presets.                                               |
| Failure classification and synthetic redaction cases                                                | `src/errors.test.ts`, diagnostic matrix in `src/models/text-generation.test.ts`                                                                                  | Electron wrapper normalization belongs to `host:shared/provider-error.ts`; translation/settings UI contracts exercise serialized failures.                                                                 |
| Endpoint composition                                                                                | `src/protocols/endpoints.test.ts`                                                                                                                                | Validator/framework wiring remains host-owned.                                                                                                                                                             |
| Responses input/tool/history conversion                                                             | `src/responses/request.test.ts`, `conversion.test.ts`                                                                                                            | HTTP auth, session/tool permissions and application MCP resource-tool filtering remain in `host:main/settings/responses-bridge.test.ts`.                                                                   |
| Completed response and streaming delta/terminal conversion                                          | `src/responses/response.test.ts`, `conversion.test.ts`                                                                                                           | Captured wire/multi-bridge HTTP regressions remain in `host:main/settings/provider-protocol-regressions.test.ts`.                                                                                          |
| Reasoning identity grouping and bounds                                                              | Original LRU/count/character/reconciliation assertions moved from bridge into `src/responses/replay.test.ts`; lifecycle/scopes/clear/cancel in `adapter.test.ts` | Real HTTP replay/retargeting tests remain; target-change contract observes adapter clearing, rather than host-private cache contents.                                                                      |
| Text answer validation, all three protocol matrices, usage, limits, cancellation, errors, real HTTP | `src/models/text-generation.test.ts` using explicit protocol and URL                                                                                             | Account/key eligibility, endpoint priority, model cap projection and unchanged persisted target hash move to `host:main/literature/pdf-translation/text-generation.test.ts`. Translation workflows remain. |
| Architecture and imports                                                                            | Request/response architecture tests plus `src/boundaries.test.ts`                                                                                                | Host architecture tests assert package preparation/conversion and server/session ownership. Composition proves proxy-aware fetch injection.                                                                |

`test/provider-error-diagnostics.jsonl` is package-owned synthetic input. No host fixture copy is required.
`test/stream-harness.ts` adapts original writer-shaped assertions to the internal async generator and is excluded
from production output. No production API exists just to serve those tests. Captured provider-wire fixtures
remain in the host because their consumers validate framework integration. No package test imports host code,
setup or fixtures. No assertions are removed to reduce CI selection.

Native reasoning arrays no longer repeat a value to fill five UI positions. Lookup tests verify their ordered
unique values; host preset tests retain the exact padded five-position expectations. These two responsibilities
jointly preserve the original mapping. Runtime deep-freeze and copied-query tests protect public metadata.

No Python/R/kernel/device scenarios are needed. Real HTTP tests use port 0 and release servers in finally;
adapter tests verify reader cancellation and lock release. Package test concurrency follows Vitest configuration.

The rebased `shared_promise_identity` module retains host composition and Responses lifecycle contracts.
Its five references to deleted provider-domain test paths are retired: those algorithms now have no dependency
on the host's in-flight-promise owner. They remain in providers owner evidence, never as upstream package units
selected by a host utility change. Network injection remains covered by document-reading composition; HTTP and
session integration consumers are preserved.

## Capability completion

| Original behavior                                                                          | Package evidence                                                                                                                                                                               | Retained host evidence                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings/xai-protocol.test.ts`: all six request/output/tool/token cases                   | `src/protocols/compatibility.test.ts`, unchanged expectations                                                                                                                                  | xAI OAuth bridge, chat compatibility, provider transport and captured framework regressions; account-type selection stays in transport owner                                                                                   |
| `settings/list-models.test.ts`: all nine parsing, authentication, status and bounds cases  | `src/discovery/models.test.ts`, unchanged expectations                                                                                                                                         | Original host path now checks explicit host resource/network injection and conditional account persistence; privacy and authenticated redirect contracts remain                                                                |
| Three pure namespace flatten/collision/restore cases inside native Responses tests         | `src/responses/native.test.ts`; restore obtains its private map from a prepared request                                                                                                        | HTTP authorization/error mapping, scoped tool policy, stream arguments, artifact promotion, lifecycle and captured MCP image fixture remain in native Responses host tests                                                     |
| Classification wire request/answer/usage logic embedded in settings                        | `src/models/classification.test.ts`: endpoint encoding, immutable definitions, generic labels, malformed answers, usage-before-failure, response bounds, cancellation and discard-before-retry | Existing classification settings matrix retains feature questions, distribution checks, credentials, stale decisions, retries and billed usage; those scenarios jointly exercise several host owners and are not blindly moved |
| `pdf-translation/local-worker.integration.test.ts`: real WASM setup and unicode model path | `src/local-runtime.test.ts`, same generated identity model and actual worker import                                                                                                            | `pdf-translation/local.test.ts` retains queue, leases, cancellation, verified process exit and restart; now also asserts the injected installed worker path                                                                    |
| Local model/tokenizer lifetime formerly implicit in worker loop                            | `src/local.test.ts`: reuse, one-time disposal, overlapping-call rejection, drain-before-disposal, input/output bounds and cancellation                                                         | Application model installation/removal, active revision and process ownership stay in local-model and translation host suites                                                                                                  |

The tiny ONNX fixture is generated in a unique temporary directory by its package test. Captured framework
image fixtures remain host-owned; no copy is added to the package. The single local worker source moves
from host resources to package resources; the host launches the exported installed location. Pure moved
units are removed from host consumer evidence, while host integration evidence and selection guards are
retained and expanded. No test skips or concurrency overrides are added.

Qwen's pinned asset metadata now has one owner in `src/providers/local-model.ts`. The host installer
consumes that definition without changing the `models/pdf-translation` namespace or `active.json`
receipt. Host local-runtime tests freeze the existing target model/revision identity as a compatibility
contract. Table Transformer definitions remain with the existing local PDF model installer.

## Bound model management

The existing text matrix is preserved in `src/models/text-generation.test.ts`; its small test-only driver creates a
bound text model for each explicit target. Classification envelope/usage cases are preserved in
`src/models/classification.test.ts` with the same approach. These helpers are not shipped public APIs.
`src/providers/create.test.ts` adds the actual public entry contract: shared gateway definitions, separate
capability lists, built-in classification endpoint resolution, opaque new model IDs, immutable configuration
snapshots, credential isolation between accounts, local-worker metadata and unsupported capability rejection.
Host text/classification scenarios continue through the public factory and retain their full assertions.
The clean consumer exercises both model interfaces and metadata using CJS/ESM types and actual execution.
No fixture ownership, runtime resource or persistence format changes in this revision.

The rebase onto main preserves the upstream Jev image classification scenarios in
`host:main/settings/classification-settings.test.ts`: image loading/cancellation, normalization,
resource limits, empty input and configuration changes across image preparation remain host contracts.
`src/providers/create.test.ts` owns the image request envelope, headers, provider endpoint routing,
explicit endpoint precedence, UTF-8 request bounds and text-only compatibility. The installed tarball
check exercises image classification and its public types without host image preparation code.
Upstream's `jev-preview` and `typesafe/jev-1.14` metadata are retained; no persisted model selection is migrated.

## Capability boundary consolidation

- `src/providers/create.test.ts` now calls the complete `classify` API. All previous request/header,
  endpoint, image, bound, immutable-connection and usage assertions remain; additional cases verify
  built-in defaults and region routing without a host endpoint resolver.
- `src/models/classification.test.ts` retains low-level response ownership assertions using a private
  package helper. The public client no longer exports an exchange or requires read/cancel calls.
- `src/runtimes/local-text.test.ts` owns worker framing, validation, serialization, reuse, revision
  changes, timeout and disposal. `host:main/literature/pdf-translation/local.test.ts` retains every prior
  lease/admission/shutdown scenario against the real package runtime and host-managed process hooks.
  Worker paths are asserted as installed package resources instead of caller-supplied paths.
- `src/protocols/chat-anthropic.test.ts` owns message/image/tool conversion and usage/termination cases.
  Existing host compatibility and protocol regression tests retain actual HTTP, authentication and SSE
  contracts. The implementation was removed from the host; no duplicate conversion facade remains.
- Host text generation retains credential admission and persisted target hashes. It no longer selects
  wire protocols or composes endpoint URLs. Host classification retains each attempt's budget, persisted
  usage and stale-setting checks. HTTP diagnostic status is a value, never a live response object.
- The installed consumer now invokes a built-in model with only provider/model IDs and a prompt;
  classification uses `classify`; local runtime uses model handles. Optional process supervision exposes
  the worker entry only to its launch hook, not to ordinary model consumers.

## Connection-bound discovery and directory disposal

- The existing model-list parsing/authentication/bounds cases remain in `src/discovery/models.test.ts`.
  `src/providers/create.test.ts` adds built-in/region/auth resolution, explicit URL snapshots, per-call
  bounds, and unavailable discovery. The SDK now owns the URL; no network scenario was removed.
- Host `settings/list-models.test.ts` retains network/resource injection and stale-account write checks,
  and covers OAuth credential reference snapshots, Grok filtering, and the curated API-key xAI picker.
  Host privacy/redirect tests invoke the public provider instance with the same rejection assertions.
- Local runtime tests cover active and idle disposal while another directory is registered, failed
  termination retry, and queued next-directory work. The host local test proves that its old file lease
  remains held until the corresponding Worker termination is confirmed. Same-directory sharing and
  queued cancellation assertions remain unchanged. No fixtures or existing assertions were removed.

## Default runtime and discovery cancellation

- `src/discovery/models.test.ts` owns pre-cancelled requests, stalled response cancellation by caller
  and timeout, limit validation before network access, and explicit undefined defaults. Existing
  endpoint/authentication, response bounds and HTTP failure assertions remain intact.
- `src/runtimes/local-text.test.ts` additionally exercises the public runtime with its default process
  owner: failed spawn preserves its original error without waiting for exit, and failed termination
  keeps disposal retryable until exit is confirmed. The other runtime tests retain injected process
  supervision to isolate queue/framing behavior.
- Clean tarball acceptance invokes the default public Node runtime against a missing model directory,
  verifies the real Worker failure response and disposal, then retains the existing real tiny WASM
  inference test. This validates launch/resources/cleanup, not complete Qwen inference quality.
