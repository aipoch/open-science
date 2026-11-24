import { isSecureProviderUrl, PROVIDER_TRANSPORT_ERROR } from './url-security'

/** Cloneable upstream request rules. The sender supplies credentials separately. */
export type ProviderRequestPolicy = Readonly<{
  allowedUrls: readonly string[]
  credentialHeader: string
  credentialPrefix?: 'Bearer '
  headers?: Readonly<Record<string, string>>
  defaultHeaders?: Readonly<Record<string, string>>
  stripHeaderPrefix?: string
  routeIdentity?: string
  invalidEndpointMessage: string
}>

/** Verify the upstream destination before replacing client-supplied authentication. */
export function withProviderRequestPolicy(
  fetchImpl: typeof fetch,
  policy?: ProviderRequestPolicy,
  key?: string
): typeof fetch {
  if (!policy) return fetchImpl
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (!policy.allowedUrls.includes(url.href)) throw new Error(policy.invalidEndpointMessage)
    if (!key) throw new Error('API key is required.')

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    headers.delete('authorization')
    headers.delete('x-api-key')
    headers.delete('api-key')
    const prefix = policy.stripHeaderPrefix
    if (prefix) {
      for (const name of [...headers.keys()]) {
        if (name.startsWith(prefix)) headers.delete(name)
      }
    }
    for (const [name, value] of Object.entries(policy.defaultHeaders ?? {})) {
      if (!headers.has(name)) headers.set(name, value)
    }
    for (const [name, value] of Object.entries(policy.headers ?? {})) headers.set(name, value)
    headers.set(policy.credentialHeader, `${policy.credentialPrefix ?? ''}${key}`)
    return fetchImpl(input, { ...init, headers, redirect: 'error', credentials: 'omit' })
  }
}

// Enforce this at the sending boundary as well as the form: persisted configurations and every
// provider adapter must obey the same policy before credentials or content reach the network.
export const fetchProviderRequest = async (
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!isSecureProviderUrl(url)) throw new Error(PROVIDER_TRANSPORT_ERROR)
  // Provider requests carry credentials; never follow redirects to another selected or unselected URL.
  return fetchImpl(input, { ...init, redirect: 'manual' })
}
