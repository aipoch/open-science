import { isIPv4 } from 'node:net'

export function parseRayDashboardEndpoint(endpoint: string): URL {
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    throw new Error('Invalid Ray Dashboard endpoint.')
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid Ray Dashboard endpoint.')
  // URL keeps a bare '?' or '#' in href even though its search/hash accessor is empty.
  base.search = ''
  base.hash = ''
  return base
}

/** Normalize an explicitly supplied Dashboard endpoint without reading process state. */
export function normalizeRayDashboardEndpoint(address: string): string {
  return parseRayDashboardEndpoint(address.trim()).href.replace(/\/+$/, '')
}

/** Resolve once for approval; use the pinned endpoint for subsequent requests. */
export function resolveRayJobsEndpoint(explicit?: string, saved?: string): string {
  const address =
    explicit?.trim() ||
    saved?.trim() ||
    process.env.RAY_DASHBOARD_URL?.trim() ||
    'http://127.0.0.1:8265'
  return normalizeRayDashboardEndpoint(address)
}

function allowsBearer(base: URL): boolean {
  return (
    base.protocol === 'https:' ||
    base.hostname === '[::1]' ||
    (isIPv4(base.hostname) && base.hostname.startsWith('127.'))
  )
}

export function isRayBearerEndpoint(endpoint: string): boolean {
  try {
    return allowsBearer(parseRayDashboardEndpoint(endpoint))
  } catch {
    return false
  }
}
