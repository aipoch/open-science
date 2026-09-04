// Provider requests carry credentials in headers or bodies. Keep redirects manual so fetch never
// forwards those credentials to an endpoint that was not selected by the provider configuration.
export const fetchProviderRequest = (
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => fetchImpl(input, { ...init, redirect: 'manual' })
