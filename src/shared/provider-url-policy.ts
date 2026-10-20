import { isSensitiveUrlQueryKey } from '@aipoch/diagnostics'
import {
  PROVIDER_TRANSPORT_ERROR,
  isSecureProviderUrl,
  isLoopbackProviderBaseUrl
} from '@aipoch/providers/transport'

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
