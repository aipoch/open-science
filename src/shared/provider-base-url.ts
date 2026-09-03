import { isSensitiveUrlQueryKey } from './diagnostic-redaction'

export type CustomProviderBaseUrlError =
  | 'Base URL must be a valid HTTP or HTTPS URL.'
  | 'Base URL must not include query parameters.'
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
  if (url.username || url.password || [...url.searchParams.keys()].some(isSensitiveUrlQueryKey)) {
    return 'Remove credentials from the Base URL and use the API key field.'
  }
  if (url.search) return 'Base URL must not include query parameters.'

  return undefined
}
