import { strToU8, zipSync, type Zippable } from 'fflate'

import type { ArtifactVersionInputEvidence } from '../../shared/artifact-provenance'
import { sha256 } from './provenance-canonical'
import {
  buildArtifactVersionRoCrateMetadata,
  environmentLockChecksums,
  NO_ADDITIONAL_RIGHTS,
  provenanceSidecars,
  RO_CRATE_CONTEXT,
  RO_CRATE_SPECIFICATION,
  serializeRoCrateMetadata,
  ZIP_MTIME,
  type ArtifactVersionRoCrateSource,
  type RoCrateEntity,
  type RoCrateMetadataDocument
} from './ro-crate-export'

const SESSION_LIGHTWEIGHT_PROFILE = 'urn:open-science:ro-crate-profile:session-lightweight'
const SESSION_COMPLETE_PROFILE = 'urn:open-science:ro-crate-profile:session-complete'
const PROJECT_LIGHTWEIGHT_PROFILE = 'urn:open-science:ro-crate-profile:project-lightweight'
const PROJECT_COMPLETE_PROFILE = 'urn:open-science:ro-crate-profile:project-complete'
const MAX_VERSION_SOURCES = 10_000
const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_COMPLETE_CONTENT_BYTES = 256 * 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024 * 1024
const SHA256_CHECKSUM = /^[a-f0-9]{64}$/u

type AggregateScopeFields = {
  projectId: string
  snapshotCapturedAt: string
  scopeCreatedAt?: string
  displayNameSnapshot?: string
  descriptionSnapshot?: string
  versions: readonly ArtifactVersionRoCrateSource[]
}

type AggregateRoCrateSource =
  | (AggregateScopeFields & { scope: 'session'; sessionId: string })
  | (AggregateScopeFields & { scope: 'project' })

type AggregateRoCrateContentReaders = {
  readVersionContent: (versionId: string) => Promise<Uint8Array | undefined>
  readInputContent: (input: ArtifactVersionInputEvidence) => Promise<Uint8Array | undefined>
  readEnvironmentLock?: (checksum: string) => Promise<string | undefined>
}

type VersionPackaging = {
  sidecars?: ReadonlyMap<string, string>
  packagedDataPaths?: ReadonlyMap<string, string>
  omittedDataReasons?: ReadonlyMap<string, string>
  packagedEnvironmentLockPaths?: ReadonlyMap<string, string>
  packagedEnvironmentLockContents?: ReadonlyMap<string, string>
}

const reference = (id: string): { '@id': string } => ({ '@id': id })
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const stringValues = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []

const mergeFileEntities = (
  existing: RoCrateEntity,
  candidate: RoCrateEntity
): RoCrateEntity | undefined => {
  if (
    existing['@type'] !== 'File' ||
    candidate['@type'] !== 'File' ||
    typeof existing.sha256 !== 'string' ||
    typeof candidate.sha256 !== 'string' ||
    existing.sha256 !== candidate.sha256 ||
    typeof existing.contentSize !== 'string' ||
    typeof candidate.contentSize !== 'string' ||
    existing.contentSize !== candidate.contentSize
  ) {
    return undefined
  }

  const existingIsPayload = typeof existing.version === 'string'
  const candidateIsPayload = typeof candidate.version === 'string'
  const base = candidateIsPayload && !existingIsPayload ? candidate : existing
  const secondary = base === existing ? candidate : existing
  const names = [
    ...stringValues(base.name),
    ...stringValues(base.alternateName),
    ...stringValues(secondary.name),
    ...stringValues(secondary.alternateName)
  ].filter((value, index, values) => values.indexOf(value) === index)
  const contentTypes = [
    ...stringValues(base.encodingFormat),
    ...stringValues(secondary.encodingFormat)
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort(compareText)

  const merged: RoCrateEntity = { ...secondary, ...base }
  if (names.length) merged.name = names[0]
  else delete merged.name
  if (names.length > 1) merged.alternateName = names.slice(1)
  else delete merged.alternateName
  if (contentTypes.length) {
    merged.encodingFormat = contentTypes.length === 1 ? contentTypes[0] : contentTypes
  } else {
    delete merged.encodingFormat
  }
  return merged
}

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

const pathSegment = (value: string): string => {
  const basename = value.split('.')[0]!
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    /[. ]$/u.test(value) ||
    WINDOWS_RESERVED_BASENAME.test(basename)
  ) {
    throw new Error(`RO-Crate archive path segment is not portable: ${value}`)
  }
  return encodeURIComponent(value)
}

const versionDatasetId = (source: ArtifactVersionRoCrateSource): string =>
  `artifacts/${pathSegment(source.evidence.artifact_id)}/versions/${pathSegment(source.evidence.version_id)}/`

const contextualPrefix = (source: ArtifactVersionRoCrateSource): string =>
  `artifact-version/${pathSegment(source.evidence.version_id)}`

const sortedVersions = (
  versions: readonly ArtifactVersionRoCrateSource[]
): ArtifactVersionRoCrateSource[] =>
  [...versions].sort(
    (left, right) =>
      compareText(left.evidence.project_id, right.evidence.project_id) ||
      compareText(left.evidence.app_session_id, right.evidence.app_session_id) ||
      compareText(left.evidence.artifact_id, right.evidence.artifact_id) ||
      left.evidence.version_number - right.evidence.version_number ||
      compareText(left.evidence.version_id, right.evidence.version_id)
  )

const assertValidDate = (value: string, label: string): void => {
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new Error(`RO-Crate ${label} is not a valid date.`)
  }
}

const validateAggregateSource = (source: AggregateRoCrateSource): void => {
  if (source.versions.length > MAX_VERSION_SOURCES) {
    throw new Error('RO-Crate aggregate version budget exceeded')
  }
  assertValidDate(source.snapshotCapturedAt, 'snapshot timestamp')
  if (source.scopeCreatedAt) assertValidDate(source.scopeCreatedAt, 'scope timestamp')

  const versionIds = new Set<string>()
  const fileVersions = new Map<string, { checksum: string; size: number }>()
  const checksumSizes = new Map<string, number>()
  const recordFileVersion = (id: string, checksum: string, size: number): void => {
    if (!SHA256_CHECKSUM.test(checksum)) {
      throw new Error(`RO-Crate content checksum is invalid: ${id}`)
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`RO-Crate content size is invalid: ${id}`)
    }
    const existing = fileVersions.get(id)
    if (existing && (existing.checksum !== checksum || existing.size !== size)) {
      throw new Error(`RO-Crate content identity conflict: ${id}`)
    }
    const existingSize = checksumSizes.get(checksum)
    if (existingSize !== undefined && existingSize !== size) {
      throw new Error(`RO-Crate content checksum has conflicting sizes: ${checksum}`)
    }
    fileVersions.set(id, { checksum, size })
    checksumSizes.set(checksum, size)
  }

  for (const version of source.versions) {
    const { descriptor, evidence } = version
    if (
      descriptor.projectId !== evidence.project_id ||
      descriptor.sessionId !== evidence.app_session_id ||
      descriptor.artifactId !== evidence.artifact_id ||
      descriptor.id !== evidence.version_id ||
      descriptor.versionId !== evidence.version_id ||
      descriptor.versionNumber !== evidence.version_number ||
      descriptor.name !== evidence.filename ||
      descriptor.size !== evidence.size_bytes ||
      descriptor.checksum !== evidence.checksum ||
      descriptor.createdAt !== evidence.created_at
    ) {
      throw new Error(`RO-Crate Artifact Version identity mismatch: ${evidence.version_id}`)
    }
    if (
      evidence.project_id !== source.projectId ||
      (source.scope === 'session' && evidence.app_session_id !== source.sessionId)
    ) {
      throw new Error(`RO-Crate Artifact Version is outside the ${source.scope} scope`)
    }
    if (descriptor.state !== 'finalized') {
      throw new Error(
        `RO-Crate aggregate requires finalized Artifact Versions: ${evidence.version_id}`
      )
    }
    if (version.review) {
      const assessment = version.review.selectedVersionAssessment
      if (
        version.review.selectedVersionId !== evidence.version_id ||
        assessment.projectId !== evidence.project_id ||
        assessment.sessionId !== evidence.app_session_id
      ) {
        throw new Error(`RO-Crate reviewer identity mismatch: ${evidence.version_id}`)
      }
    }
    if (versionIds.has(evidence.version_id)) {
      throw new Error(`RO-Crate aggregate contains duplicate version ID: ${evidence.version_id}`)
    }
    versionIds.add(evidence.version_id)
    recordFileVersion(evidence.version_id, evidence.checksum, evidence.size_bytes)
    for (const input of evidence.inputs) {
      recordFileVersion(input.input_file_version_id, input.checksum, input.size_bytes)
    }

    const inputsByKey = new Map(
      evidence.inputs.map((input) => [
        `${input.source_kind}\0${input.input_file_version_id}`,
        input
      ])
    )
    for (const run of version.execution?.runs ?? []) {
      for (const input of run.inputFileVersionKeys) {
        if (!inputsByKey.has(`${input.sourceKind}\0${input.inputFileVersionId}`)) {
          throw new Error(
            `RO-Crate CreateAction contains unknown input reference: ${input.inputFileVersionId}`
          )
        }
      }
      if (
        run.environmentLock &&
        run.environmentLock.state !== 'unavailable' &&
        !SHA256_CHECKSUM.test(run.environmentLock.lockChecksum)
      ) {
        throw new Error(
          `RO-Crate environment lock checksum is invalid: ${run.environmentLock.lockChecksum}`
        )
      }
    }
  }

  const outgoing = new Map<string, string[]>()
  for (const version of source.versions) {
    outgoing.set(
      version.evidence.version_id,
      version.evidence.inputs
        .map((input) => input.input_file_version_id)
        .filter((id) => versionIds.has(id))
    )
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (versionId: string): void => {
    if (visiting.has(versionId)) throw new Error(`RO-Crate cyclic input reference: ${versionId}`)
    if (visited.has(versionId)) return
    visiting.add(versionId)
    for (const inputId of outgoing.get(versionId) ?? []) visit(inputId)
    visiting.delete(versionId)
    visited.add(versionId)
  }
  for (const versionId of versionIds) visit(versionId)
}

const aggregateProfile = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete'
): string =>
  source.scope === 'session'
    ? profile === 'complete'
      ? SESSION_COMPLETE_PROFILE
      : SESSION_LIGHTWEIGHT_PROFILE
    : profile === 'complete'
      ? PROJECT_COMPLETE_PROFILE
      : PROJECT_LIGHTWEIGHT_PROFILE

const aggregateName = (source: AggregateRoCrateSource): string =>
  source.displayNameSnapshot ??
  (source.scope === 'session'
    ? `Open Science Session ${source.sessionId} RO-Crate`
    : `Open Science Project ${source.projectId} RO-Crate`)

const aggregateDescription = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete',
  partial = false
): string => {
  const provenanceDescription = `Open Science ${
    source.scope === 'session' ? 'Session' : 'Project'
  } Artifact Version provenance crate (${profile} profile).${
    partial
      ? ' Some data files could not be included and remain immutable checksum references, so this crate is not fully self-contained.'
      : ''
  }`
  return source.descriptionSnapshot
    ? `${source.descriptionSnapshot} ${provenanceDescription}`
    : provenanceDescription
}

const metadataDescriptor = (): RoCrateEntity => ({
  '@type': 'CreativeWork',
  '@id': 'ro-crate-metadata.json',
  about: reference('./'),
  conformsTo: reference(RO_CRATE_SPECIFICATION)
})

const aggregateRoot = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete',
  versionIds: readonly string[],
  partial = false
): RoCrateEntity => ({
  '@type': 'Dataset',
  '@id': './',
  name: aggregateName(source),
  ...(source.scopeCreatedAt ? { dateCreated: source.scopeCreatedAt } : {}),
  datePublished: source.snapshotCapturedAt,
  license: NO_ADDITIONAL_RIGHTS,
  description: aggregateDescription(source, profile, partial),
  conformsTo: reference(aggregateProfile(source, profile)),
  ...(versionIds.length ? { hasPart: versionIds.map(reference) } : {})
})

const buildAggregateMetadata = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete',
  packaging: ReadonlyMap<string, VersionPackaging> = new Map(),
  partial = false
): RoCrateMetadataDocument => {
  validateAggregateSource(source)
  const versions = sortedVersions(source.versions)
  const graph: RoCrateEntity[] = []
  const entitiesById = new Map<string, RoCrateEntity>()
  const versionDatasetIds: string[] = []

  for (const version of versions) {
    const versionPackaging = packaging.get(version.evidence.version_id)
    const document = buildArtifactVersionRoCrateMetadata(version, versionPackaging?.sidecars, {
      profile,
      packagedDataPaths: versionPackaging?.packagedDataPaths,
      omittedDataReasons: versionPackaging?.omittedDataReasons,
      packagedEnvironmentLockPaths: versionPackaging?.packagedEnvironmentLockPaths,
      packagedEnvironmentLockContents: versionPackaging?.packagedEnvironmentLockContents,
      rootId: versionDatasetId(version),
      rootName: `${version.evidence.filename} (Artifact Version v${version.evidence.version_number})`,
      contextualIdPrefix: contextualPrefix(version),
      includeMetadataDescriptor: false
    })
    versionDatasetIds.push(versionDatasetId(version))
    for (const candidate of document['@graph']) {
      const existing = entitiesById.get(candidate['@id'])
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(candidate)) continue
        const merged = mergeFileEntities(existing, candidate)
        if (!merged) throw new Error(`RO-Crate entity ID conflict: ${candidate['@id']}`)
        const index = graph.indexOf(existing)
        if (index >= 0) graph[index] = merged
        entitiesById.set(merged['@id'], merged)
        continue
      }
      entitiesById.set(candidate['@id'], candidate)
      graph.push(candidate)
    }
  }

  return {
    '@context': RO_CRATE_CONTEXT,
    '@graph': [
      metadataDescriptor(),
      aggregateRoot(source, profile, versionDatasetIds, partial),
      ...graph
    ]
  }
}

const buildAggregateRoCrateMetadata = (source: AggregateRoCrateSource): RoCrateMetadataDocument =>
  buildAggregateMetadata(source, 'lightweight')

const versionSidecars = (source: ArtifactVersionRoCrateSource): Map<string, string> => {
  const prefix = versionDatasetId(source)
  return new Map(
    [...provenanceSidecars(source)].map(([path, content]) => [`${prefix}${path}`, content])
  )
}

const assertMetadataBudget = (metadata: string, sidecarBytes: number): void => {
  if (Buffer.byteLength(metadata, 'utf8') + sidecarBytes > MAX_METADATA_BYTES) {
    throw new Error('RO-Crate aggregate metadata budget exceeded')
  }
}

const assertPortableArchivePaths = (paths: readonly string[]): void => {
  const portablePaths = new Map<string, string>()
  for (const path of paths) {
    const portablePath = path.normalize('NFD').toLowerCase()
    const existing = portablePaths.get(portablePath)
    if (existing && existing !== path) {
      throw new Error(`RO-Crate archive path conflicts: ${existing} and ${path}`)
    }
    portablePaths.set(portablePath, path)
  }
}

const buildAggregateRoCrateArchive = (source: AggregateRoCrateSource): Uint8Array => {
  validateAggregateSource(source)
  const packaging = new Map<string, VersionPackaging>()
  const entries: Zippable = {}
  let sidecarBytes = 0
  for (const version of sortedVersions(source.versions)) {
    const sidecars = versionSidecars(version)
    packaging.set(version.evidence.version_id, { sidecars })
    for (const [path, content] of sidecars) {
      sidecarBytes += Buffer.byteLength(content, 'utf8')
      entries[path] = [strToU8(content), { mtime: ZIP_MTIME }]
    }
  }
  if (1 + Object.keys(entries).length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('RO-Crate aggregate archive entry budget exceeded')
  }
  const metadata = buildAggregateMetadata(source, 'lightweight', packaging)
  const serializedMetadata = serializeRoCrateMetadata(metadata)
  assertMetadataBudget(serializedMetadata, sidecarBytes)
  entries['ro-crate-metadata.json'] = [strToU8(serializedMetadata), { mtime: ZIP_MTIME }]
  assertPortableArchivePaths(Object.keys(entries))
  return zipSync(entries, { level: 6 })
}

type ContentClaim = {
  ownerVersionId: string
  fileVersionId: string
  filename: string
  contentType?: string
  size: number
  checksum: string
  unavailableReason?: string
  read: () => Promise<Uint8Array | undefined>
}

type ContentGroup = {
  checksum: string
  size: number
  claims: ContentClaim[]
  names: string[]
  contentTypes: string[]
  path?: string
  bytes?: Uint8Array
  omittedReason?: string
}

const contentClaims = (
  versions: readonly ArtifactVersionRoCrateSource[],
  readers: AggregateRoCrateContentReaders
): ContentClaim[] =>
  versions.flatMap((version) => {
    const payload: ContentClaim = {
      ownerVersionId: version.evidence.version_id,
      fileVersionId: version.evidence.version_id,
      filename: version.evidence.filename,
      contentType: version.evidence.content_type,
      size: version.evidence.size_bytes,
      checksum: version.evidence.checksum,
      ...(version.contentStatus.state === 'unavailable'
        ? {
            unavailableReason: `are currently unavailable (${version.contentStatus.reason}) from the source installation`
          }
        : {}),
      read: () => readers.readVersionContent(version.evidence.version_id)
    }
    const inputs = [...version.evidence.inputs]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((input): ContentClaim => ({
        ownerVersionId: version.evidence.version_id,
        fileVersionId: input.input_file_version_id,
        filename: input.filename,
        contentType: input.content_type,
        size: input.size_bytes,
        checksum: input.checksum,
        read: () => readers.readInputContent(input)
      }))
    return [payload, ...inputs]
  })

const groupContentClaims = (claims: readonly ContentClaim[]): ContentGroup[] => {
  const groups = new Map<string, ContentGroup>()
  for (const claim of claims) {
    const existing = groups.get(claim.checksum)
    if (existing && existing.size !== claim.size) {
      throw new Error(`RO-Crate content checksum has conflicting sizes: ${claim.checksum}`)
    }
    const group =
      existing ??
      ({
        checksum: claim.checksum,
        size: claim.size,
        claims: [],
        names: [],
        contentTypes: []
      } satisfies ContentGroup)
    group.claims.push(claim)
    if (!group.names.includes(claim.filename)) group.names.push(claim.filename)
    if (claim.contentType && !group.contentTypes.includes(claim.contentType)) {
      group.contentTypes.push(claim.contentType)
    }
    groups.set(claim.checksum, group)
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      names: group.names.sort(compareText),
      contentTypes: group.contentTypes.sort(compareText)
    }))
    .sort((left, right) => compareText(left.checksum, right.checksum))
}

const readContentGroup = async (group: ContentGroup): Promise<void> => {
  const readable = group.claims.filter((claim) => !claim.unavailableReason)
  if (!readable.length) {
    group.omittedReason =
      group.claims.find((claim) => claim.unavailableReason)?.unavailableReason ??
      'are unavailable in the source data'
    return
  }
  let omittedReason: string | undefined
  for (const claim of readable) {
    const bytes = await claim.read()
    if (!bytes) {
      omittedReason = 'could not be read from the source installation'
      continue
    }
    if (bytes.byteLength !== group.size) {
      omittedReason = 'failed size verification'
      continue
    }
    if (sha256(Buffer.from(bytes)) !== group.checksum) {
      omittedReason = 'failed checksum verification'
      continue
    }
    group.path = `data/sha256/${group.checksum}`
    group.bytes = bytes
    return
  }
  group.omittedReason = omittedReason ?? 'could not be read from the source installation'
}

const sharedContentEntity = (group: ContentGroup): RoCrateEntity => ({
  '@type': 'File',
  '@id': group.path!,
  name: group.names[0]!,
  ...(group.names.length > 1 ? { alternateName: group.names.slice(1) } : {}),
  contentSize: String(group.size),
  sha256: group.checksum,
  ...(group.contentTypes.length
    ? {
        encodingFormat: group.contentTypes.length === 1 ? group.contentTypes[0] : group.contentTypes
      }
    : {}),
  description:
    'Immutable content included once in this RO-Crate and verified against its declared size and SHA-256 checksum.'
})

const packEnvironmentLocks = async (
  versions: readonly ArtifactVersionRoCrateSource[],
  packaging: Map<string, VersionPackaging>,
  readers: AggregateRoCrateContentReaders
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>()
  const paths = new Map<string, string>()
  for (const checksum of [...new Set(versions.flatMap(environmentLockChecksums))].sort(
    compareText
  )) {
    if (!readers.readEnvironmentLock) {
      throw new Error(`Environment lock is required for complete RO-Crate export: ${checksum}`)
    }
    const serialized = await readers.readEnvironmentLock(checksum)
    if (serialized === undefined) {
      throw new Error(`Environment lock is required for complete RO-Crate export: ${checksum}`)
    }
    if (sha256(serialized) !== checksum) {
      throw new Error(`Environment lock checksum mismatch: ${checksum}`)
    }
    const path = `provenance/environment-locks/${checksum}.json`
    contents.set(checksum, serialized)
    paths.set(checksum, path)
  }
  for (const version of versions) {
    const locks = environmentLockChecksums(version)
    if (!locks.length) continue
    const current = packaging.get(version.evidence.version_id) ?? {}
    packaging.set(version.evidence.version_id, {
      ...current,
      packagedEnvironmentLockPaths: new Map(
        locks.map((checksum) => [checksum, paths.get(checksum)!])
      ),
      packagedEnvironmentLockContents: new Map(
        locks.flatMap((checksum) => {
          const content = contents.get(checksum)
          return content === undefined ? [] : [[checksum, content]]
        })
      )
    })
  }
  return contents
}

const buildAggregateCompleteRoCrateArchive = async (
  source: AggregateRoCrateSource,
  readers: AggregateRoCrateContentReaders
): Promise<Uint8Array> => {
  validateAggregateSource(source)
  const versions = sortedVersions(source.versions)
  const groups = groupContentClaims(contentClaims(versions, readers))
  const declaredContentBytes = groups.reduce((total, group) => total + group.size, 0)
  if (declaredContentBytes > MAX_COMPLETE_CONTENT_BYTES) {
    throw new Error('RO-Crate aggregate content budget exceeded')
  }
  const packaging = new Map<string, VersionPackaging>()
  const entries: Zippable = {}
  let sidecarBytes = 0
  let sidecarCount = 0
  for (const version of versions) {
    const sidecars = versionSidecars(version)
    packaging.set(version.evidence.version_id, { sidecars })
    sidecarCount += sidecars.size
    for (const [path, content] of sidecars) {
      sidecarBytes += Buffer.byteLength(content, 'utf8')
      entries[path] = [strToU8(content), { mtime: ZIP_MTIME }]
    }
  }
  if (sidecarBytes > MAX_METADATA_BYTES) {
    throw new Error('RO-Crate aggregate metadata budget exceeded')
  }
  if (1 + sidecarCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error('RO-Crate aggregate archive entry budget exceeded')
  }

  for (const group of groups) await readContentGroup(group)
  for (const group of groups) {
    if (!group.path || !group.bytes) continue
    for (const claim of group.claims) {
      const current = packaging.get(claim.ownerVersionId) ?? {}
      const packagedDataPaths = new Map(current.packagedDataPaths ?? [])
      packagedDataPaths.set(claim.fileVersionId, group.path)
      packaging.set(claim.ownerVersionId, { ...current, packagedDataPaths })
    }
    entries[group.path] = [group.bytes, { mtime: ZIP_MTIME, level: 0 }]
  }
  for (const group of groups) {
    if (group.path) continue
    for (const claim of group.claims) {
      const current = packaging.get(claim.ownerVersionId) ?? {}
      const omittedDataReasons = new Map(current.omittedDataReasons ?? [])
      omittedDataReasons.set(claim.fileVersionId, group.omittedReason!)
      packaging.set(claim.ownerVersionId, { ...current, omittedDataReasons })
    }
  }
  const lockContents = await packEnvironmentLocks(versions, packaging, readers)
  for (const [checksum, content] of lockContents) {
    entries[`provenance/environment-locks/${checksum}.json`] = [
      strToU8(content),
      { mtime: ZIP_MTIME }
    ]
  }
  if (1 + Object.keys(entries).length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('RO-Crate aggregate archive entry budget exceeded')
  }

  const partial = groups.some((group) => !group.path)
  const metadata = buildAggregateMetadata(source, 'complete', packaging, partial)
  const sharedEntities = new Map(
    groups.filter((group) => group.path).map((group) => [group.path!, sharedContentEntity(group)])
  )
  metadata['@graph'] = metadata['@graph'].map(
    (candidate) => sharedEntities.get(candidate['@id']) ?? candidate
  )
  const serializedMetadata = serializeRoCrateMetadata(metadata)
  assertMetadataBudget(serializedMetadata, sidecarBytes)
  entries['ro-crate-metadata.json'] = [strToU8(serializedMetadata), { mtime: ZIP_MTIME }]
  assertPortableArchivePaths(Object.keys(entries))
  return zipSync(entries, { level: 6 })
}

export {
  buildAggregateCompleteRoCrateArchive,
  buildAggregateRoCrateArchive,
  buildAggregateRoCrateMetadata,
  PROJECT_COMPLETE_PROFILE,
  PROJECT_LIGHTWEIGHT_PROFILE,
  SESSION_COMPLETE_PROFILE,
  SESSION_LIGHTWEIGHT_PROFILE
}
export type { AggregateRoCrateContentReaders, AggregateRoCrateSource }
