import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  rootCaches: MarketplaceRootCache[]
  releaseCaches: MarketplaceReleaseCache[]
}

const emptyDocument = (): MarketplaceDocument => ({
  version: 1,
  sources: [],
  installations: [],
  rootCaches: [],
  releaseCaches: []
})

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

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
    typeof source.publicKey !== 'string' ||
    typeof source.keyFingerprint !== 'string' ||
    typeof source.createdAt !== 'string'
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
    ...(typeof source.lastRefreshedAt === 'string'
      ? { lastRefreshedAt: source.lastRefreshedAt }
      : {})
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
    typeof item.releaseDigest !== 'string' ||
    typeof item.artifactDigest !== 'string' ||
    typeof item.upstreamCommit !== 'string' ||
    !isStringArray(item.selectedSkillIds) ||
    !isStringArray(item.selectedConnectorIds) ||
    typeof item.installedAt !== 'string'
  ) {
    return undefined
  }
  return {
    ...(item as MarketplaceInstallProvenance),
    ...(typeof item.installedArchiveDigest === 'string'
      ? { installedArchiveDigest: item.installedArchiveDigest }
      : {})
  }
}

const sanitizeRootCache = (value: unknown): MarketplaceRootCache | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<MarketplaceRootCache>
  if (
    typeof item.sourceId !== 'string' ||
    typeof item.rootBase64 !== 'string' ||
    item.rootBase64.length > 3 * 1024 * 1024 ||
    typeof item.signatureBase64 !== 'string' ||
    item.signatureBase64.length > 3 * 1024 * 1024 ||
    typeof item.cachedAt !== 'string'
  ) {
    return undefined
  }
  return item as MarketplaceRootCache
}

const sanitizeReleaseCache = (value: unknown): MarketplaceReleaseCache | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<MarketplaceReleaseCache>
  if (
    typeof item.sourceId !== 'string' ||
    typeof item.path !== 'string' ||
    typeof item.digest !== 'string' ||
    typeof item.bytesBase64 !== 'string' ||
    item.bytesBase64.length > 12 * 1024 * 1024 ||
    typeof item.cachedAt !== 'string'
  ) {
    return undefined
  }
  return item as MarketplaceReleaseCache
}

const sanitizeDocument = (value: unknown): MarketplaceDocument => {
  if (!value || typeof value !== 'object') return emptyDocument()
  const document = value as {
    version?: unknown
    sources?: unknown
    installations?: unknown
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
    rootCaches: Array.isArray(document.rootCaches)
      ? document.rootCaches.flatMap((item) => sanitizeRootCache(item) ?? [])
      : [],
    releaseCaches: Array.isArray(document.releaseCaches)
      ? document.releaseCaches.flatMap((item) => sanitizeReleaseCache(item) ?? [])
      : []
  }
}

export class MarketplaceRepository {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()
  private writeSequence = 0

  constructor(private readonly storageDir: string) {
    this.filePath = join(storageDir, 'specialist-marketplace.json')
  }

  async getAll(): Promise<MarketplaceDocument> {
    try {
      return sanitizeDocument(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument()
      throw error
    }
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
      releaseCaches: [
        ...document.releaseCaches.filter(
          (item) => item.sourceId !== sourceId || item.path !== path
        ),
        cache
      ]
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
    await mkdir(this.storageDir, { recursive: true })
    this.writeSequence += 1
    const temporary = `${this.filePath}.${Date.now()}-${this.writeSequence}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, this.filePath)
  }
}
