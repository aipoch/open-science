import { net } from 'electron'

import type { FetchLike } from './github-import'

// Routes GitHub skill imports through Electron's Chromium network stack, which honors the system/VPN
// proxy the user's browser uses. Node's global fetch (undici) ignores that proxy and takes a direct
// path, so in proxied environments GitHub returns 403 for the direct requests while net.fetch succeeds.
export const netFetch: FetchLike = (url, init) =>
  net.fetch(url, init) as unknown as ReturnType<FetchLike>

// A `typeof fetch`-shaped view of net.fetch for callers that need the full Response API (`.text()`,
// AbortSignal, arbitrary headers) rather than the narrow FetchLike shape — e.g. the provider-validation
// probe, which reads the error body and aborts on timeout. Same proxy-honoring Chromium stack.
export const netFetchStandard = net.fetch as unknown as typeof fetch
