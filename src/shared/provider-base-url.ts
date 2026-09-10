import { isSensitiveUrlQueryKey } from './diagnostic-redaction'

export const PROVIDER_TRANSPORT_ERROR =
  'Remote model URLs must use HTTPS. HTTP is only allowed for localhost or loopback addresses.'

// URL parsing canonicalizes IPv4 shorthand/decimal forms before checking the loopback range.
export const isSecureProviderUrl = (url: URL): boolean =>
  url.protocol === 'https:' ||
  (url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname)))

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
