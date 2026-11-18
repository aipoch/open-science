import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import type { LiteratureRendererApi } from './renderer-host'

const METADATA_CACHE_SIZE = 32
const METADATA_CACHE_MS = 5 * 60_000
const metadataCaches = new WeakMap<
  LiteratureRendererApi['literature']['lookupMetadata'],
  Map<string, { expires: number; result: Promise<LiteratureItemInput> }>
>()

export const lookupCachedLiteratureMetadata = async (
  api: Pick<LiteratureRendererApi, 'literature'>,
  reference: string,
  refresh = false
): Promise<LiteratureItemInput> => {
  const lookup = api.literature.lookupMetadata
  let cache = metadataCaches.get(lookup)
  if (!cache) {
    cache = new Map()
    metadataCaches.set(lookup, cache)
  }
  const cached = cache.get(reference)
  if (
    cached &&
    cached.expires > Date.now() &&
    (!refresh || cached.expires === Number.POSITIVE_INFINITY)
  ) {
    cache.delete(reference)
    cache.set(reference, cached)
    return cached.result
  }
  const result = lookup(reference)
  // The TTL covers reusable results, not time spent waiting for the network.
  const entry = { expires: Number.POSITIVE_INFINITY, result }
  cache.delete(reference)
  cache.set(reference, entry)
  while (cache.size > METADATA_CACHE_SIZE) cache.delete(cache.keys().next().value!)
  const entries = cache
  void result.then(
    () => {
      entry.expires = Date.now() + METADATA_CACHE_MS
    },
    () => {
      if (entries.get(reference) === entry) entries.delete(reference)
    }
  )
  return result
}
