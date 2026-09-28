import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  journalIdentityFromItem,
  journalSourceYearsSchema,
  selectJournalDatasets,
  type JournalSourceYears,
  type JournalRequest,
  type JournalAttribute,
  type JournalDataset,
  type JournalIdentity
} from '../../../../shared/journal-attributes'
import type { LiteratureItemInput } from '../../../../shared/literature'

type ResolutionIdentity = Extract<JournalRequest, { action: 'resolve' }>['identities'][number]

const SOURCE_YEARS_KEY = 'open-science:journal-source-years'
function readSourceYears(fallback: JournalSourceYears = {}): JournalSourceYears {
  try {
    return journalSourceYearsSchema.parse(
      JSON.parse(window.localStorage.getItem(SOURCE_YEARS_KEY) ?? '{}')
    )
  } catch {
    return fallback
  }
}
let sourceYears = readSourceYears()
const sourceListeners = new Set<() => void>()
const onSourceStorage = (event: StorageEvent): void => {
  if (
    event.storageArea === window.localStorage &&
    (event.key === null || event.key === SOURCE_YEARS_KEY)
  )
    applySourceYears(readSourceYears())
}
function subscribeSourceYears(listener: () => void): () => void {
  if (!sourceListeners.size) {
    applySourceYears(readSourceYears())
    window.addEventListener('storage', onSourceStorage)
  }
  sourceListeners.add(listener)
  return () => {
    sourceListeners.delete(listener)
    if (!sourceListeners.size) window.removeEventListener('storage', onSourceStorage)
  }
}
function applySourceYears(next: JournalSourceYears): void {
  if (JSON.stringify(next) === JSON.stringify(sourceYears)) return
  sourceYears = next
  // Never render values from the previous year beneath the new column headings.
  cache.clear()
  epoch++
  pending.clear()
  for (const [key, { identity }] of active) pending.set(key, identity)
  schedule()
  notify()
  sourceListeners.forEach((listener) => listener())
}
export function setJournalSourceYear(source: string, year: number | null | undefined): void {
  const next = { ...readSourceYears(sourceYears), [source]: year }
  if (year === undefined) delete next[source]
  const validated = journalSourceYearsSchema.parse(next)
  try {
    window.localStorage.setItem(SOURCE_YEARS_KEY, JSON.stringify(validated))
  } catch {
    // Non-critical view preferences remain usable for this window.
  }
  applySourceYears(validated)
}

const EMPTY: JournalAttribute[] = []
const FAILED: JournalAttribute[] = []
type Resolution = { attributes: JournalAttribute[]; identity?: JournalIdentity }
const EMPTY_RESOLUTION: Resolution = { attributes: EMPTY }
const FAILED_RESOLUTION: Resolution = { attributes: FAILED }
const NO_DATASETS: JournalDataset[] = []
let datasets = NO_DATASETS
let listing = false
let epoch = 0
let scheduled = false
let resolving = false
let dispose: (() => void) | undefined
const listeners = new Set<() => void>()
const cache = new Map<string, Resolution>()
// Retain at most twelve 50-row pages when navigating back through the library.
const INACTIVE_CACHE_LIMIT = 600
function trimCache(): void {
  let inactive = [...cache.keys()].filter((key) => !active.has(key)).length
  for (const key of cache.keys()) {
    if (inactive <= INACTIVE_CACHE_LIMIT) break
    if (!active.has(key)) {
      cache.delete(key)
      inactive--
    }
  }
}
const pending = new Map<string, ResolutionIdentity>()
const active = new Map<string, { identity: ResolutionIdentity; count: number }>()
const notify = (): void => listeners.forEach((listener) => listener())
const sameResolution = (left: Resolution | undefined, right: Resolution): boolean =>
  left === right ||
  (left !== undefined &&
    JSON.stringify(left.identity) === JSON.stringify(right.identity) &&
    left?.attributes.length === right.attributes.length &&
    left.attributes.every((attribute, index) => {
      const next = right.attributes[index]
      return (
        next !== undefined &&
        attribute.key === next.key &&
        attribute.label === next.label &&
        attribute.kind === next.kind &&
        attribute.value === next.value &&
        attribute.source === next.source &&
        attribute.year === next.year &&
        JSON.stringify(attribute.colors) === JSON.stringify(next.colors)
      )
    }))

async function flush(): Promise<void> {
  scheduled = false
  if (resolving) return
  const api = window.api?.literature?.journals
  if (!api) {
    pending.clear()
    return
  }
  const current = epoch
  const entries = [...pending].slice(0, 200)
  entries.forEach(([key]) => pending.delete(key))
  if (entries.length) {
    resolving = true
    let changed = false
    try {
      const result = await api({
        action: 'resolve',
        identities: entries.map(([, value]) => value),
        ...(Object.keys(sourceYears).length ? { sourceYears } : {})
      })
      if (current === epoch)
        entries.forEach(([key], index) => {
          if (active.has(key) && !pending.has(key)) {
            const next = result.matches?.[index] ?? EMPTY_RESOLUTION
            if (!sameResolution(cache.get(key), next)) {
              cache.set(key, next)
              changed = true
            }
          }
        })
    } catch {
      if (current === epoch)
        entries.forEach(([key]) => {
          if (active.has(key) && !pending.has(key) && !cache.has(key)) {
            cache.set(key, FAILED_RESOLUTION)
            changed = true
          }
        })
    }
    resolving = false
    if (current === epoch && changed) notify()
  }
  if (pending.size) schedule()
}
function schedule(): void {
  if (scheduled || resolving) return
  scheduled = true
  queueMicrotask(() => {
    void flush()
  })
}
async function loadDatasets(): Promise<void> {
  if (listing || !window.api?.literature?.journals) return
  listing = true
  const current = epoch
  try {
    const result = await window.api.literature.journals({ action: 'list' })
    if (current === epoch) {
      const next = (result.datasets ?? NO_DATASETS).map((dataset) => {
        const previous = datasets.find(({ id }) => id === dataset.id)
        return previous && JSON.stringify(previous) === JSON.stringify(dataset) ? previous : dataset
      })
      if (
        next.length !== datasets.length ||
        next.some((dataset, index) => dataset !== datasets[index])
      ) {
        datasets = next
        notify()
      }
    }
  } catch {
    /* Optional metadata never prevents opening a reference. Management shows errors. */
  } finally {
    listing = false
    if (current !== epoch && listeners.size) void loadDatasets()
  }
}
export function refreshJournalAttributes(): void {
  epoch++
  pending.clear()
  for (const key of cache.keys()) if (!active.has(key)) cache.delete(key)
  for (const [key, { identity }] of active) pending.set(key, identity)
  schedule()
  void loadDatasets()
}
function subscribe(listener: () => void): () => void {
  if (!listeners.size && !sourceListeners.size) sourceYears = readSourceYears()
  listeners.add(listener)
  if (listeners.size === 1 && typeof window.api?.literature?.journals === 'function') {
    const remove = window.api?.literature?.onChanged?.((event) => {
      // Identity edits can also remove a per-reference confirmation. Refresh mounted
      // local references even when their displayed snapshot has not changed yet.
      if (
        !event?.itemIds?.length &&
        !event?.collectionIds?.length &&
        !event?.candidateIds?.length
      ) {
        refreshJournalAttributes()
        return
      }
      const changedIds = new Set(event?.itemIds)
      if (!changedIds.size) return
      for (const key of cache.keys()) {
        if (!active.has(key) && changedIds.has(JSON.parse(key).itemId)) cache.delete(key)
      }
      for (const [key, { identity }] of active) {
        if (identity.itemId && changedIds.has(identity.itemId)) pending.set(key, identity)
      }
      // Pending keys also invalidate an older in-flight response for that identity.
      if (pending.size) schedule()
    })
    const visible = (): void => {
      if (document.visibilityState === 'visible') refreshJournalAttributes()
    }
    const storage = (event: StorageEvent): void => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === null || event.key === SOURCE_YEARS_KEY)
      )
        applySourceYears(readSourceYears())
    }
    window.addEventListener('storage', storage)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('open-science:web-events-open', refreshJournalAttributes)
    dispose = () => {
      remove?.()
      window.removeEventListener('storage', storage)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('open-science:web-events-open', refreshJournalAttributes)
    }
    void loadDatasets()
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      dispose?.()
      epoch++
      cache.clear()
      pending.clear()
      datasets = NO_DATASETS
    }
  }
}
export function useJournalDatasets(): JournalDataset[] {
  return useSyncExternalStore(
    subscribe,
    () => datasets,
    () => NO_DATASETS
  )
}
export function useJournalSourceYears(): JournalSourceYears {
  return useSyncExternalStore(
    subscribeSourceYears,
    () => sourceYears,
    () => sourceYears
  )
}
export function useDisplayedJournalDatasets(): JournalDataset[] {
  const all = useJournalDatasets()
  const years = useJournalSourceYears()
  return useMemo(() => selectJournalDatasets(all, years), [all, years])
}
export function useJournalAttributes(
  item: LiteratureItemInput,
  itemId?: string
): {
  attributes: JournalAttribute[]
  identity?: JournalIdentity
  failed: boolean
  retry: () => void
} {
  const identity = { ...journalIdentityFromItem(item), ...(itemId ? { itemId } : {}) }
  const key = JSON.stringify(identity)
  const snapshot = useSyncExternalStore(
    subscribe,
    () => cache.get(key) ?? EMPTY_RESOLUTION,
    () => EMPTY_RESOLUTION
  )
  const failed = snapshot === FAILED_RESOLUTION
  useEffect(() => {
    const identity: ResolutionIdentity = JSON.parse(key)
    const previous = active.get(key)
    active.set(key, { identity, count: (previous?.count ?? 0) + 1 })
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key)
      cache.set(key, cached)
    } else {
      pending.set(key, identity)
      schedule()
    }
    return () => {
      const value = active.get(key)
      if (value && value.count > 1) value.count--
      else {
        active.delete(key)
        if (cache.get(key) === FAILED_RESOLUTION) cache.delete(key)
        pending.delete(key)
        trimCache()
      }
    }
  }, [key])
  return {
    attributes: failed ? EMPTY : snapshot.attributes,
    identity: failed ? undefined : snapshot.identity,
    failed,
    retry: () => {
      if (cache.get(key) !== FAILED_RESOLUTION) return
      cache.delete(key)
      pending.set(key, identity)
      schedule()
      notify()
    }
  }
}
