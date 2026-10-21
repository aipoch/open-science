# Test ownership

The extraction preserves domain cases and separates application policy assertions. Paths below are relative
to this package unless prefixed `host:` (the repository `src/` tree).

| Original behavior                                                                                   | Package evidence                                                                                                                                                 | Host evidence / split                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider/model metadata, regions, vision, endpoints, native reasoning values                        | `src/providers/lookup.test.ts`                                                                                                                                   | Default selection, discovered aliases/legacy names, unknown-context fallback move to `host:shared/provider-model-policy.test.ts`. Repeated default assertions consolidate into one vendor/region table.    |
| Five reasoning preference slots, custom presets, labels and defaults                                | Native unique values in lookup tests                                                                                                                             | Entire original preset matrix in `host:shared/reasoning-effort.test.ts`; `reasoning-effort-presets.test.ts` freezes the old slot mapping for all 17 presets.                                               |
| Failure classification and synthetic redaction cases                                                | `src/errors.test.ts`, diagnostic matrix in `src/models/text-generation.test.ts`                                                                                  | Electron wrapper normalization belongs to `host:shared/provider-error.ts`; translation/settings UI contracts exercise serialized failures.                                                                 |
| Endpoint composition                                                                                | `src/protocols/endpoints.test.ts`                                                                                                                                | Validator/framework wiring remains host-owned.                                                                                                                                                             |
| Responses input/tool/history conversion                                                             | `src/responses/request.test.ts`, `conversion.test.ts`                                                                                                            | HTTP auth, session/tool permissions and application MCP resource-tool filtering remain in `host:main/settings/responses-to-chat-completions-bridge.test.ts`.                                               |
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

| Original behavior                                                                         | Package evidence                                                                                                                                                                               | Retained host evidence                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings/xai-protocol.test.ts`: all six request/output/tool/token cases                  | `src/protocols/compatibility.test.ts`, unchanged expectations                                                                                                                                  | xAI OAuth bridge, chat compatibility, provider transport and captured framework regressions; account-type selection stays in transport owner                                                                                   |
| `settings/list-models.test.ts`: all nine parsing, authentication, status and bounds cases | `src/discovery/models.test.ts`, unchanged expectations                                                                                                                                         | Original host path now checks explicit host resource/network injection and conditional account persistence; privacy and authenticated redirect contracts remain                                                                |
| Native Responses namespace operations and provider reasoning normalization                | `src/responses/native.test.ts`; restore obtains its private map from a prepared request                                                                                                        | HTTP authorization/error mapping, scoped tool policy, stream arguments, artifact promotion, lifecycle and captured MCP image fixture remain in native Responses host tests                                                     |
| Classification wire request/answer/usage logic embedded in settings                       | `src/models/classification.test.ts`: endpoint encoding, immutable definitions, generic labels, malformed answers, usage-before-failure, response bounds, cancellation and discard-before-retry | Existing classification settings matrix retains feature questions, distribution checks, credentials, stale decisions, retries and billed usage; those scenarios jointly exercise several host owners and are not blindly moved |

Local inference is deferred from this extraction. The existing host worker resource, pinned model
manifest, runtime and tests (`host:main/literature/pdf-translation/local.test.ts` and
`local-worker.integration.test.ts`) are restored to their pre-extraction owners. The package-only
local generator, runtime and lifecycle tests are withdrawn together with that unsupported implementation;
they are not claimed as package coverage. Host behavior and baseline assertions remain intact.
The generated ONNX fixture remains owned by the host integration test. No fixture is copied into this package.

## Bound model management

The existing text matrix is preserved in `src/models/text-generation.test.ts`; its small test-only driver creates a
bound text model for each explicit target. Classification envelope/usage cases are preserved in
`src/models/classification.test.ts` with the same approach. These helpers are not shipped public APIs.
`src/providers/create.test.ts` adds the actual public entry contract: shared gateway definitions, separate
capability lists, built-in classification endpoint resolution, opaque new model IDs, immutable configuration
snapshots, credential isolation between accounts, empty local-model queries and unsupported capability rejection.
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
- `src/protocols/messages/conversion.test.ts` owns message/image/tool conversion and usage/termination cases.
  Existing host compatibility and protocol regression tests retain actual HTTP, authentication and SSE
  contracts. The implementation was removed from the host; no duplicate conversion facade remains.
- Host text generation retains credential admission and persisted target hashes. It no longer selects
  wire protocols or composes endpoint URLs. Host classification retains each attempt's budget, persisted
  usage and stale-setting checks. HTTP diagnostic status is a value, never a live response object.
- The installed consumer now invokes a built-in model with only provider/model IDs and a prompt;
  classification uses `classify`; local models are unsupported.

## Connection-bound discovery

- The existing model-list parsing/authentication/bounds cases remain in `src/discovery/models.test.ts`.
  `src/providers/create.test.ts` adds built-in/region/auth resolution, explicit URL snapshots, per-call
  bounds, and unavailable discovery. The SDK now owns the URL; no network scenario was removed.
- Host `settings/list-models.test.ts` retains network/resource injection and stale-account write checks,
  and covers OAuth credential reference snapshots, Grok filtering, and the curated API-key xAI picker.
  Host privacy/redirect tests invoke the public provider instance with the same rejection assertions.

## Discovery cancellation

- `src/discovery/models.test.ts` owns pre-cancelled requests, stalled response cancellation by caller
  and timeout, limit validation before network access, and explicit undefined defaults. Existing
  endpoint/authentication, response bounds and HTTP failure assertions remain intact.

## Protocol directory organization

All text codec cases remain in `src/models/text-generation.test.ts`. Conversion cases move intact to
`src/protocols/messages/conversion.test.ts`; the completed-stream case moves to
`src/protocols/chat-completions/stream.test.ts` with the same assertions. The Messages/Chat/Responses
matrix remains in `src/protocols/compatibility.test.ts`. Public function names and host integration
contracts are unchanged. Local metadata assertions now explicitly require an empty list and no
registered local provider, and the packed consumer checks `/local` is not exported.

## Rebased host helper evidence

The new `pdf_text` and `shared_fuzzy_match` owners inherited pre-extraction consumer paths.
Their host consumer lists now follow the existing responsibility split; neither helper owns or
triggers provider package unit tests. These conservative host registrations retain the upstream
consumer modules and every surviving test reference.

| Retired host test                                 | Package assertions                                                                        | Remaining host evidence                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `settings/provider-text-generation.test.ts`       | Protocol and diagnostics matrix in `src/models/text-generation.test.ts`                   | `literature/pdf-translation/text-generation.test.ts`: credential admission, endpoint policy, persisted target identity |
| `settings/responses-request-adapter.test.ts`      | Request conversion in `src/responses/request.test.ts`                                     | Existing `settings/responses-to-chat-completions-bridge.test.ts`: authenticated HTTP and replay integration            |
| `settings/responses-response-adapter.test.ts`     | Response/conversion matrices in `src/responses/response.test.ts` and `conversion.test.ts` | Existing `settings/provider-protocol-regressions.test.ts`: host stream integration                                     |
| `settings/xai-protocol.test.ts`                   | xAI wire cases in `src/protocols/compatibility.test.ts`                                   | Existing `settings/xai-oauth-provider-bridge.test.ts`: OAuth transport contract                                        |
| `shared/provider-registry.test.ts`                | Provider/model metadata in `src/providers/lookup.test.ts`                                 | `shared/provider-model-policy.test.ts`: initial selection, discovery and legacy fallback policy                        |
| `shared/provider-text-generation-failure.test.ts` | Failure classification/redaction in `src/errors.test.ts` and the text-generation matrix   | `shared/provider-presentation-policy.test.ts`: Electron envelope normalization                                         |

Host paths in this table are relative to `src/main/` unless prefixed with `shared/`. No test
assertions or fixtures are removed by this registration reconciliation. The package-boundary
selection test explicitly verifies both helper edits select host text-generation evidence without
selecting provider unit tests; provider edits still select their own tests and downstream contracts.

## Protocol regression ownership follow-up

The three pure groups from host `settings/provider-protocol-regressions.test.ts` now live in
`src/protocols/compatibility.test.ts`: business schema names/null constraints across native Responses,
Messages and Chat; URL images and tool-result call association; and opaque schema/default/metadata/output
values. Their assertions are preserved. The Messages table entry now matches the actual `messages`
branch instead of accidentally repeating Chat coverage through the historical `anthropic` label.
Host HTTP/authentication/SSE regressions and captured framework fixtures remain host-owned.

The complete MiniMax M3.1 effort matrix lives in `src/models/text-generation.test.ts` and
`src/responses/conversion.test.ts`. Host `agent-framework/opencode.test.ts` keeps one representative
effort for each released/Preview model ID, checking both the written and pinned environment config.
Host Skill routing retains its lowest-supported-effort policy checks.

Native Codex `none` normalization is covered in `src/responses/native.test.ts`; host
`settings/native-responses-compatibility.test.ts` verifies HTTP forwarding uses the effective
model and follows provider/model retargeting.
