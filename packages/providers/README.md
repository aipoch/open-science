# @aipoch/providers

Provider metadata, capability rules, Responses/Chat conversion and bounded direct text generation.
Requires Node >=22.13 for protocol/client (WHATWG fetch, streams, Buffer and crypto).
The catalog entry is browser-safe. No native runtime, worker or runtime assets are required.

## Public entries

- `@aipoch/providers/catalog`: shipped vendor/region/model catalog, reasoning profiles and
  pure projections, endpoint types, secure URL validation, and redacted failure decoding.
  This is a curated compatibility profile shipped with Open Science, not live model discovery.
- `@aipoch/providers/protocol`: endpoint construction, bounded body/SSE consumption, usage
  normalization, reasoning wire controls and Responses request/result conversion.
- `@aipoch/providers/client`: tool-less Chat, Messages and Responses text generation.

Only these explicit entries are supported; implementation paths and package.json are private.
CommonJS and ESM consumers use the same implementation and error class identities.

```ts
import { getOfficialVendor } from '@aipoch/providers/catalog'
import { ProviderTextGenerationService } from '@aipoch/providers/client'

const service = new ProviderTextGenerationService(fetch)
const result = await service.run({
  target: {
    providerId: 'my-gateway',
    model: 'my-model',
    provider: { type: 'custom', baseUrl: 'http://127.0.0.1:8080', apiEndpoints: ['openai'] }
  },
  systemPrompt: 'Answer briefly.',
  prompt: 'Hello',
  signal: new AbortController().signal,
  maxOutputTokens: 256,
  outputLimitBytes: 65536,
  onUsage: (usage) => console.log(usage.inputTokens)
})
console.log(getOfficialVendor('openai')?.label, result.text)
```

The default fetch is `globalThis.fetch`. Hosts with proxy, certificate or runtime network policy
must inject their fetch implementation. Redirects are manual; public URLs require HTTPS and only
loopback endpoints allow HTTP. The client never retries, starts a server or obtains credentials.
Caller-owned cancellation and response limits apply per request. Billed usage can be reported even
when answer validation subsequently fails. Providers without complete text output fail closed.

Accounts, authorization, encrypted storage, subscriptions/OAuth, model selection, process launch,
HTTP bridge authentication, session caches and UI remain with the host. No filesystem, cwd,
environment variables, timers, queue or cross-request client state is used. Response readers cancel
on failure and release their reader lock. SSE conversion uses request-local state; its writer is
caller-owned. Replay reasoning maps and their shared reply object identity are caller-owned and
must remain isolated by session. The package performs no persistence or migrations. Target hashes,
provider IDs, reasoning values and serialized failure markers retain existing compatibility.

## Development

Install declared dependencies (supply a packed `@aipoch/diagnostics@0.1.0` when using unpublished
repository sources), then `npm run build`, `npm run typecheck`, `npm test`, and `npm pack`.
The package owns its Vitest configuration and fixtures; it needs no host setup or aliases.
From the repository use `npm run build:packages -- --packages=providers` and
`npm run check:providers-package` for clean-source build and installed-tarball acceptance.

Domain tests cover catalog/model matrices, reasoning projection, URL construction, redaction,
Responses conversion, fragmented SSE, strict answer validation and real loopback HTTP for all
three APIs. Host tests retain authentication, session isolation, bridge/cache lifecycle, framework
routing and translation target capture. See [test ownership](test-ownership.md) for migration evidence.
