# @aipoch/providers

Provider metadata, wire protocols, bounded text requests and Responses-to-Chat adaptation.
The package does not select application accounts, persist preferences, authorize tools or run an HTTP server.

## Public entry points

| Import                        | Responsibility                                                                             | Runtime                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `@aipoch/providers`           | Immutable provider/model definitions, regional endpoints and native reasoning capabilities | Browser or Node                                        |
| `@aipoch/providers/errors`    | Failure classification and credential redaction                                            | Browser or Node                                        |
| `@aipoch/providers/transport` | URL security, redirect rejection and bounded response reads                                | URL/fetch helpers: browser or Node; Buffer reads: Node |
| `@aipoch/providers/protocol`  | Endpoint composition, reasoning/usage conversion, Responses adapter                        | Node                                                   |
| `@aipoch/providers/client`    | One bounded, tool-less text request to an explicit protocol and URL                        | Node                                                   |

Node 22.13+ is required. Both CommonJS `require` and ESM named imports are supported, with TypeScript declarations.
No package subpath named `providers` or `catalog` exists. Internal source and build paths are private.

```ts
import { getOfficialVendor, getVendorModelReasoningCapability } from '@aipoch/providers'
import { createTextGenerationClient } from '@aipoch/providers/client'

const vendor = getOfficialVendor('openai')
const capability = getVendorModelReasoningCapability('openai', vendor?.models[0]?.id)
const client = createTextGenerationClient(fetch)
await client.run({
  target: {
    protocol: 'openai',
    url: 'https://gateway.example/v1/chat/completions',
    model: 'model',
    key: 'credential'
  },
  systemPrompt: 'Translate faithfully.',
  prompt: 'Cell',
  signal: new AbortController().signal,
  maxOutputTokens: 1024,
  outputLimitBytes: 262144
})
```

The host selects one protocol and a complete URL, credentials, native reasoning value and optional model
output cap. The client performs exactly one request, rejects redirects and incomplete/tool output, and
reports validated usage even when an HTTP error or later answer validation rejects the result.
It does not retry billed requests or maintain an account registry. Anthropic uses `x-api-key`; OpenAI
Chat/Responses use Bearer authorization. Inject `fetch` for host proxy/network policy.

## Responses lifecycle

```ts
import { createResponsesAdapter } from '@aipoch/providers/protocol'

const adapter = createResponsesAdapter({ reasoningCacheMaxEntries: 4096 })
const turn = adapter.prepare({
  scope: 'authorized-conversation-id',
  body: { model: 'model', input: 'Hello', stream: false }
})
const upstream = await fetch('https://gateway.example/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(turn.request)
})
const response = await turn.convert(upstream)
// Consume response.json() or response.body. A turn can be converted once.
adapter.clear() // Retargeting invalidates replay, including late writes from earlier turns.
adapter.dispose() // Final shutdown also cancels active readers; future prepare calls fail.
```

The adapter is the sole owner of replay identities, grouping, LRU bounds and reconciliation. Give each
independent upstream/credential lifetime its own instance. A missing scope disables replay. The host must
validate/authorize the opaque scope and tool list before preparation; supplying a scope grants no permission.
`tools` describes trusted namespace mappings. Application-specific tool filtering belongs to the host.
`convertResponsesRequest` provides stateless conversion for probes.

Cancel the returned stream when abandoning it. Reads are bounded and demand-driven. Default response limit:
64 MiB; each SSE event and line: 8 MiB. Streaming conversion owns delta assembly and emits one terminal event;
JSON conversion owns completed-response projection. All state is memory-only and is never serialized.

## Internal ownership

```text
providers/   types, frozen definitions, metadata queries
protocols/   endpoint/reasoning/usage rules and three text codecs
transport/   HTTP security, bounded bytes, generic SSE framing
responses/   request/response conversion, stream state, replay, lifecycle adapter
text/        stateless request orchestration using codecs and transport
errors.ts    browser-safe diagnostics
```

`providers` depends only on protocol types; `protocols` and `transport` do not import provider definitions.
`responses` depends on protocol rules and transport; `text` depends on codecs, transport and errors. Internal
modules never import public facades. `src/boundaries.test.ts` verifies allowed directions and detects cycles.

Application model defaults, discovery compatibility, five-slot reasoning preferences, form validation,
Electron error wrappers, account eligibility, persisted target hashes, permissions and HTTP/session lifecycle
remain in the host. Provider metadata exposes native values rather than application preference slots.

## Build and verify

In a standalone source checkout, install the declared `@aipoch/diagnostics` sibling release (or its tarball),
then run `npm install`, `npm run build`, `npm run typecheck`, `npm test`, and `npm pack`.
There are no Python/R, native binaries, workers, WASM or data resources to stage.
Tests use independent inputs and ephemeral HTTP ports; Vitest owns concurrency.

In the monorepo, `npm run check:providers-package` copies clean sources, installs only declared dependencies,
builds and tests this package, packs both siblings, and installs the tarballs into a fresh consumer. It deletes
source copies, checks all exports and CJS/ESM types, bundles browser entries, prunes development dependencies,
and executes text generation plus a multi-turn replay/clear lifecycle. Upstream builds do not rerun upstream tests.
See [test ownership](test-ownership.md) for the original assertion mapping.
