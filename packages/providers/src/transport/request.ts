import { isSecureProviderUrl, PROVIDER_TRANSPORT_ERROR } from './url-security'

// Enforce this at the sending boundary as well as the form: persisted configurations and every
// provider adapter must obey the same policy before credentials or content reach the network.
export type ProviderRequestInit = RequestInit & Readonly<{ allowInsecureHttp?: boolean }>

export const fetchProviderRequest = async (
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init?: ProviderRequestInit
): Promise<Response> => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!isSecureProviderUrl(url) && !(init?.allowInsecureHttp && url.protocol === 'http:'))
    throw new Error(PROVIDER_TRANSPORT_ERROR)
  // Provider requests carry credentials; never follow redirects to another selected or unselected URL.
  const requestInit = { ...init }
  delete requestInit.allowInsecureHttp
  return fetchImpl(input, { ...requestInit, redirect: 'manual' })
}
