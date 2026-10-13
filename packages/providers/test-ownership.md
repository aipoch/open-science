# Extraction test ownership

No original assertion was dropped or weakened.

| Original scene                                                                           | New owner                                    | Host evidence retained                                                                                                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| shared/provider-registry.test.ts                                                         | src/provider-registry.test.ts                | provider account/model selection and renderer selectors                                                                                |
| shared/reasoning-effort.test.ts                                                          | src/reasoning-effort.test.ts                 | shared/provider-reasoning-effort.test.ts, all framework route/config tests                                                             |
| shared/provider-text-generation-failure.test.ts                                          | src/provider-text-generation-failure.test.ts | serialized errors through translation/UI contracts                                                                                     |
| settings/base-url.test.ts                                                                | src/base-url.test.ts                         | validator and framework endpoint wiring                                                                                                |
| settings/responses-request-adapter.test.ts                                               | src/responses-request-adapter.test.ts        | ResponsesBridge HTTP/session tests                                                                                                     |
| settings/responses-response-adapter.test.ts                                              | src/responses-response-adapter.test.ts       | ResponsesBridge HTTP/session tests                                                                                                     |
| settings/provider-text-generation.test.ts                                                | src/provider-text-generation.test.ts         | literature/pdf-translation/api-target.test.ts and translation workflow tests                                                           |
| responses-bridge.test.ts direct conversion matrix (instructions through streaming usage) | src/responses-conversion.test.ts             | authenticated HTTP, trusted tool scopes, cache/reasoning isolation, retargeting, cancellation, bounded reads, selectors remain in host |
| provider-protocol-regressions.test.ts R01 parallel tool image replay                     | src/responses-conversion.test.ts             | captured wire fixtures and multi-bridge HTTP scenarios remain in host                                                                  |
| adapter architecture export inventories and lifecycle exclusions                         | src/responses-*-adapter.architecture.test.ts | same host test paths retain delegation/server/session assertions                                                                       |

`test/provider-error-diagnostics.jsonl` is package-owned synthetic domain data. The unused duplicate
in pdf-translation's corpus and old host fixture were removed; the entire diagnostic case matrix
remains in the package. Captured provider-tool-image-wire fixtures remain host-owned because their
consumers verify framework wire compatibility. Package tests never read host code or fixtures.

The package client usage object is structurally compatible with host ACP usage. ACP persistence
validation remains host-owned; the package validates protocol counters and arithmetic overflow.
No Python/R, kernel, device or native runtime is required. Real HTTP tests allocate port 0 independently
and close servers in finally blocks. Package concurrency is managed only by its own Vitest config.
