import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import type { LiteratureRendererApi } from './renderer-host'

const METADATA_CACHE_SIZE = 32
const METADATA_CACHE_MS = 5 * 60_000
type MetadataEntry = {
  result: Promise<LiteratureItemInput>
  expires: number
  readers: number
  requestId?: string
}
const metadataCaches = new WeakMap<
  LiteratureRendererApi['literature']['lookupMetadata'],
  Map<string, MetadataEntry>
>()

export const lookupCachedLiteratureMetadata = async (
  api: Pick<LiteratureRendererApi, 'literature'>,
  reference: string,
  refresh = false,
  signal?: AbortSignal
): Promise<LiteratureItemInput> => {
  signal?.throwIfAborted()
  const lookup = api.literature.lookupMetadata
  let cache = metadataCaches.get(lookup)
  if (!cache) {
    cache = new Map()
    metadataCaches.set(lookup, cache)
  }
  const entries = cache
  let entry = entries.get(reference)
  if (!entry || entry.expires <= Date.now() || (refresh && Number.isFinite(entry.expires))) {
    // Existing PDF callers keep the original single-argument transport.
    const requestId = signal ? crypto.randomUUID() : undefined
    const result = requestId ? lookup(reference, requestId) : lookup(reference)
    const fresh = { result, requestId, readers: 0, expires: Infinity }
    entry = fresh
    void result.then(
      () => {
        fresh.expires = Date.now() + METADATA_CACHE_MS
      },
      () => {
        if (entries.get(reference) === fresh) entries.delete(reference)
      }
    )
  }
  entries.delete(reference)
  entries.set(reference, entry)
  while (entries.size > METADATA_CACHE_SIZE) entries.delete(entries.keys().next().value!)

  const current = entry
  current.readers++
  const release = (): void => {
    current.readers--
    if (
      current.readers === 0 &&
      current.requestId &&
      current.expires === Infinity &&
      signal?.aborted
    ) {
      if (entries.get(reference) === current) entries.delete(reference)
      void api.literature.cancelRelated({ requestId: current.requestId }).catch(() => undefined)
    }
  }
  signal?.addEventListener('abort', release, { once: true })
  try {
    return await current.result
  } finally {
    signal?.removeEventListener('abort', release)
    if (!signal?.aborted) release()
  }
}
