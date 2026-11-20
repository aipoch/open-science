import {
  getOfficialVendor,
  type CatalogModel,
  type CatalogSnapshot,
  type OfficialVendorId
} from '@aipoch/providers'
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

// For snapshots without eligibility metadata, use the verified bundled eligibility for that ID.
export const kiloModelSupportsAnonymousAccess = (
  model: Pick<CatalogModel, 'id' | 'supportsAnonymousAccess'>
): boolean =>
  model.supportsAnonymousAccess ??
  getOfficialVendor('kilo')?.models.find(({ id }) => id === model.id)?.supportsAnonymousAccess ??
  false

/** Determine whether a saved provider or runtime connection allows anonymous requests. */
export function providerAllowsAnonymousAccess(provider: {
  type: string
  vendorId?: OfficialVendorId
  baseUrl?: string
  model?: string
  modelCatalog?: CatalogSnapshot
  modelAllowsAnonymousAccess?: boolean
}): boolean {
  if (provider.type === 'custom' && !customProviderRequiresKey(provider.baseUrl)) return true
  const vendor = provider.vendorId && getOfficialVendor(provider.vendorId)
  // The main process can represent a built-in provider as custom. Its runtime URL
  // still has to match the registered URL.
  if (
    vendor?.supportsAnonymousAccess !== true ||
    (provider.type !== 'official' &&
      !(provider.type === 'custom' && provider.baseUrl === vendor.baseUrl))
  )
    return false
  if (vendor.id !== 'kilo') return true
  if (provider.modelAllowsAnonymousAccess !== undefined) return provider.modelAllowsAnonymousAccess
  const selected = provider.model?.trim()
  const models = provider.modelCatalog?.models ?? vendor.models
  return models.some(
    (model) => (!selected || model.id === selected) && kiloModelSupportsAnonymousAccess(model)
  )
}

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

export const isOfficialOpenAiResponsesBase = (value: string | undefined): boolean => {
  if (!value) return false
  try {
    return new URL(value).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}
