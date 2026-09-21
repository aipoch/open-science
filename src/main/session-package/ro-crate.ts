import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { ArtifactVersionEvidence } from '../../shared/artifact-provenance'
import {
  PACKAGE_MAX_BYTES,
  PACKAGE_RO_CRATE_METADATA,
  type SessionPackageManifest
} from '../../shared/session-package'
import {
  buildArtifactVersionRoCrateMetadata,
  serializeRoCrateMetadata,
  RO_CRATE_CONTEXT,
  RO_CRATE_SPECIFICATION,
  type RoCrateEntity,
  type RoCrateMetadataDocument
} from '../artifacts/ro-crate-export'
import { parseArtifactExecutionSnapshot } from '../artifacts/provenance-execution-snapshot-decoder'
import { sha256 } from '../artifacts/provenance-canonical'
import { PACKAGE_MAX_JSON_BYTES, packageEntry, readPackageJson } from './archive'
import { assertPackageCapacity } from './capacity'
import type { NativeRow, PackageRecords } from './native-snapshot'

const reference = (id: string): { '@id': string } => ({ '@id': id })
const versionId = (id: unknown): string => `urn:open-science:version:${String(id)}`
const artifactId = (id: unknown): string => `#artifact/${encodeURIComponent(String(id))}`

const sortedUniqueStrings = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

const entityStrings = (entity: RoCrateEntity | undefined, key: string): string[] => {
  const value = entity?.[key]
  if (typeof value === 'string') return [value]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

const assertArtifactEvidenceIdentity = (
  row: NativeRow,
  evidence: ArtifactVersionEvidence
): void => {
  const fields: ReadonlyArray<[string, unknown, unknown]> = [
    ['version ID', row.id, evidence.version_id],
    ['version number', row.versionNumber, evidence.version_number],
    ['filename', row.filename, evidence.filename],
    ['content type', row.contentType, evidence.content_type],
    ['size', row.sizeBytes, evidence.size_bytes],
    ['checksum', row.checksum, evidence.checksum],
    ['created at', row.createdAt, evidence.created_at]
  ]
  for (const [label, persisted, captured] of fields) {
    if (persisted === undefined || persisted === null || captured === undefined) continue
    if (String(persisted) !== String(captured))
      throw new Error(`RO-Crate Artifact evidence ${label} mismatch.`)
  }
}

const mergeFileIdentity = (
  existing: RoCrateEntity | undefined,
  filename: string,
  contentType: string | null
): { name: string; alternateName?: string[]; encodingFormat?: string | string[] } => {
  const names = sortedUniqueStrings([
    ...entityStrings(existing, 'name'),
    ...entityStrings(existing, 'alternateName'),
    filename
  ])
  const contentTypes = sortedUniqueStrings([
    ...entityStrings(existing, 'encodingFormat'),
    ...(contentType ? [contentType] : [])
  ])
  return {
    name: names[0] ?? filename,
    ...(names.length > 1 ? { alternateName: names.slice(1) } : {}),
    ...(contentTypes.length
      ? { encodingFormat: contentTypes.length === 1 ? contentTypes[0] : contentTypes }
      : {})
  }
}

// Only rewrite JSON-LD identities, never code, review prose or captured source text.
const scopeEntities = (value: unknown, scope: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => scopeEntities(item, scope))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === '@id' && typeof item === 'string'
          ? item === './'
            ? scope
            : item.startsWith('#')
              ? `${scope}/${item.slice(1)}`
              : item.startsWith('urn:open-science:connector:') ||
                  item.startsWith('urn:open-science:agent:')
                ? `${scope}/${encodeURIComponent(item)}`
                : item
          : scopeEntities(item, scope)
      ])
    )
  return value
}

/** Read-side projection of the exported snapshot, never today's live Session or file contents. */
export const buildSessionPackageRoCrateMetadata = async (
  manifest: SessionPackageManifest,
  records: PackageRecords,
  signal?: AbortSignal
): Promise<RoCrateMetadataDocument> => {
  const publishedAt = new Date(manifest.createdAt)
  if (!Number.isFinite(publishedAt.getTime()))
    throw new Error(
      'Session package creation timestamp cannot be represented in RO-Crate metadata.'
    )
  const inventory = manifest.inventory.filter((entry) => entry.path !== PACKAGE_RO_CRATE_METADATA)
  const packagedPaths = new Set(inventory.map((entry) => entry.path))
  const byStorageKey = new Map(
    inventory.filter((entry) => entry.storageKey).map((entry) => [entry.storageKey!, entry])
  )
  const excluded = new Set(manifest.excludedFiles.map((entry) => entry.storageKey))
  const versions = [...records.tables.ArtifactVersion, ...records.tables.UploadVersion]
  const contentSizes = new Map<string, number>()
  for (const row of versions) {
    const checksum = String(row.checksum)
    const size = Number(row.sizeBytes)
    const previous = contentSizes.get(checksum)
    if (previous !== undefined && previous !== size)
      throw new Error('RO-Crate content checksum has conflicting sizes.')
    contentSizes.set(checksum, size)
  }
  const packagedDataPaths = new Map<string, string>()
  const omittedDataReasons = new Map<string, string>()
  const entities = new Map<string, RoCrateEntity>()
  for (const entry of inventory) {
    entities.set(entry.path, {
      '@id': entry.path,
      '@type': 'File',
      name: entry.path,
      contentSize: String(entry.sizeBytes),
      sha256: entry.checksum,
      ...(entry.path.endsWith('.json') ? { encodingFormat: 'application/json' } : {})
    })
  }
  for (const row of versions) {
    const entry = byStorageKey.get(String(row.contentStorageKey))
    if (entry) {
      if (entry.checksum !== row.checksum || entry.sizeBytes !== Number(row.sizeBytes))
        throw new Error('RO-Crate content metadata mismatch.')
      packagedDataPaths.set(String(row.id), entry.path)
    } else {
      omittedDataReasons.set(
        String(row.id),
        excluded.has(String(row.contentStorageKey))
          ? 'were excluded from this export'
          : 'are unavailable in this package'
      )
    }
    const id = entry?.path ?? versionId(row.id)
    const existing = entities.get(id)
    const fileIdentity = mergeFileIdentity(
      existing?.identifier ? existing : undefined,
      String(row.filename),
      typeof row.contentType === 'string' ? row.contentType : null
    )
    entities.set(id, {
      ...existing,
      '@id': id,
      '@type': 'File',
      ...fileIdentity,
      identifier: [
        ...new Set([
          ...(Array.isArray(existing?.identifier) ? existing.identifier : []),
          versionId(row.id)
        ])
      ],
      contentSize: String(row.sizeBytes),
      sha256: row.checksum,
      description: entry
        ? 'Immutable file bytes included in this package.'
        : `The bytes ${omittedDataReasons.get(String(row.id))}; only their immutable identity and checksum are retained.`
    })
  }
  const fileReference = (id: unknown): { '@id': string } =>
    reference(packagedDataPaths.get(String(id)) ?? versionId(id))
  const artifactIds: string[] = []
  for (const row of records.tables.ArtifactVersion) {
    signal?.throwIfAborted()
    await yieldToEventLoop(undefined, { signal })
    if (row.originKind !== 'agent_generated' || typeof row.evidenceJson !== 'string') continue
    if (sha256(row.evidenceJson) !== row.evidenceChecksum)
      throw new Error('RO-Crate Artifact evidence checksum mismatch.')
    const evidence: ArtifactVersionEvidence = JSON.parse(row.evidenceJson)
    assertArtifactEvidenceIdentity(row, evidence)
    const execution =
      typeof row.executionSnapshotJson === 'string'
        ? parseArtifactExecutionSnapshot(row.executionSnapshotJson)
        : undefined
    const document = buildArtifactVersionRoCrateMetadata(
      {
        descriptor: { originKind: 'agent_generated' },
        contentStatus: packagedDataPaths.has(String(row.id))
          ? { state: 'available' }
          : { state: 'unavailable', reason: 'missing' },
        evidence,
        execution
      },
      new Map(),
      { profile: 'complete', packagedDataPaths, omittedDataReasons }
    )
    const scope = artifactId(row.id)
    artifactIds.push(scope)
    for (const original of document['@graph']) {
      if (original['@id'] === PACKAGE_RO_CRATE_METADATA || original['@type'] === 'File') continue
      const entity = scopeEntities(original, scope) as RoCrateEntity
      if (original['@id'] === './') {
        // This is a contextual per-version grouping within the Session crate, not another crate.
        delete entity.conformsTo
        entity.isPartOf = reference('./')
        entity.subjectOf = reference('records.json')
      }
      entities.set(entity['@id'], entity)
    }
  }

  // Preserve each captured assessment, including unbound/turn-level checks. Do not infer that
  // a Session-wide verdict proves every Artifact Version or that imported reviews ran locally.
  const findingsByReview = new Map<string, NativeRow[]>()
  for (const row of records.tables.Finding) {
    const key = String(row.reviewId)
    const findings = findingsByReview.get(key) ?? []
    findings.push(row)
    findingsByReview.set(key, findings)
  }
  const knownVersions = new Set(versions.map((row) => String(row.id)))
  for (const row of records.tables.Review) {
    const id = `#review/${encodeURIComponent(String(row.id))}`
    const findings = findingsByReview.get(String(row.id)) ?? []
    let scope: { artifactVersionIds?: unknown } = {}
    try {
      scope = JSON.parse(String(row.scope)) ?? {}
    } catch {
      /* Historical invalid scopes remain unbound. */
    }
    const targets = Array.isArray(scope.artifactVersionIds)
      ? scope.artifactVersionIds.filter(
          (id): id is string => typeof id === 'string' && knownVersions.has(id)
        )
      : []
    const reviewerId = `${id}/agent`
    entities.set(reviewerId, {
      '@id': reviewerId,
      '@type': 'SoftwareAgent',
      name: String(row.model ?? 'Unknown reviewer')
    })
    entities.set(id, {
      '@id': id,
      '@type': 'AssessAction',
      name: 'Captured review',
      actionStatus:
        row.lifecycle === 'complete'
          ? 'CompletedActionStatus'
          : row.lifecycle === 'running'
            ? 'ActiveActionStatus'
            : 'FailedActionStatus',
      startTime: row.createdAt,
      endTime: row.updatedAt,
      agent: reference(reviewerId),
      object: targets.map(fileReference),
      result: findings.map((finding) =>
        reference(`${id}/check/${encodeURIComponent(String(finding.id))}`)
      ),
      subjectOf: reference('records.json'),
      description: `Source-reported review outcome: ${row.outcome ?? 'unavailable'}. This is retained evidence, not a new verification.`
    })
    for (const finding of findings) {
      const checkId = `${id}/check/${encodeURIComponent(String(finding.id))}`
      entities.set(checkId, {
        '@id': checkId,
        '@type': 'Review',
        isPartOf: reference(id),
        ...(finding.artifactVersionId &&
        finding.artifactBindingState === 'scope_validated' &&
        knownVersions.has(String(finding.artifactVersionId))
          ? { itemReviewed: fileReference(finding.artifactVersionId) }
          : {}),
        reviewBody: `${finding.status}: ${finding.claim}\n\nEvidence: ${finding.evidence}`
      })
    }
  }
  for (const version of records.reproducibility?.versions ?? []) {
    const owner = entities.get(artifactId(version.versionId))
    for (const lock of version.environmentLocks) {
      const id = `#environment-lock/${lock.checksum}`
      if (!entities.has(id) || lock.serialized !== undefined)
        entities.set(id, {
          '@id': id,
          '@type': 'CreativeWork',
          name: 'Captured environment lock',
          identifier: `urn:sha256:${lock.checksum}`,
          encodingFormat: 'application/json',
          ...(lock.serialized !== undefined ? { isPartOf: reference('records.json') } : {}),
          description:
            lock.serialized !== undefined
              ? 'Serialized lock retained in records.json under reproducibility.versions[].environmentLocks, identified by checksum.'
              : 'Only the lock checksum is available; the lock content is not included.'
        })
      if (owner)
        owner.mentions = [...(Array.isArray(owner.mentions) ? owner.mentions : []), reference(id)]
    }
  }
  const metadata: RoCrateEntity = {
    '@id': PACKAGE_RO_CRATE_METADATA,
    '@type': 'CreativeWork',
    about: reference('./'),
    conformsTo: reference(RO_CRATE_SPECIFICATION)
  }
  const root: RoCrateEntity = {
    '@id': './',
    '@type': 'Dataset',
    name: manifest.source.title || manifest.source.projectName,
    datePublished: publishedAt.toISOString(),
    license: 'License information was not provided. This export grants no additional usage rights.',
    description:
      'Open Science Session research package with captured provenance. Excluded or unavailable files retain references only. Captured evidence does not guarantee deterministic replay.',
    hasPart: [...entities.values()]
      .filter((entity) => entity['@type'] === 'File')
      .map((entity) => reference(entity['@id'])),
    mentions: [...entities.values()]
      .filter((entity) => !packagedPaths.has(entity['@id']))
      .map((entity) => reference(entity['@id'])),
    ...(artifactIds.length ? { mainEntity: artifactIds.map(reference) } : {})
  }
  signal?.throwIfAborted()
  return { '@context': RO_CRATE_CONTEXT, '@graph': [metadata, root, ...entities.values()] }
}

export const writePackageRoCrateMetadata = async (
  directory: string,
  manifest: SessionPackageManifest,
  records: PackageRecords,
  signal?: AbortSignal
): Promise<void> => {
  const document = await buildSessionPackageRoCrateMetadata(manifest, records, signal)
  const content = serializeRoCrateMetadata(document)
  const sizeBytes = Buffer.byteLength(content)
  const inventory = manifest.inventory.filter((entry) => entry.path !== PACKAGE_RO_CRATE_METADATA)
  if (
    sizeBytes > PACKAGE_MAX_JSON_BYTES ||
    inventory.length >= 10000 ||
    inventory.reduce((sum, entry) => sum + entry.sizeBytes, sizeBytes) > PACKAGE_MAX_BYTES
  )
    throw new Error('RO-Crate metadata exceeds the Session package limit.')
  signal?.throwIfAborted()
  await assertPackageCapacity(directory, sizeBytes)
  await writeFile(join(directory, PACKAGE_RO_CRATE_METADATA), content, { signal })
  manifest.inventory = [
    ...inventory,
    await packageEntry(directory, PACKAGE_RO_CRATE_METADATA, 'metadata', signal)
  ]
  manifest.requiredFeatures = [
    ...new Set([...(manifest.requiredFeatures ?? []), 'ro-crate' as const])
  ]
}

// Validate the persisted package contract, not the current serializer's wording, graph order,
// or optional contextual properties. Native records remain the import/replay authority.
const metadataSchema = z.object({
  '@context': z.literal(RO_CRATE_CONTEXT),
  '@graph': z.array(
    z
      .object({
        '@id': z.string().min(1),
        '@type': z.union([z.string(), z.array(z.string())])
      })
      .passthrough()
  )
})
const rootMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  datePublished: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
  license: z.union([z.string().min(1), z.object({ '@id': z.string().min(1) })])
})
const referencesSchema = z.union([
  z.object({ '@id': z.string() }),
  z.array(z.object({ '@id': z.string() }))
])
const referenceIds = (value: unknown): string[] => {
  const parsed = referencesSchema.safeParse(value)
  return parsed.success
    ? (Array.isArray(parsed.data) ? parsed.data : [parsed.data]).map((ref) => ref['@id'])
    : []
}

export const validatePackageRoCrateMetadata = async (
  directory: string,
  manifest: SessionPackageManifest,
  records: PackageRecords,
  signal?: AbortSignal
): Promise<void> => {
  if (!manifest.requiredFeatures?.includes('ro-crate')) return
  signal?.throwIfAborted()
  const parsed = metadataSchema.safeParse(
    await readPackageJson(join(directory, PACKAGE_RO_CRATE_METADATA))
  )
  const invalid = (): never => {
    throw new Error('RO-Crate metadata does not match the Session package.')
  }
  if (!parsed.success) return invalid()
  const graph = new Map(parsed.data['@graph'].map((entity) => [entity['@id'], entity]))
  const hasType = (id: string, type: string): boolean => {
    const value = graph.get(id)?.['@type']
    return Array.isArray(value) ? value.includes(type) : value === type
  }
  const descriptor = graph.get(PACKAGE_RO_CRATE_METADATA)
  if (
    graph.size !== parsed.data['@graph'].length ||
    !hasType('./', 'Dataset') ||
    !rootMetadataSchema.safeParse(graph.get('./')).success ||
    !hasType(PACKAGE_RO_CRATE_METADATA, 'CreativeWork') ||
    !referenceIds(descriptor?.about).includes('./') ||
    !referenceIds(descriptor?.conformsTo).includes(RO_CRATE_SPECIFICATION)
  )
    return invalid()
  const inventory = manifest.inventory.filter((entry) => entry.path !== PACKAGE_RO_CRATE_METADATA)
  const byStorageKey = new Map(inventory.map((entry) => [entry.storageKey, entry.path]))
  const files = new Map(
    inventory.map((entry) => [
      entry.path,
      {
        checksum: entry.checksum,
        sizeBytes: String(entry.sizeBytes)
      }
    ])
  )
  for (const row of [...records.tables.ArtifactVersion, ...records.tables.UploadVersion]) {
    const id = byStorageKey.get(String(row.contentStorageKey)) ?? versionId(row.id)
    const existing = files.get(id)
    if (
      existing &&
      (existing.checksum !== row.checksum || existing.sizeBytes !== String(row.sizeBytes))
    )
      return invalid()
    files.set(id, { checksum: String(row.checksum), sizeBytes: String(row.sizeBytes) })
  }
  const reachable = new Set<string>()
  const pending = ['./']
  while (pending.length) {
    signal?.throwIfAborted()
    const id = pending.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    pending.push(...referenceIds(graph.get(id)?.hasPart))
  }
  for (const [id, file] of files) {
    const entity = graph.get(id)
    if (
      !hasType(id, 'File') ||
      !reachable.has(id) ||
      entity?.sha256 !== file.checksum ||
      entity?.contentSize !== file.sizeBytes
    )
      return invalid()
  }
  for (const id of graph.keys()) if (hasType(id, 'File') && !files.has(id)) return invalid()
}
