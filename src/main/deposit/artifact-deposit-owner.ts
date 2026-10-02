// DOI links are additive exact-version metadata. A later database migration may index this
// sidecar, but no existing ArtifactVersion evidence or schema is rewritten in place.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  ArtifactDepositSourceNotFoundError,
  DepositApprovalRequiredError,
  DepositCredentialMissingError,
  DepositLineageMismatchError,
  DepositPreviewStaleError,
  canonicalDepositJson,
  completeDepositPreview,
  depositPreviewChecksum,
  depositPreviewWithoutChecksum,
  type ArtifactDepositLineage,
  type ArtifactDepositPreview,
  type ArtifactDepositReference,
  type ArtifactDepositSource,
  type ArtifactPublication,
  type DepositApprovalDecision,
  type DepositEnvironment,
  type DepositProvider,
  type DepositProviderId,
  type DepositReconciliation,
  type DepositReconciliationRequest,
  type ProviderPublishedDeposit
} from './deposit-provider'

export type { ArtifactDepositSource } from './deposit-provider'

export type ArtifactDepositSourceReader = {
  read(reference: ArtifactDepositReference): Promise<ArtifactDepositSource | undefined>
}

export type ArtifactPublicationStore = {
  findByVersion(
    versionId: string,
    provider?: DepositProviderId,
    environment?: DepositEnvironment
  ): Promise<ArtifactPublication | undefined>
  findLatestForArtifact(
    artifactId: string,
    provider: DepositProviderId,
    environment: DepositEnvironment
  ): Promise<ArtifactPublication | undefined>
  save(publication: ArtifactPublication): Promise<void>
}

export type DepositCredentialProvider = {
  getAccessToken(input: {
    provider: DepositProviderId
    environment: DepositEnvironment
  }): Promise<string | undefined>
}

type ArtifactDepositOwnerOptions = {
  sourceReader: ArtifactDepositSourceReader
  providers: Record<DepositProviderId, DepositProvider>
  credentials: DepositCredentialProvider
  publicationStore: ArtifactPublicationStore
  now?: () => Date
}

export type PrepareArtifactDepositRequest = {
  artifact: ArtifactDepositReference
  provider: DepositProviderId
  environment?: DepositEnvironment
}

export type ArtifactDepositOwner = {
  prepare(request: PrepareArtifactDepositRequest): Promise<ArtifactDepositPreview>
  execute(
    preview: ArtifactDepositPreview,
    decision: DepositApprovalDecision
  ): Promise<ArtifactPublication>
  reconcile(
    preview: ArtifactDepositPreview,
    outcome: DepositReconciliationRequest
  ): Promise<DepositReconciliation>
}

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const PUBLICATION_ROOT = 'artifact-publications'
const TEMPORARY_SUFFIX = '.tmp'

const assertSafeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const parsePublication = (raw: unknown): ArtifactPublication => {
  const value = object(raw)
  const artifact = object(value?.artifact)
  const crate = object(value?.crate)
  if (
    value?.schemaVersion !== 1 ||
    value.status !== 'published' ||
    (value.provider !== 'zenodo' && value.provider !== 'osf') ||
    (value.environment !== 'sandbox' && value.environment !== 'production') ||
    !artifact ||
    !crate ||
    !string(value.providerRecordId) ||
    !string(value.conceptDoi) ||
    !string(value.versionDoi) ||
    !string(value.depositedAt)
  ) {
    throw new Error('Invalid artifact publication metadata')
  }
  const requiredArtifactStrings = [
    'projectId',
    'sessionId',
    'artifactId',
    'versionId',
    'filename',
    'checksum',
    'createdAt'
  ] as const
  for (const key of requiredArtifactStrings) {
    if (!string(artifact[key])) throw new Error(`Invalid artifact publication ${key}`)
  }
  const versionNumber = number(artifact.versionNumber)
  const sizeBytes = number(artifact.sizeBytes)
  const crateSizeBytes = number(crate.sizeBytes)
  if (versionNumber === undefined || sizeBytes === undefined || crateSizeBytes === undefined) {
    throw new Error('Invalid artifact publication numeric metadata')
  }
  return {
    schemaVersion: 1,
    status: 'published',
    provider: value.provider,
    environment: value.environment,
    artifact: {
      projectId: artifact.projectId as string,
      sessionId: artifact.sessionId as string,
      artifactId: artifact.artifactId as string,
      versionId: artifact.versionId as string,
      versionNumber,
      filename: artifact.filename as string,
      checksum: artifact.checksum as string,
      sizeBytes,
      ...(typeof artifact.contentType === 'string' && artifact.contentType
        ? { contentType: artifact.contentType }
        : {}),
      createdAt: artifact.createdAt as string
    },
    crate: {
      filename: string(crate.filename) ?? 'ro-crate.zip',
      sizeBytes: crateSizeBytes,
      checksum: string(crate.checksum) ?? '',
      contentType: 'application/zip'
    },
    providerRecordId: string(value.providerRecordId)!,
    ...(string(value.providerConceptRecordId)
      ? { providerConceptRecordId: value.providerConceptRecordId as string }
      : {}),
    conceptDoi: string(value.conceptDoi)!,
    versionDoi: string(value.versionDoi)!,
    ...(string(value.landingUrl) ? { landingUrl: string(value.landingUrl)! } : {}),
    depositedAt: string(value.depositedAt)!
  }
}

const publicationPath = (
  root: string,
  publication: Pick<ArtifactPublication, 'artifact' | 'provider' | 'environment'>
): string =>
  join(
    root,
    PUBLICATION_ROOT,
    assertSafeSegment(publication.artifact.projectId, 'project id'),
    assertSafeSegment(publication.artifact.artifactId, 'artifact id'),
    assertSafeSegment(publication.provider, 'deposit provider'),
    assertSafeSegment(publication.environment, 'deposit environment'),
    `${assertSafeSegment(publication.artifact.versionId, 'artifact version id')}.json`
  )

const walkFiles = async (directory: string): Promise<string[]> => {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walkFiles(path)))
    else if (entry.isFile() && !entry.name.endsWith(TEMPORARY_SUFFIX)) files.push(path)
  }
  return files
}

export const createFileArtifactPublicationStore = (options: {
  root: string
}): ArtifactPublicationStore => {
  const root = resolve(options.root)
  const read = async (path: string): Promise<ArtifactPublication | undefined> => {
    try {
      return parsePublication(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (object(error)?.code === 'ENOENT') return undefined
      throw error
    }
  }
  return {
    findByVersion: async (versionId, provider, environment) => {
      assertSafeSegment(versionId, 'artifact version id')
      const files = await walkFiles(join(root, PUBLICATION_ROOT))
      for (const file of files) {
        const publication = await read(file)
        if (
          publication?.artifact.versionId === versionId &&
          (!provider || publication.provider === provider) &&
          (!environment || publication.environment === environment)
        ) {
          return publication
        }
      }
      return undefined
    },
    findLatestForArtifact: async (artifactId, provider, environment) => {
      assertSafeSegment(artifactId, 'artifact id')
      const files = await walkFiles(join(root, PUBLICATION_ROOT))
      let latest: ArtifactPublication | undefined
      for (const file of files) {
        const publication = await read(file)
        if (
          publication?.artifact.artifactId === artifactId &&
          publication.provider === provider &&
          publication.environment === environment &&
          (!latest || publication.artifact.versionNumber > latest.artifact.versionNumber)
        ) {
          latest = publication
        }
      }
      return latest
    },
    save: async (publication) => {
      const path = publicationPath(root, publication)
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}${TEMPORARY_SUFFIX}`
      try {
        await writeFile(temporary, `${JSON.stringify(publication, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    }
  }
}

const publicationFor = (input: {
  preview: ArtifactDepositPreview
  source: ArtifactDepositSource
  result: {
    providerRecordId: string
    providerConceptRecordId?: string
    conceptDoi: string
    versionDoi: string
    landingUrl?: string
  }
  depositedAt: Date
}): ArtifactPublication => ({
  schemaVersion: 1,
  status: 'published',
  provider: input.preview.provider,
  environment: input.preview.environment,
  artifact: input.source.artifact,
  crate: input.preview.files[0],
  providerRecordId: input.result.providerRecordId,
  ...(input.result.providerConceptRecordId
    ? { providerConceptRecordId: input.result.providerConceptRecordId }
    : {}),
  conceptDoi: input.result.conceptDoi,
  versionDoi: input.result.versionDoi,
  ...(input.result.landingUrl ? { landingUrl: input.result.landingUrl } : {}),
  depositedAt: input.depositedAt.toISOString()
})

const assertPublicationLineage = (
  preview: ArtifactDepositPreview,
  result: Pick<ProviderPublishedDeposit, 'conceptDoi'>
): void => {
  if (preview.lineage && result.conceptDoi !== preview.lineage.conceptDoi) {
    throw new DepositLineageMismatchError(preview.lineage.conceptDoi, result.conceptDoi)
  }
}

const lineageFrom = (
  publication: ArtifactPublication | undefined
): ArtifactDepositLineage | undefined =>
  publication
    ? {
        providerRecordId: publication.providerRecordId,
        ...(publication.providerConceptRecordId
          ? { providerConceptRecordId: publication.providerConceptRecordId }
          : {}),
        conceptDoi: publication.conceptDoi
      }
    : undefined

export const createArtifactDepositOwner = (
  options: ArtifactDepositOwnerOptions
): ArtifactDepositOwner => {
  const now = options.now ?? (() => new Date())

  const readSource = async (
    reference: ArtifactDepositReference
  ): Promise<ArtifactDepositSource> => {
    const source = await options.sourceReader.read(reference)
    if (!source) throw new ArtifactDepositSourceNotFoundError(reference)
    if (
      source.artifact.projectId !== reference.projectId ||
      source.artifact.sessionId !== reference.sessionId ||
      source.artifact.artifactId !== reference.artifactId ||
      source.artifact.versionId !== reference.versionId
    ) {
      throw new ArtifactDepositSourceNotFoundError(reference)
    }
    return source
  }

  const buildPreview = async (
    request: PrepareArtifactDepositRequest,
    source: ArtifactDepositSource
  ): Promise<ArtifactDepositPreview> => {
    const environment = request.environment ?? 'sandbox'
    const provider = options.providers[request.provider]
    const previous = await options.publicationStore.findLatestForArtifact(
      request.artifact.artifactId,
      request.provider,
      environment
    )
    const lineage = request.provider === 'zenodo' ? lineageFrom(previous) : undefined
    return completeDepositPreview(
      provider.preview({
        source,
        environment,
        ...(lineage ? { lineage } : {})
      })
    )
  }

  return {
    async prepare(request: PrepareArtifactDepositRequest): Promise<ArtifactDepositPreview> {
      return buildPreview(request, await readSource(request.artifact))
    },

    async execute(
      preview: ArtifactDepositPreview,
      decision: DepositApprovalDecision
    ): Promise<ArtifactPublication> {
      if (decision.outcome !== 'approved') throw new DepositApprovalRequiredError()
      const suppliedDraft = depositPreviewWithoutChecksum(preview)
      const suppliedChecksum = depositPreviewChecksum(suppliedDraft)
      if (
        decision.previewChecksum !== preview.previewChecksum ||
        suppliedChecksum !== preview.previewChecksum
      ) {
        throw new DepositPreviewStaleError()
      }

      const existing = await options.publicationStore.findByVersion(
        preview.artifact.versionId,
        preview.provider,
        preview.environment
      )
      if (existing) {
        if (
          existing.artifact.checksum !== preview.artifact.checksum ||
          existing.crate.checksum !== preview.files[0].checksum
        ) {
          throw new DepositPreviewStaleError(
            'Published artifact metadata does not match the approved preview.'
          )
        }
        return existing
      }

      const request: PrepareArtifactDepositRequest = {
        artifact: {
          projectId: preview.artifact.projectId,
          sessionId: preview.artifact.sessionId,
          artifactId: preview.artifact.artifactId,
          versionId: preview.artifact.versionId
        },
        provider: preview.provider,
        environment: preview.environment
      }
      const source = await readSource(request.artifact)
      const current = await buildPreview(request, source)
      if (
        current.previewChecksum !== preview.previewChecksum ||
        canonicalDepositJson(depositPreviewWithoutChecksum(current)) !==
          canonicalDepositJson(suppliedDraft)
      ) {
        throw new DepositPreviewStaleError()
      }

      const token = await options.credentials.getAccessToken({
        provider: current.provider,
        environment: current.environment
      })
      if (!token) throw new DepositCredentialMissingError(current.provider, current.environment)

      const result = await options.providers[current.provider].execute({
        preview: current,
        source,
        token
      })
      assertPublicationLineage(current, result)
      const publication = publicationFor({ preview: current, source, result, depositedAt: now() })
      await options.publicationStore.save(publication)
      return publication
    },

    async reconcile(
      preview: ArtifactDepositPreview,
      outcome: DepositReconciliationRequest
    ): Promise<DepositReconciliation> {
      if (
        outcome.previewChecksum !== preview.previewChecksum ||
        outcome.provider !== preview.provider ||
        outcome.environment !== preview.environment
      ) {
        throw new DepositPreviewStaleError('Reconciliation does not match the approved preview.')
      }
      const suppliedDraft = depositPreviewWithoutChecksum(preview)
      if (depositPreviewChecksum(suppliedDraft) !== preview.previewChecksum) {
        throw new DepositPreviewStaleError('Reconciliation preview checksum is invalid.')
      }
      const source = await readSource({
        projectId: preview.artifact.projectId,
        sessionId: preview.artifact.sessionId,
        artifactId: preview.artifact.artifactId,
        versionId: preview.artifact.versionId
      })
      const current = options.providers[preview.provider].preview({
        source,
        environment: preview.environment,
        ...(preview.lineage ? { lineage: preview.lineage } : {})
      })
      if (
        depositPreviewChecksum(current) !== preview.previewChecksum ||
        canonicalDepositJson(current) !== canonicalDepositJson(suppliedDraft)
      ) {
        throw new DepositPreviewStaleError('Artifact source changed before reconciliation.')
      }
      const token = await options.credentials.getAccessToken({
        provider: preview.provider,
        environment: preview.environment
      })
      if (!token) {
        throw new DepositCredentialMissingError(preview.provider, preview.environment)
      }
      const reconciliation = await options.providers[preview.provider].reconcile({
        preview,
        outcome,
        token
      })
      if (reconciliation.state !== 'published') return reconciliation
      assertPublicationLineage(preview, reconciliation.publication)
      const publication = publicationFor({
        preview,
        source,
        result: reconciliation.publication,
        depositedAt: now()
      })
      await options.publicationStore.save(publication)
      return { state: 'published', publication: reconciliation.publication }
    }
  }
}
