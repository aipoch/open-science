# Test ownership

The extraction preserves domain cases and separates application policy assertions. Paths below are relative
to this package unless prefixed `host:` (the repository `src/` tree).

| Original behavior                                                                                   | Package evidence                                                                                                                                                 | Host evidence / split                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider/model metadata, regions, vision, endpoints, native reasoning values                        | `src/providers/lookup.test.ts`                                                                                                                                   | Default selection, discovered aliases/legacy names, unknown-context fallback move to `host:shared/provider-model-policy.test.ts`. Repeated default assertions consolidate into one vendor/region table.    |
| Five reasoning preference slots, custom presets, labels and defaults                                | Native unique values in lookup tests                                                                                                                             | Entire original preset matrix in `host:shared/reasoning-effort.test.ts`; `reasoning-effort-presets.test.ts` freezes the old slot mapping for all 17 presets.                                               |
| Failure classification and synthetic redaction cases                                                | `src/errors.test.ts`, diagnostic matrix in `src/text/generate.test.ts`                                                                                           | Electron wrapper normalization belongs to `host:shared/provider-error.ts`; translation/settings UI contracts exercise serialized failures.                                                                 |
| Endpoint composition                                                                                | `src/protocols/endpoints.test.ts`                                                                                                                                | Validator/framework wiring remains host-owned.                                                                                                                                                             |
| Responses input/tool/history conversion                                                             | `src/responses/request.test.ts`, `conversion.test.ts`                                                                                                            | HTTP auth, session/tool permissions and application MCP resource-tool filtering remain in `host:main/settings/responses-bridge.test.ts`.                                                                   |
| Completed response and streaming delta/terminal conversion                                          | `src/responses/response.test.ts`, `conversion.test.ts`                                                                                                           | Captured wire/multi-bridge HTTP regressions remain in `host:main/settings/provider-protocol-regressions.test.ts`.                                                                                          |
| Reasoning identity grouping and bounds                                                              | Original LRU/count/character/reconciliation assertions moved from bridge into `src/responses/replay.test.ts`; lifecycle/scopes/clear/cancel in `adapter.test.ts` | Real HTTP replay/retargeting tests remain; target-change contract observes adapter clearing, rather than host-private cache contents.                                                                      |
| Text answer validation, all three protocol matrices, usage, limits, cancellation, errors, real HTTP | `src/text/generate.test.ts` using explicit protocol and URL                                                                                                      | Account/key eligibility, endpoint priority, model cap projection and unchanged persisted target hash move to `host:main/literature/pdf-translation/text-generation.test.ts`. Translation workflows remain. |
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
