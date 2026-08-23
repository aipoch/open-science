import { createHash, randomUUID } from 'node:crypto'

import type {
  AddMarketplaceSourceRequest,
  GetMarketplaceReleaseRequest,
  InspectGitHubMarketplaceSourceRequest,
  MarketplaceInstallPreview,
  MarketplaceInstallRequest,
  MarketplaceInstallResult,
  MarketplaceDownloadProgress,
  MarketplaceSnapshot,
  MarketplaceSourceCandidate,
  MarketplaceSourceFailure,
  MarketplaceSourceView,
  MarketplaceSpecialistListing,
  MarketplaceSpecialistRelease,
  PrepareMarketplaceInstallRequest,
  RemoveMarketplaceSourceRequest
} from '../../../shared/specialist-marketplace'
import type { SpecialistMarketplaceProvenance } from '../../../shared/specialist'
import type { SpecialistPackageService } from '../package/service'
import { compareSemver } from '../package/semver'
import { filterMarketplaceSpecialistZip } from '../package/zip-adapter'
import {
  marketplaceKeyFingerprint,
  parseMarketplaceRelease,
  parseMarketplaceRoot,
  parseMarketplaceSignature,
  sha256,
  verifyMarketplaceRoot,
  type MarketplaceRelease,
  type MarketplaceRoot
} from './protocol'
import {
  MarketplaceRepository,
  type MarketplaceInstallProvenance,
  type StoredMarketplaceSource
} from './repository'
import { MarketplaceOperationCoordinator } from './operation-coordinator'

const CANDIDATE_TTL_MS = 10 * 60 * 1_000
// How long a verified cached root stays the primary answer for automatic refreshes. Kept short so
// a republished upstream becomes visible on the next view entry; a fresh-enough cache still
// answers without a network round trip. A user-initiated refresh bypasses this TTL, and a stale
// cache remains the offline fallback.
const ROOT_CACHE_TTL_MS = 60 * 1_000
const ROOT_MAX_BYTES = 2 * 1024 * 1024
const RELEASE_MAX_BYTES = 8 * 1024 * 1024
const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024
const METADATA_REQUEST_TIMEOUT_MS = 15_000
const ARTIFACT_REQUEST_TIMEOUT_MS = 120_000
const DROPPED_SELECTED_SKILL_DIAGNOSTICS = new Set([
  'skill.id-invalid',
  'skill.document-missing',
  'skill.document-invalid',
  'skill.name-mismatch',
  'skill.version-invalid',
  'specialist.skill-unavailable'
])

export type OfficialMarketplaceSourceConfig = {
  id: string
  name: string
  repositoryUrl: string
  ref: string
  metadataBaseUrls: readonly string[]
  artifactBaseUrls: readonly string[]
  trustedKeys: Readonly<Record<string, string>>
}

type MarketplaceServiceOptions = {
  repository: MarketplaceRepository
  operationCoordinator?: MarketplaceOperationCoordinator
  packages: Pick<
    SpecialistPackageService,
    'preview' | 'install' | 'candidateNewSkillIds' | 'cancel' | 'dispose'
  > &
    Partial<Pick<SpecialistPackageService, 'recover'>>
  fetch: typeof fetch
  officialSource?: OfficialMarketplaceSourceConfig
  now?: () => Date
  token?: () => string
  getDisabledSkillIds: () => Promise<readonly string[]>
  getInstalledSpecialists: () => Promise<
    readonly {
      id: string
      revision?: number
      origin?: 'local' | 'imported' | 'marketplace'
      archiveDigest?: string
      modifiedSinceImport?: boolean
    }[]
  >
  markMarketplaceManaged?: (id: string, expectedRevision: number) => Promise<void>
  setSkillsMainEnabled: (ids: readonly string[], enabled: boolean) => Promise<void>
}

type InstalledSpecialistIdentity = Awaited<
  ReturnType<MarketplaceServiceOptions['getInstalledSpecialists']>
>[number]

type ResolvedSource = {
  id: string
  kind: 'official' | 'github'
  name: string
  repositoryUrl: string
  owner: string
  repository: string
  ref: string
  trust: 'official' | 'user-approved'
  keyId: string
  publicKey: string
  keyFingerprint: string
  metadataBaseUrls: readonly string[]
  artifactBaseUrls: readonly string[]
  lastRefreshedAt?: string
}

type LoadedRelease = {
  source: ResolvedSource
  listing: MarketplaceRoot['specialists'][number]
  release: MarketplaceRelease
  releasePath: string
  releaseDigest: string
  view: MarketplaceSpecialistRelease
}

type LoadedRoot = {
  root: MarketplaceRoot
  refreshedAt: string
  usingCachedMetadata: boolean
}

type SourceCandidateState = {
  expiresAt: number
  ownerId?: number
  source: StoredMarketplaceSource
  view: MarketplaceSourceCandidate
}

type InstallCandidateState = {
  expiresAt: number
  ownerId?: number
  sourceId: string
  packageCandidateToken: string
  newSkillIds: readonly string[]
  provenance: MarketplaceInstallProvenance
}

class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceSourceFailure['code'],
    message: string
  ) {
    super(message)
    this.name = 'MarketplaceError'
  }
}

const githubRepository = (
  repositoryUrl: string
): { owner: string; repository: string; ref?: string } => {
  let url: URL
  try {
    url = new URL(repositoryUrl)
  } catch {
    throw new Error('Enter a valid public GitHub repository URL.')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error('Enter a public https://github.com repository URL.')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new Error('GitHub repository URL must include owner and repository.')
  const owner = parts[0]
  const repository = parts[1].replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GitHub repository owner or name is invalid.')
  }
  if (parts.length === 2) return { owner, repository }
  if (parts[2] !== 'tree' || parts.length < 4) {
    throw new Error('Use a repository URL or a GitHub tree URL containing a branch or tag.')
  }
  return { owner, repository, ref: parts.slice(3).join('/') }
}

const normalizedRepositoryUrl = (owner: string, repository: string): string =>
  `https://github.com/${owner}/${repository}`

const githubSourceId = (owner: string, repository: string, ref: string): string =>
  `github-${createHash('sha256')
    .update(`${owner.toLowerCase()}/${repository.toLowerCase()}\n${ref}`)
    .digest('hex')
    .slice(0, 24)}`

const rawGitHubBase = (owner: string, repository: string, ref: string): string =>
  `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/`

const sourceView = (source: ResolvedSource, metadata?: LoadedRoot): MarketplaceSourceView => {
  const lastRefreshedAt = metadata?.refreshedAt ?? source.lastRefreshedAt
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    repositoryUrl: source.repositoryUrl,
    ref: source.ref,
    trust: source.trust,
    keyId: source.keyId,
    keyFingerprint: source.keyFingerprint,
    removable: source.kind === 'github',
    ...(lastRefreshedAt ? { lastRefreshedAt } : {}),
    ...(metadata?.usingCachedMetadata ? { usingCachedMetadata: true } : {})
  }
}

const matchesInstalledProvenance = (
  provenance: MarketplaceInstallProvenance,
  specialist: InstalledSpecialistIdentity
): boolean =>
  specialist.id === provenance.specialistId &&
  (specialist.origin === 'imported' || specialist.origin === 'marketplace') &&
  provenance.installedArchiveDigest !== undefined &&
  specialist.archiveDigest === provenance.installedArchiveDigest

const githubAssetUrl = (
  source: Pick<ResolvedSource, 'owner' | 'repository'>,
  release: MarketplaceRelease
): string =>
  `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/releases/download/${encodeURIComponent(release.artifact.github_release.tag)}/${encodeURIComponent(release.artifact.github_release.asset_name)}`

const allowedGitHubHost = (hostname: string): boolean =>
  hostname === 'github.com' ||
  hostname === 'api.github.com' ||
  hostname === 'raw.githubusercontent.com' ||
  hostname === 'release-assets.githubusercontent.com' ||
  hostname === 'objects.githubusercontent.com' ||
  hostname.endsWith('.githubusercontent.com')

const readBounded = async (
  response: Response,
  limit: number,
  expectedTotal?: number,
  onProgress?: (transferred: number, total: number) => void
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('Response exceeds size limit.')
  const total = expectedTotal && expectedTotal > 0 ? expectedTotal : declared
  if (onProgress && total > 0) onProgress(0, total)
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw new Error('Response exceeds size limit.')
    if (onProgress && total > 0) onProgress(bytes.byteLength, total)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('Response exceeds size limit.')
      chunks.push(value)
      if (onProgress && total > 0) onProgress(size, total)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export class MarketplaceService {
  private readonly now: () => Date
  private readonly token: () => string
  private readonly sourceCandidates = new Map<string, SourceCandidateState>()
  private readonly installCandidates = new Map<string, InstallCandidateState>()
  private packageRecovery?: Promise<void>
  private readonly operationCoordinator: MarketplaceOperationCoordinator

  constructor(private readonly options: MarketplaceServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.token = options.token ?? randomUUID
    this.operationCoordinator =
      options.operationCoordinator ?? new MarketplaceOperationCoordinator()
  }

  async recover(): Promise<void> {
    await this.runExclusive(() => this.recoverUnlocked())
  }

  private async recoverUnlocked(): Promise<void> {
    this.packageRecovery ??= this.options.packages.recover?.() ?? Promise.resolve()
    await this.packageRecovery
    const [document, installedSpecialists] = await Promise.all([
      this.options.repository.getAll(),
      this.options.getInstalledSpecialists()
    ])
    for (const pending of document.pendingInstallations) {
      const provenance = pending.provenance
      const installed = installedSpecialists.some(
        (specialist) =>
          specialist.id === provenance.specialistId &&
          (specialist.origin === 'imported' || specialist.origin === 'marketplace') &&
          provenance.installedArchiveDigest !== undefined &&
          specialist.archiveDigest === provenance.installedArchiveDigest
      )
      if (installed) {
        await this.options.repository.completeInstallation(provenance)
        continue
      }
      if (pending.newlyDisabledSkillIds.length > 0) {
        await this.options.setSkillsMainEnabled(pending.newlyDisabledSkillIds, true)
      }
      await this.options.repository.clearPendingInstallation(
        provenance.sourceId,
        provenance.specialistId
      )
    }
    for (const specialist of installedSpecialists) {
      if (
        specialist.origin === 'imported' &&
        specialist.modifiedSinceImport === false &&
        specialist.revision !== undefined &&
        this.options.markMarketplaceManaged &&
        document.installations.some((provenance) =>
          matchesInstalledProvenance(provenance, specialist)
        )
      ) {
        await this.options.markMarketplaceManaged(specialist.id, specialist.revision)
      }
    }
  }

  async list(options?: { forceRefresh?: boolean }): Promise<MarketplaceSnapshot> {
    await this.recover()
    const [sources, document, installedSpecialists] = await Promise.all([
      this.sources(),
      this.options.repository.getAll(),
      this.options.getInstalledSpecialists()
    ])
    const results = await Promise.allSettled(
      sources.map(async (source) => ({
        source,
        loadedRoot: await this.loadRoot(source, options)
      }))
    )
    const specialists: MarketplaceSpecialistListing[] = []
    const failures: MarketplaceSourceFailure[] = []
    for (const [index, result] of results.entries()) {
      const source = sources[index]
      if (result.status === 'rejected') {
        const error = result.reason
        failures.push({
          sourceId: source.id,
          sourceName: source.name,
          code: error instanceof MarketplaceError ? error.code : 'unavailable',
          message: error instanceof Error ? error.message : 'Marketplace source is unavailable.'
        })
        continue
      }
      specialists.push(
        ...this.listings(
          result.value.source,
          result.value.loadedRoot.root,
          document.installations,
          installedSpecialists
        )
      )
      if (source.kind === 'github' && !result.value.loadedRoot.usingCachedMetadata) {
        await this.options.repository.markRefreshed(source.id, result.value.loadedRoot.refreshedAt)
      }
    }
    return {
      sources: sources.map((source, index) => {
        const result = results[index]
        return sourceView(
          source,
          result?.status === 'fulfilled' ? result.value.loadedRoot : undefined
        )
      }),
      specialists: specialists.sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.sourceName.localeCompare(right.sourceName)
      ),
      failures
    }
  }

  async installedSpecialistProvenance(
    installedSpecialists: readonly InstalledSpecialistIdentity[]
  ): Promise<ReadonlyMap<string, SpecialistMarketplaceProvenance>> {
    const document = await this.options.repository.getAll()
    const provenanceBySpecialistId = new Map<string, SpecialistMarketplaceProvenance>()

    // A Specialist may have provenance from more than one Marketplace source. The newest exact
    // installation is the current acquisition source; reverse first so equal timestamps prefer the
    // most recently recorded entry too.
    const newestFirst = [...document.installations]
      .reverse()
      .sort((left, right) => right.installedAt.localeCompare(left.installedAt))
    for (const provenance of newestFirst) {
      if (provenanceBySpecialistId.has(provenance.specialistId)) continue
      if (
        !installedSpecialists.some((specialist) =>
          matchesInstalledProvenance(provenance, specialist)
        )
      ) {
        continue
      }
      provenanceBySpecialistId.set(provenance.specialistId, {
        sourceId: provenance.sourceId,
        publisher: provenance.publisher,
        version: provenance.version
      })
    }
    return provenanceBySpecialistId
  }

  async inspectGitHubSource(
    request: InspectGitHubMarketplaceSourceRequest,
    ownerId?: number
  ): Promise<MarketplaceSourceCandidate> {
    if (!request || typeof request.repositoryUrl !== 'string') {
      throw new Error('GitHub repository URL is required.')
    }
    const parsed = githubRepository(request.repositoryUrl.trim())
    const ref = parsed.ref ?? (await this.defaultBranch(parsed.owner, parsed.repository))
    const repositoryUrl = normalizedRepositoryUrl(parsed.owner, parsed.repository)
    const metadataBaseUrl = rawGitHubBase(parsed.owner, parsed.repository, ref)
    const rootBytes = await this.fetchFrom(
      [new URL('marketplace.json', metadataBaseUrl).href],
      ROOT_MAX_BYTES
    )
    const signatureBytes = await this.fetchFrom(
      [new URL('marketplace.json.sig', metadataBaseUrl).href],
      ROOT_MAX_BYTES
    )
    const root = parseMarketplaceRoot(rootBytes)
    const signature = parseMarketplaceSignature(signatureBytes)
    if (!verifyMarketplaceRoot(rootBytes, signature)) {
      throw new MarketplaceError('verification', 'Marketplace root signature is invalid.')
    }
    const keyFingerprint = marketplaceKeyFingerprint(signature.public_key)
    const token = this.token()
    const source: StoredMarketplaceSource = {
      id: githubSourceId(parsed.owner, parsed.repository, ref),
      kind: 'github',
      repositoryUrl,
      owner: parsed.owner,
      repository: parsed.repository,
      ref,
      marketplaceId: root.marketplace.id,
      name: root.marketplace.name,
      keyId: signature.key_id,
      publicKey: signature.public_key,
      keyFingerprint,
      createdAt: this.now().toISOString()
    }
    const view = {
      candidateToken: token,
      repositoryUrl,
      ref,
      marketplaceId: root.marketplace.id,
      name: root.marketplace.name,
      keyId: signature.key_id,
      keyFingerprint,
      specialistCount: root.specialists.length
    }
    this.sourceCandidates.set(token, {
      expiresAt: this.now().getTime() + CANDIDATE_TTL_MS,
      ...(ownerId === undefined ? {} : { ownerId }),
      source,
      view
    })
    return view
  }

  async addSource(
    request: AddMarketplaceSourceRequest,
    ownerId?: number
  ): Promise<MarketplaceSourceView> {
    const candidate = this.sourceCandidates.get(request?.candidateToken)
    if (
      !candidate ||
      candidate.ownerId !== ownerId ||
      candidate.expiresAt <= this.now().getTime()
    ) {
      if (candidate?.expiresAt && candidate.expiresAt <= this.now().getTime()) {
        this.sourceCandidates.delete(request?.candidateToken)
      }
      throw new Error('Marketplace source review expired. Inspect the repository again.')
    }
    this.sourceCandidates.delete(request.candidateToken)
    await this.options.repository.addSource(candidate.source)
    return sourceView(this.resolveStoredSource(candidate.source))
  }

  async removeSource(request: RemoveMarketplaceSourceRequest): Promise<void> {
    if (
      !request ||
      typeof request.sourceId !== 'string' ||
      !request.sourceId.startsWith('github-')
    ) {
      throw new Error('Only a user-added Marketplace source can be removed.')
    }
    await this.options.repository.removeSource(request.sourceId)
  }

  async getRelease(request: GetMarketplaceReleaseRequest): Promise<MarketplaceSpecialistRelease> {
    return (await this.loadRelease(request)).view
  }

  async prepareInstall(
    request: PrepareMarketplaceInstallRequest,
    ownerId?: number,
    onDownloadProgress?: (progress: MarketplaceDownloadProgress) => void
  ): Promise<MarketplaceInstallPreview> {
    await this.recover()
    const loaded = await this.loadRelease(request)
    const requestedSkills = [...new Set(request.selectedSkillIds)]
    const requestedConnectors = [...new Set(request.selectedConnectorIds)]
    const skillById = new Map(loaded.release.skills.map((skill) => [skill.id, skill]))
    const connectorById = new Map(
      loaded.release.connectors.map((connector) => [connector.id, connector])
    )
    if (requestedSkills.some((id) => !skillById.has(id))) {
      throw new Error('Marketplace selection contains an unknown Skill.')
    }
    if (requestedConnectors.some((id) => !connectorById.has(id))) {
      throw new Error('Marketplace selection contains an unknown Connector.')
    }
    if (
      loaded.release.connectors.some(
        (connector) => connector.required && !requestedConnectors.includes(connector.id)
      )
    ) {
      throw new Error('Marketplace selection omits a required Connector.')
    }
    const archiveBytes = await this.downloadArtifact(loaded, (transferred, total) =>
      onDownloadProgress?.({
        sourceId: request.sourceId,
        specialistId: request.specialistId,
        version: request.version,
        transferred,
        total,
        percent: Math.min(100, Math.round((transferred / total) * 100))
      })
    )
    const requestedSkillNames = requestedSkills.map((id) => skillById.get(id)!.name)
    const filteredArchive = filterMarketplaceSpecialistZip(
      archiveBytes,
      requestedSkillNames,
      requestedConnectors
    )
    const preview = await this.options.packages.preview(filteredArchive, ownerId, {
      origin: 'marketplace'
    })
    try {
      if (
        (preview.summary &&
          (preview.summary.id !== loaded.release.specialist_id ||
            preview.summary.version !== loaded.release.version)) ||
        (preview.installable && !preview.summary)
      ) {
        throw new MarketplaceError(
          'verification',
          'Downloaded package identity does not match the reviewed Marketplace release.'
        )
      }
      if (preview.summary) {
        const retainedSkillNames = new Set(preview.summary?.skills.map((skill) => skill.id) ?? [])
        const selectedSkillNames = new Set(requestedSkillNames)
        const selectedConnectorIds = new Set(requestedConnectors)
        const capabilityDropped =
          requestedSkillNames.some((name) => !retainedSkillNames.has(name)) ||
          preview.diagnostics.some(
            (diagnostic) =>
              (diagnostic.relatedId !== undefined &&
                selectedSkillNames.has(diagnostic.relatedId) &&
                DROPPED_SELECTED_SKILL_DIAGNOSTICS.has(diagnostic.code)) ||
              (diagnostic.code === 'specialist.connector-unavailable' &&
                diagnostic.relatedId !== undefined &&
                selectedConnectorIds.has(diagnostic.relatedId))
          )
        if (capabilityDropped) {
          throw new MarketplaceError(
            'verification',
            'Downloaded package did not retain every selected Marketplace capability.'
          )
        }
      }
      const newSkillIds = this.options.packages.candidateNewSkillIds(
        preview.candidateToken,
        ownerId
      )
      if (!newSkillIds) {
        if (!preview.installable) return { release: loaded.view, package: preview }
        throw new Error('Marketplace package candidate is unavailable.')
      }
      this.installCandidates.set(preview.candidateToken, {
        expiresAt: this.now().getTime() + CANDIDATE_TTL_MS,
        ...(ownerId === undefined ? {} : { ownerId }),
        sourceId: loaded.source.id,
        packageCandidateToken: preview.candidateToken,
        newSkillIds,
        provenance: {
          sourceId: loaded.source.id,
          specialistId: loaded.release.specialist_id,
          publisher: loaded.listing.publisher.name,
          version: loaded.release.version,
          releasePath: loaded.releasePath,
          releaseDigest: loaded.releaseDigest,
          artifactDigest: loaded.release.artifact.sha256,
          installedArchiveDigest: sha256(filteredArchive),
          upstreamCommit: loaded.release.source.commit,
          selectedSkillIds: requestedSkills,
          selectedConnectorIds: requestedConnectors,
          installedAt: this.now().toISOString()
        }
      })
      return { release: loaded.view, package: preview }
    } catch (error) {
      this.options.packages.cancel(preview.candidateToken, ownerId)
      throw error
    }
  }

  async install(
    request: MarketplaceInstallRequest,
    ownerId?: number
  ): Promise<MarketplaceInstallResult> {
    return this.runExclusive(() => this.installExclusive(request, ownerId))
  }

  private async installExclusive(
    request: MarketplaceInstallRequest,
    ownerId?: number
  ): Promise<MarketplaceInstallResult> {
    const candidate = this.installCandidates.get(request?.candidateToken)
    if (!candidate || candidate.ownerId !== ownerId) {
      return { status: 'failed', code: 'candidate-invalid' }
    }
    if (candidate.expiresAt <= this.now().getTime()) {
      this.cancel(request.candidateToken, ownerId)
      return { status: 'failed', code: 'candidate-expired' }
    }
    await this.recoverUnlocked()
    const disabledBefore = new Set(await this.options.getDisabledSkillIds())
    const newlyDisabled = candidate.newSkillIds.filter((id) => !disabledBefore.has(id))
    await this.options.repository.beginInstallation({
      provenance: candidate.provenance,
      newlyDisabledSkillIds: newlyDisabled
    })
    let result: MarketplaceInstallResult
    try {
      if (candidate.newSkillIds.length > 0) {
        await this.options.setSkillsMainEnabled(candidate.newSkillIds, false)
      }
      result = await this.options.packages.install(request, ownerId, {
        activateAfterInstall: true,
        origin: 'marketplace'
      })
    } catch (error) {
      await this.rollbackPendingInstallation(candidate.provenance, newlyDisabled)
      throw error
    }
    if (result.status !== 'installed') {
      await this.rollbackPendingInstallation(candidate.provenance, newlyDisabled)
      return result
    }
    this.installCandidates.delete(request.candidateToken)
    try {
      await this.options.repository.completeInstallation(candidate.provenance)
      return { ...result, provenanceLinked: true }
    } catch {
      try {
        await this.recoverUnlocked()
        return { ...result, provenanceLinked: true }
      } catch {
        return { ...result, provenanceLinked: false }
      }
    }
  }

  private async rollbackPendingInstallation(
    provenance: MarketplaceInstallProvenance,
    newlyDisabledSkillIds: readonly string[]
  ): Promise<void> {
    if (newlyDisabledSkillIds.length > 0) {
      await this.options.setSkillsMainEnabled(newlyDisabledSkillIds, true)
    }
    await this.options.repository.clearPendingInstallation(
      provenance.sourceId,
      provenance.specialistId
    )
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.operationCoordinator.runExclusive(operation)
  }

  cancel(candidateToken: unknown, ownerId?: number): void {
    if (typeof candidateToken !== 'string') return
    if (this.sourceCandidates.get(candidateToken)?.ownerId === ownerId) {
      this.sourceCandidates.delete(candidateToken)
    }
    if (this.installCandidates.get(candidateToken)?.ownerId === ownerId) {
      this.installCandidates.delete(candidateToken)
    }
    this.options.packages.cancel(candidateToken, ownerId)
  }

  dispose(ownerId?: number): void {
    for (const [token, candidate] of this.sourceCandidates) {
      if (candidate.ownerId === ownerId) this.sourceCandidates.delete(token)
    }
    for (const [token, candidate] of this.installCandidates) {
      if (candidate.ownerId === ownerId) this.installCandidates.delete(token)
    }
    this.options.packages.dispose(ownerId)
  }

  private async sources(): Promise<ResolvedSource[]> {
    const stored = (await this.options.repository.getAll()).sources.map((source) =>
      this.resolveStoredSource(source)
    )
    const official = this.options.officialSource
    if (!official) return stored
    const repository = githubRepository(official.repositoryUrl)
    const [keyId, publicKey] = Object.entries(official.trustedKeys)[0] ?? []
    if (!keyId || !publicKey) throw new Error('Official Marketplace signing key is not configured.')
    return [
      {
        id: official.id,
        kind: 'official',
        name: official.name,
        repositoryUrl: normalizedRepositoryUrl(repository.owner, repository.repository),
        owner: repository.owner,
        repository: repository.repository,
        ref: official.ref,
        trust: 'official',
        keyId,
        publicKey,
        keyFingerprint: marketplaceKeyFingerprint(publicKey),
        metadataBaseUrls: official.metadataBaseUrls,
        artifactBaseUrls: official.artifactBaseUrls
      },
      ...stored
    ]
  }

  private resolveStoredSource(source: StoredMarketplaceSource): ResolvedSource {
    return {
      id: source.id,
      kind: 'github',
      name: source.name,
      repositoryUrl: source.repositoryUrl,
      owner: source.owner,
      repository: source.repository,
      ref: source.ref,
      trust: 'user-approved',
      keyId: source.keyId,
      publicKey: source.publicKey,
      keyFingerprint: source.keyFingerprint,
      metadataBaseUrls: [rawGitHubBase(source.owner, source.repository, source.ref)],
      artifactBaseUrls: [],
      ...(source.lastRefreshedAt ? { lastRefreshedAt: source.lastRefreshedAt } : {})
    }
  }

  private async findSource(sourceId: string): Promise<ResolvedSource> {
    const source = (await this.sources()).find((item) => item.id === sourceId)
    if (!source) throw new Error('Marketplace source is not configured.')
    return source
  }

  private async loadRoot(
    source: ResolvedSource,
    options?: { forceRefresh?: boolean }
  ): Promise<LoadedRoot> {
    const verifiedRoot = (rootBytes: Uint8Array, signatureBytes: Uint8Array): MarketplaceRoot => {
      const root = parseMarketplaceRoot(rootBytes)
      const signature = parseMarketplaceSignature(signatureBytes)
      if (
        signature.key_id !== source.keyId ||
        signature.public_key !== source.publicKey ||
        marketplaceKeyFingerprint(signature.public_key) !== source.keyFingerprint ||
        !verifyMarketplaceRoot(rootBytes, signature)
      ) {
        throw new MarketplaceError('verification', 'Marketplace verification failed.')
      }
      return root
    }
    // A cache younger than the TTL is a verified snapshot of slow-moving metadata, not a degraded
    // fallback, so it answers without the network round trip (and reports its original timestamp).
    if (!options?.forceRefresh) {
      const cached = await this.options.repository.getCachedRoot(source.id).catch(() => undefined)
      if (cached && this.now().getTime() - Date.parse(cached.cachedAt) < ROOT_CACHE_TTL_MS) {
        try {
          return {
            root: verifiedRoot(cached.rootBytes, cached.signatureBytes),
            refreshedAt: cached.cachedAt,
            usingCachedMetadata: false
          }
        } catch {
          // Corrupted or no-longer-trusted cache bytes: fall through to the network.
        }
      }
    }
    let remoteError: unknown
    for (const base of source.metadataBaseUrls) {
      try {
        // Root and signature are independent requests, so they fly together instead of serially.
        const [rootBytes, signatureBytes] = await Promise.all([
          this.fetchOne(new URL('marketplace.json', base).href, ROOT_MAX_BYTES, source),
          this.fetchOne(new URL('marketplace.json.sig', base).href, ROOT_MAX_BYTES, source)
        ])
        const root = verifiedRoot(rootBytes, signatureBytes)
        const refreshedAt = this.now().toISOString()
        await this.options.repository
          .cacheRoot(source.id, rootBytes, signatureBytes, refreshedAt)
          .catch(() => undefined)
        return { root, refreshedAt, usingCachedMetadata: false }
      } catch (error) {
        remoteError = error
      }
    }
    const cached = await this.options.repository.getCachedRoot(source.id).catch(() => undefined)
    if (cached) {
      try {
        return {
          root: verifiedRoot(cached.rootBytes, cached.signatureBytes),
          refreshedAt: cached.cachedAt,
          usingCachedMetadata: true
        }
      } catch {
        // Ignore corrupted or no-longer-trusted cache bytes and preserve the live failure below.
      }
    }
    if (remoteError instanceof MarketplaceError) throw remoteError
    throw new MarketplaceError('schema', 'Marketplace metadata is invalid or unavailable.')
  }

  private listings(
    source: ResolvedSource,
    root: MarketplaceRoot,
    installations: readonly MarketplaceInstallProvenance[],
    installedSpecialists: readonly {
      id: string
      revision?: number
      origin?: 'local' | 'imported' | 'marketplace'
      archiveDigest?: string
      modifiedSinceImport?: boolean
    }[]
  ): MarketplaceSpecialistListing[] {
    return root.specialists.map((item) => {
      const provenance = installations.find(
        (candidate) => candidate.sourceId === source.id && candidate.specialistId === item.id
      )
      const installed = provenance
        ? installedSpecialists.find((candidate) =>
            matchesInstalledProvenance(provenance, candidate)
          )
        : undefined
      return {
        sourceId: source.id,
        sourceName: source.name,
        sourceTrust: source.trust,
        id: item.id,
        displayName: item.display_name,
        summary: item.summary,
        publisher: item.publisher,
        version: item.latest.version,
        ...(installed
          ? {
              installedVersion: provenance?.version,
              ...(compareSemver(item.latest.version, provenance!.version) === 1
                ? { updateAvailable: true }
                : {})
            }
          : {})
      }
    })
  }

  private async loadRelease(request: GetMarketplaceReleaseRequest): Promise<LoadedRelease> {
    if (
      !request ||
      typeof request.sourceId !== 'string' ||
      typeof request.specialistId !== 'string' ||
      typeof request.version !== 'string'
    ) {
      throw new Error('Marketplace release request is invalid.')
    }
    const source = await this.findSource(request.sourceId)
    const root = (await this.loadRoot(source)).root
    const listing = root.specialists.find(
      (item) => item.id === request.specialistId && item.latest.version === request.version
    )
    if (!listing) throw new Error('Marketplace Specialist release is unavailable.')
    const releasePath = listing.latest.release.path
    let releaseBytes: Uint8Array
    try {
      releaseBytes = await this.fetchFrom(
        source.metadataBaseUrls.map((base) => new URL(releasePath, base).href),
        RELEASE_MAX_BYTES,
        source,
        false,
        undefined,
        undefined,
        (bytes) => {
          if (sha256(bytes) !== listing.latest.release.sha256) {
            throw new MarketplaceError('verification', 'Marketplace release digest does not match.')
          }
        }
      )
      await this.options.repository
        .cacheRelease(
          source.id,
          releasePath,
          listing.latest.release.sha256,
          releaseBytes,
          this.now().toISOString()
        )
        .catch(() => undefined)
    } catch (error) {
      const cached = await this.options.repository
        .getCachedRelease(source.id, releasePath, listing.latest.release.sha256)
        .catch(() => undefined)
      if (!cached) throw error
      releaseBytes = cached.bytes
      if (sha256(releaseBytes) !== listing.latest.release.sha256) throw error
    }
    const release = parseMarketplaceRelease(releaseBytes)
    if (release.specialist_id !== listing.id || release.version !== listing.latest.version) {
      throw new MarketplaceError('verification', 'Marketplace release identity does not match.')
    }
    return {
      source,
      listing,
      release,
      releasePath,
      releaseDigest: listing.latest.release.sha256,
      view: {
        sourceId: source.id,
        specialistId: release.specialist_id,
        displayName: listing.display_name,
        summary: listing.summary,
        publisher: listing.publisher,
        version: release.version,
        repository: release.source.repository,
        commit: release.source.commit,
        license: release.source.license,
        compressedBytes: release.artifact.compressed_bytes,
        uncompressedBytes: release.artifact.uncompressed_bytes,
        fileCount: release.artifact.file_count,
        defaultSkillIds: release.defaults.skill_ids,
        defaultConnectorIds: release.defaults.connector_ids,
        skills: release.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          displayName: skill.display_name,
          description: skill.description,
          fileCount: skill.file_count,
          uncompressedBytes: skill.uncompressed_bytes
        })),
        connectors: release.connectors.map((connector) => ({
          id: connector.id,
          required: connector.required,
          defaultSelected: connector.default_selected
        }))
      }
    }
  }

  private async downloadArtifact(
    loaded: LoadedRelease,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<Uint8Array> {
    const urls = [
      ...loaded.source.artifactBaseUrls.map(
        (base) => new URL(loaded.release.artifact.path, base).href
      ),
      githubAssetUrl(loaded.source, loaded.release)
    ]
    const bytes = await this.fetchFrom(
      urls,
      ARTIFACT_MAX_BYTES,
      loaded.source,
      true,
      loaded.release.artifact.compressed_bytes,
      onProgress,
      (bytes) => {
        if (
          bytes.byteLength !== loaded.release.artifact.compressed_bytes ||
          sha256(bytes) !== loaded.release.artifact.sha256
        ) {
          throw new MarketplaceError('verification', 'Marketplace artifact verification failed.')
        }
      }
    )
    return bytes
  }

  private async defaultBranch(owner: string, repository: string): Promise<string> {
    const bytes = await this.fetchFrom(
      [
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
      ],
      64 * 1024
    )
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { default_branch?: unknown }
    if (typeof value.default_branch !== 'string' || !value.default_branch) {
      throw new Error('Could not resolve the GitHub repository default branch.')
    }
    return value.default_branch
  }

  private async fetchFrom(
    urls: readonly string[],
    maxBytes: number,
    source?: ResolvedSource,
    allowArtifactRedirects = false,
    expectedTotal?: number,
    onProgress?: (transferred: number, total: number) => void,
    verify?: (bytes: Uint8Array) => void
  ): Promise<Uint8Array> {
    let lastError: unknown
    for (const url of urls) {
      try {
        const bytes = await this.fetchOne(
          url,
          maxBytes,
          source,
          allowArtifactRedirects,
          expectedTotal,
          onProgress
        )
        verify?.(bytes)
        return bytes
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new MarketplaceError('network', 'Marketplace request failed.')
  }

  private async fetchOne(
    initialUrl: string,
    maxBytes: number,
    source?: ResolvedSource,
    allowArtifactRedirects = false,
    expectedTotal?: number,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<Uint8Array> {
    let url = new URL(initialUrl)
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      this.assertAllowedUrl(url, source, allowArtifactRedirects)
      const response = await this.options.fetch(url, {
        redirect: 'manual',
        headers: { accept: 'application/json, application/zip, application/octet-stream' },
        signal: AbortSignal.timeout(
          allowArtifactRedirects ? ARTIFACT_REQUEST_TIMEOUT_MS : METADATA_REQUEST_TIMEOUT_MS
        )
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || redirects === 3) throw new Error('Marketplace redirect is invalid.')
        url = new URL(location, url)
        continue
      }
      if (!response.ok) throw new Error(`Marketplace request failed with HTTP ${response.status}.`)
      return readBounded(response, maxBytes, expectedTotal, onProgress)
    }
    throw new Error('Marketplace redirect limit exceeded.')
  }

  private assertAllowedUrl(
    url: URL,
    source?: ResolvedSource,
    allowArtifactRedirects = false
  ): void {
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new Error('Marketplace URL is not allowed.')
    }
    if (!source && allowedGitHubHost(url.hostname)) return
    if (source && (url.hostname === 'github.com' || url.hostname === 'raw.githubusercontent.com')) {
      const [owner, repository] = url.pathname.split('/').filter(Boolean)
      if (
        owner?.toLowerCase() === source.owner.toLowerCase() &&
        repository?.toLowerCase() === source.repository.toLowerCase()
      ) {
        return
      }
      throw new Error('Marketplace GitHub redirect left the configured repository.')
    }
    if (
      source &&
      allowArtifactRedirects &&
      allowedGitHubHost(url.hostname) &&
      url.hostname !== 'api.github.com'
    ) {
      return
    }
    if (
      source?.kind === 'official' &&
      [...source.metadataBaseUrls, ...source.artifactBaseUrls].some(
        (base) => new URL(base).origin === url.origin
      )
    ) {
      return
    }
    throw new Error('Marketplace host is not allowed.')
  }
}
