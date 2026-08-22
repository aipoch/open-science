import { join } from 'node:path'

import { readDurableJsonFile, writeDurableJsonFile } from '../../storage/durable-json-file'

export type StoredMarketplaceSource = {
  id: string
  kind: 'github'
  repositoryUrl: string
  owner: string
  repository: string
  ref: string
  marketplaceId: string
  name: string
  keyId: string
  publicKey: string
  keyFingerprint: string
  createdAt: string
  lastRefreshedAt?: string
}

export type MarketplaceInstallProvenance = {
  sourceId: string
  specialistId: string
  publisher: string
  version: string
  releasePath: string
  releaseDigest: string
  artifactDigest: string
  // Digest of the selection-filtered ZIP actually handed to SpecialistPackageService. Older
  // provenance records predate this field and remain readable, but cannot claim an exact install.
  installedArchiveDigest?: string
  upstreamCommit: string
  selectedSkillIds: string[]
  selectedConnectorIds: string[]
  installedAt: string
}

export type MarketplacePendingInstallation = {
  provenance: MarketplaceInstallProvenance
  newlyDisabledSkillIds: string[]
}

type MarketplaceRootCache = {
  sourceId: string
  rootBase64: string
  signatureBase64: string
  cachedAt: string
}

type MarketplaceReleaseCache = {
  sourceId: string
  path: string
  digest: string
  bytesBase64: string
  cachedAt: string
}

type MarketplaceDocument = {
  version: 1
  sources: StoredMarketplaceSource[]
  installations: MarketplaceInstallProvenance[]
  pendingInstallations: MarketplacePendingInstallation[]
  rootCaches: MarketplaceRootCache[]
  releaseCaches: MarketplaceReleaseCache[]
}

const emptyDocument = (): MarketplaceDocument => ({
  version: 1,
  sources: [],
  installations: [],
  pendingInstallations: [],
  rootCaches: [],
  releaseCaches: []
})

// Distinct release paths are stored as base64 in the same JSON document every
// marketplace read parses. Cap the working set; root caches stay 1:1 with sources.
export const MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES = 16
export const MAX_MARKETPLACE_RELEASE_CACHE_BYTES = 4 * 1024 * 1024

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)

const isGitCommit = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

const isCanonicalBase64 = (value: unknown, maxLength: number): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.length % 4 !== 0 ||
    // A grouped `{4}*` pattern overflows the regex stack on multi-mebibyte
    // release payloads. Alphabet + canonical round-trip is linear.
    /[^A-Za-z0-9+/=]/.test(value)
  ) {
    return false
  }
  return Buffer.from(value, 'base64').toString('base64') === value
}

const sanitizeSource = (value: unknown): StoredMarketplaceSource | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Partial<StoredMarketplaceSource>
  if (
    typeof source.id !== 'string' ||
    source.kind !== 'github' ||
    typeof source.repositoryUrl !== 'string' ||
    typeof source.owner !== 'string' ||
    typeof source.repository !== 'string' ||
    typeof source.ref !== 'string' ||
    typeof source.marketplaceId !== 'string' ||
    typeof source.name !== 'string' ||
    typeof source.keyId !== 'string' ||
    !isCanonicalBase64(source.publicKey, 1_024) ||
    !isSha256(source.keyFingerprint) ||
    !isIsoTimestamp(source.createdAt) ||
    (source.lastRefreshedAt !== undefined && !isIsoTimestamp(source.lastRefreshedAt))
  ) {
    return undefined
  }
  return {
    id: source.id,
    kind: 'github',
    repositoryUrl: source.repositoryUrl,
    owner: source.owner,
    repository: source.repository,
    ref: source.ref,
    marketplaceId: source.marketplaceId,
    name: source.name,
    keyId: source.keyId,
    publicKey: source.publicKey,
    keyFingerprint: source.keyFingerprint,
    createdAt: source.createdAt,
    ...(source.lastRefreshedAt ? { lastRefreshedAt: source.lastRefreshedAt } : {})
  }
}

const sanitizeInstallation = (value: unknown): MarketplaceInstallProvenance | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<MarketplaceInstallProvenance>
  if (
    typeof item.sourceId !== 'string' ||
    typeof item.specialistId !== 'string' ||
    typeof item.publisher !== 'string' ||
    typeof item.version !== 'string' ||
    typeof item.releasePath !== 'string' ||
    !isSha256(item.releaseDigest) ||
    !isSha256(item.artifactDigest) ||
    (item.installedArchiveDigest !== undefined && !isSha256(item.installedArchiveDigest)) ||
    !isGitCommit(item.upstreamCommit) ||
    !isStringArray(item.selectedSkillIds) ||
    !isStringArray(item.selectedConnectorIds) ||
    !isIsoTimestamp(item.installedAt)
  ) {
    return undefined
  }
  return {
    sourceId: item.sourceId,
    specialistId: item.specialistId,
    publisher: item.publisher,
    version: item.version,
    releasePath: item.releasePath,
    releaseDigest: item.releaseDigest,
    artifactDigest: item.artifactDigest,
    ...(item.installedArchiveDigest ? { installedArchiveDigest: item.installedArchiveDigest } : {}),
    upstreamCommit: item.upstreamCommit,
    selectedSkillIds: item.selectedSkillIds,
    selectedConnectorIds: item.selectedConnectorIds,
    installedAt: item.installedAt
  }
}

const sanitizePendingInstallation = (
  value: unknown
): MarketplacePendingInstallation | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<MarketplacePendingInstallation>
  const provenance = sanitizeInstallation(item.provenance)
  if (!provenance?.installedArchiveDigest || !isStringArray(item.newlyDisabledSkillIds)) {
    return undefined
  }
  return { provenance, newlyDisabledSkillIds: item.newlyDisabledSkillIds }
}

const sanitizeRootCache = (value: unknown): MarketplaceRootCache | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<MarketplaceRootCache>
  if (
    typeof item.sourceId !== 'string' ||
    !isCanonicalBase64(item.rootBase64, 3 * 1024 * 1024) ||
    !isCanonicalBase64(item.signatureBase64, 3 * 1024 * 1024) ||
    !isIsoTimestamp(item.cachedAt)
  ) {
    return undefined
  }
  return {
    sourceId: item.sourceId,
    rootBase64: item.rootBase64,
    signatureBase64: item.signatureBase64,
    cachedAt: item.cachedAt
  }
}

const sanitizeReleaseCache = (value: unknown): MarketplaceReleaseCache | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<MarketplaceReleaseCache>
  if (
    typeof item.sourceId !== 'string' ||
    typeof item.path !== 'string' ||
    !isSha256(item.digest) ||
    !isCanonicalBase64(item.bytesBase64, 12 * 1024 * 1024) ||
    !isIsoTimestamp(item.cachedAt)
  ) {
    return undefined
  }
  return {
    sourceId: item.sourceId,
    path: item.path,
    digest: item.digest,
    bytesBase64: item.bytesBase64,
    cachedAt: item.cachedAt
  }
}

const releaseCachePayloadBytes = (item: MarketplaceReleaseCache): number =>
  Buffer.byteLength(item.bytesBase64, 'base64')

const boundReleaseCaches = (caches: MarketplaceReleaseCache[]): MarketplaceReleaseCache[] => {
  if (caches.length <= MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES) {
    let totalBytes = 0
    let withinBudget = true
    for (const item of caches) {
      totalBytes += releaseCachePayloadBytes(item)
      if (totalBytes > MAX_MARKETPLACE_RELEASE_CACHE_BYTES) {
        withinBudget = false
        break
      }
    }
    if (withinBudget) return caches
  }

  const ranked = caches
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const time = Date.parse(right.item.cachedAt) - Date.parse(left.item.cachedAt)
      return time !== 0 ? time : right.index - left.index
    })
  const kept: { item: MarketplaceReleaseCache; index: number }[] = []
  let keptBytes = 0
  for (const entry of ranked) {
    const size = releaseCachePayloadBytes(entry.item)
    if (kept.length >= MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES) continue
    // Fetch allows an 8 MiB release JSON, which can exceed the 4 MiB working-set
    // budget by itself. Keep that newest row so offline fallback still works;
    // drop older rows rather than evicting the payload just viewed.
    if (kept.length > 0 && keptBytes + size > MAX_MARKETPLACE_RELEASE_CACHE_BYTES) continue
    kept.push(entry)
    keptBytes += size
  }
  return kept.sort((left, right) => left.index - right.index).map((entry) => entry.item)
}

const sanitizeDocument = (value: unknown): MarketplaceDocument => {
  if (!value || typeof value !== 'object') return emptyDocument()
  const document = value as {
    version?: unknown
    sources?: unknown
    installations?: unknown
    pendingInstallations?: unknown
    rootCaches?: unknown
    releaseCaches?: unknown
  }
  if (document.version !== 1) return emptyDocument()
  return {
    version: 1,
    sources: Array.isArray(document.sources)
      ? document.sources.flatMap((source) => sanitizeSource(source) ?? [])
      : [],
    installations: Array.isArray(document.installations)
      ? document.installations.flatMap((item) => sanitizeInstallation(item) ?? [])
      : [],
    pendingInstallations: Array.isArray(document.pendingInstallations)
      ? document.pendingInstallations.flatMap((item) => sanitizePendingInstallation(item) ?? [])
      : [],
    rootCaches: Array.isArray(document.rootCaches)
      ? document.rootCaches.flatMap((item) => sanitizeRootCache(item) ?? [])
      : [],
    releaseCaches: boundReleaseCaches(
      Array.isArray(document.releaseCaches)
        ? document.releaseCaches.flatMap((item) => sanitizeReleaseCache(item) ?? [])
        : []
    )
  }
}

export class MarketplaceRepository {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(storageDir: string) {
    this.filePath = join(storageDir, 'specialist-marketplace.json')
  }

  async getAll(): Promise<MarketplaceDocument> {
    const result = await readDurableJsonFile(this.filePath, (contents) =>
      sanitizeDocument(JSON.parse(contents))
    )
    return result.status === 'found' ? result.value : emptyDocument()
  }

  async addSource(source: StoredMarketplaceSource): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      sources: [...document.sources.filter((item) => item.id !== source.id), source]
    }))
  }

  async removeSource(sourceId: string): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      sources: document.sources.filter((source) => source.id !== sourceId),
      rootCaches: document.rootCaches.filter((cache) => cache.sourceId !== sourceId),
      releaseCaches: document.releaseCaches.filter((cache) => cache.sourceId !== sourceId)
    }))
  }

  async markRefreshed(sourceId: string, refreshedAt: string): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      sources: document.sources.map((source) =>
        source.id === sourceId ? { ...source, lastRefreshedAt: refreshedAt } : source
      )
    }))
  }

  async recordInstallation(provenance: MarketplaceInstallProvenance): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      installations: [
        ...document.installations.filter(
          (item) =>
            item.sourceId !== provenance.sourceId || item.specialistId !== provenance.specialistId
        ),
        provenance
      ]
    }))
  }

  async beginInstallation(pending: MarketplacePendingInstallation): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      pendingInstallations: [
        ...document.pendingInstallations.filter(
          (item) =>
            item.provenance.sourceId !== pending.provenance.sourceId ||
            item.provenance.specialistId !== pending.provenance.specialistId
        ),
        pending
      ]
    }))
  }

  async completeInstallation(provenance: MarketplaceInstallProvenance): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      installations: [
        ...document.installations.filter(
          (item) =>
            item.sourceId !== provenance.sourceId || item.specialistId !== provenance.specialistId
        ),
        provenance
      ],
      pendingInstallations: document.pendingInstallations.filter(
        (item) =>
          item.provenance.sourceId !== provenance.sourceId ||
          item.provenance.specialistId !== provenance.specialistId
      )
    }))
  }

  async clearPendingInstallation(sourceId: string, specialistId: string): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      pendingInstallations: document.pendingInstallations.filter(
        (item) =>
          item.provenance.sourceId !== sourceId || item.provenance.specialistId !== specialistId
      )
    }))
  }

  async cacheRoot(
    sourceId: string,
    rootBytes: Uint8Array,
    signatureBytes: Uint8Array,
    cachedAt: string
  ): Promise<void> {
    const cache: MarketplaceRootCache = {
      sourceId,
      rootBase64: Buffer.from(rootBytes).toString('base64'),
      signatureBase64: Buffer.from(signatureBytes).toString('base64'),
      cachedAt
    }
    await this.mutate((document) => ({
      ...document,
      rootCaches: [...document.rootCaches.filter((item) => item.sourceId !== sourceId), cache]
    }))
  }

  async getCachedRoot(
    sourceId: string
  ): Promise<{ rootBytes: Uint8Array; signatureBytes: Uint8Array; cachedAt: string } | undefined> {
    const cache = (await this.getAll()).rootCaches.find((item) => item.sourceId === sourceId)
    return cache
      ? {
          rootBytes: Uint8Array.from(Buffer.from(cache.rootBase64, 'base64')),
          signatureBytes: Uint8Array.from(Buffer.from(cache.signatureBase64, 'base64')),
          cachedAt: cache.cachedAt
        }
      : undefined
  }

  async cacheRelease(
    sourceId: string,
    path: string,
    digest: string,
    bytes: Uint8Array,
    cachedAt: string
  ): Promise<void> {
    const cache: MarketplaceReleaseCache = {
      sourceId,
      path,
      digest,
      bytesBase64: Buffer.from(bytes).toString('base64'),
      cachedAt
    }
    await this.mutate((document) => ({
      ...document,
      releaseCaches: boundReleaseCaches([
        ...document.releaseCaches.filter(
          (item) => item.sourceId !== sourceId || item.path !== path
        ),
        cache
      ])
    }))
  }

  async getCachedRelease(
    sourceId: string,
    path: string,
    digest: string
  ): Promise<{ bytes: Uint8Array; cachedAt: string } | undefined> {
    const cache = (await this.getAll()).releaseCaches.find(
      (item) => item.sourceId === sourceId && item.path === path && item.digest === digest
    )
    return cache
      ? {
          bytes: Uint8Array.from(Buffer.from(cache.bytesBase64, 'base64')),
          cachedAt: cache.cachedAt
        }
      : undefined
  }

  private async mutate(
    update: (document: MarketplaceDocument) => MarketplaceDocument
  ): Promise<void> {
    const run = this.queue.then(async () => this.write(update(await this.getAll())))
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async write(document: MarketplaceDocument): Promise<void> {
    await writeDurableJsonFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
