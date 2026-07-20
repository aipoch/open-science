import { net } from 'electron'

import type { FetchLike } from './github-import'

// Routes GitHub skill imports through Electron's Chromium network stack, which honors the system/VPN
// proxy the user's browser uses. Node's global fetch (undici) ignores that proxy and takes a direct
// path, so in proxied environments GitHub returns 403 for the direct requests while net.fetch succeeds.
export const netFetch: FetchLike = (url, init) =>
  net.fetch(url, init) as unknown as ReturnType<FetchLike>
