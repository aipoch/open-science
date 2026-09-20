import { isSensitiveUrlQueryKey } from './diagnostic-redaction'

export const PROVIDER_TRANSPORT_ERROR =
  'Remote model URLs must use HTTPS. HTTP is only allowed for localhost or loopback addresses.'

// URL parsing canonicalizes IPv4 shorthand/decimal forms before checking the loopback range.
const isLoopbackHostname = (url: URL): boolean =>
  url.hostname === 'localhost' ||
  url.hostname === '[::1]' ||
  /^127\.\d+\.\d+\.\d+$/.test(url.hostname)

export const isSecureProviderUrl = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url))

// True for a parseable http(s) base URL whose host is loopback — the shape every local model
// server (Ollama, LM Studio, llama.cpp, vLLM) serves on. Local servers require no API key, so
// validation surfaces use this to relax the key requirement for them.
export const isLoopbackProviderBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url)
  } catch {
    return false
  }
}

// Single source of the key policy shared by every layer that gates a custom gateway on
// credentials (upsert validation, auth preflight, form validation, transport eligibility): a
// custom gateway requires an API key unless its base URL is loopback, because local model
// servers serve without one.
export const customProviderRequiresKey = (baseUrl: string | undefined): boolean =>
  !isLoopbackProviderBaseUrl((baseUrl ?? '').trim())

export type CustomProviderBaseUrlError =
  | typeof PROVIDER_TRANSPORT_ERROR
  | 'Base URL must be a valid HTTP or HTTPS URL.'
  | 'Base URL must not include query parameters or fragments.'
  | 'Remove credentials from the Base URL and use the API key field.'

export const getCustomProviderBaseUrlError = (
  value: string
): CustomProviderBaseUrlError | undefined => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Base URL must be a valid HTTP or HTTPS URL.'
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return 'Base URL must be a valid HTTP or HTTPS URL.'
  }
  if (!isSecureProviderUrl(url)) return PROVIDER_TRANSPORT_ERROR
  if (url.username || url.password || [...url.searchParams.keys()].some(isSensitiveUrlQueryKey)) {
    return 'Remove credentials from the Base URL and use the API key field.'
  }
  if (url.search || url.hash) return 'Base URL must not include query parameters or fragments.'

  return undefined
}
