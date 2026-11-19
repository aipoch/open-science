import {
  getOfficialVendor,
  resolveVendorBaseUrl,
  resolveVendorModelCatalog,
  resolveVendorChatCompletionsBaseUrl,
  resolveVendorResponsesBaseUrl,
  resolveVendorModelApiEndpoints,
  isVendorModelMultimodal,
  getVendorModelReasoningCapability,
  type ModelProtocol,
  type OfficialVendorId,
  type CatalogModel,
  type CatalogSnapshot
} from '@aipoch/providers'
import { getOfficialVendorModelIds } from './provider-model-policy'

export type OfficialCatalogSource = {
  vendorId?: OfficialVendorId
  region?: string
  fetchedModels?: readonly string[]
  // ProviderView already contains the region and legacy discovery policy applied by main.
  models?: readonly string[]
  modelCatalog?: CatalogSnapshot
}

export const usesBundledModelCatalog = (vendorId: OfficialVendorId | undefined): boolean =>
  vendorId === 'openrouter' || vendorId === 'requesty'

// Disk snapshots may be edited independently of discovery. Only a vendor that publishes routes
// can supply a new path, and it must still belong to the registered discovery origin.
function resolveSnapshotRoutes(
  cached: CatalogModel['routes'],
  bundled: NonNullable<CatalogModel['routes']>,
  discoveryOrigin: string | undefined
): NonNullable<CatalogModel['routes']> {
  if (!cached) return bundled
  const routes: NonNullable<CatalogModel['routes']> = {}
  for (const protocol of ['messages', 'responses', 'chat-completions'] as const) {
    const base = cached[protocol]
    if (!base) continue
    if (base === bundled[protocol]) {
      routes[protocol] = base
    } else if (discoveryOrigin) {
      const url = URL.parse(base)
      if (
        url?.origin === discoveryOrigin &&
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        routes[protocol] = url.href.replace(/\/$/, '')
    }
  }
  return routes
}

/** Membership comes from the latest complete snapshot; bundled values only fill missing metadata. */
export function resolveOfficialModelCatalog(source: OfficialCatalogSource): CatalogModel[] {
  const { vendorId, region, modelCatalog } = source
  if (!vendorId) return []
  const vendor = getOfficialVendor(vendorId)
  if (!vendor) return []
  const curated = usesBundledModelCatalog(vendorId)
  const discovery =
    modelCatalog && !curated ? resolveVendorModelCatalog(vendorId, region) : undefined
  const discoveryOrigin = discovery?.options.routes ? URL.parse(discovery.url)?.origin : undefined
  const live = new Map(
    (curated ? undefined : modelCatalog)?.models.map((model) => [model.id, model])
  )
  const ids = curated
    ? vendor.models.map((model) => model.id)
    : modelCatalog
      ? [...live.keys()]
      : [...(source.models ?? getOfficialVendorModelIds(vendorId, region, source.fetchedModels))]
  if (vendorId === 'deepseek' && modelCatalog) {
    for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      if (!live.has(alias)) ids.push(alias)
    }
  }
  return ids
    .filter((id) => !/\[1m\]$/i.test(id))
    .map((id) => {
      const bundled = vendor.models.find((model) => model.id === id)
      const endpoints = resolveVendorModelApiEndpoints(vendorId, id)
      const routes: CatalogModel['routes'] = {}
      for (const endpoint of endpoints) {
        const base =
          endpoint === 'responses'
            ? (resolveVendorResponsesBaseUrl(vendorId, region) ??
              resolveVendorChatCompletionsBaseUrl(vendorId, region) ??
              resolveVendorBaseUrl(vendorId, region))
            : endpoint === 'chat-completions'
              ? (resolveVendorChatCompletionsBaseUrl(vendorId, region) ??
                resolveVendorBaseUrl(vendorId, region))
              : resolveVendorBaseUrl(vendorId, region)
        if (base) routes[endpoint] = base
      }
      const cached = live.get(id)
      return {
        id,
        ...(bundled
          ? { contextWindow: bundled.contextWindow, maxOutputTokens: bundled.maxOutputTokens }
          : {}),
        supportsImageInput: isVendorModelMultimodal(vendorId, id),
        reasoningEffort: getVendorModelReasoningCapability(vendorId, id),
        ...cached,
        routes: resolveSnapshotRoutes(cached?.routes, routes, discoveryOrigin)
      }
    })
}

export function catalogModelApiEndpoints(model: CatalogModel | undefined): ModelProtocol[] {
  return model && isCatalogModelAvailable(model)
    ? (Object.keys(model.routes ?? {}) as ModelProtocol[])
    : []
}

const isoShutdownDate =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/

function isRetired(lifecycle: string): boolean {
  if (['retired', 'offline', 'shutdown'].includes(lifecycle)) return true
  const match = isoShutdownDate.exec(lifecycle)
  if (!match) return false

  // Interpret dates and unqualified times in UTC on every host reading the snapshot.
  const [, date, time = '00:00', offset = 'Z'] = match
  const day = new Date(date)
  // Date.parse normalizes some invalid days, which must not retire an otherwise usable model.
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return false
  return Date.parse(`${date}T${time}${offset}`) <= Date.now()
}

export function isCatalogModelAvailable(model: CatalogModel): boolean {
  return (
    !isRetired(model.lifecycle ?? '') && (!model.routes || Object.keys(model.routes).length > 0)
  )
}
