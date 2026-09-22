import { strToU8, zipSync, type Zippable } from 'fflate'

import type {
  ArtifactExecutionSnapshot,
  ArtifactVersionInputEvidence,
  ArtifactVersionProvenance
} from '../../shared/artifact-provenance'
import type { ArtifactVersionReviewProjection } from '../../shared/reviewer'
import { outputFilename } from './export-filename'
import { sha256 } from './provenance-canonical'

const RO_CRATE_CONTEXT = 'https://w3id.org/ro/crate/1.1/context'
const RO_CRATE_SPECIFICATION = 'https://w3id.org/ro/crate/1.1'
// Lightweight profile: metadata + provenance records only. Data payloads are referenced by
// SHA-256 checksum and are not packaged. The complete profile includes verified available bytes.
const LIGHTWEIGHT_PROFILE = 'urn:open-science:ro-crate-profile:artifact-version-lightweight'
const COMPLETE_PROFILE = 'urn:open-science:ro-crate-profile:artifact-version-complete'
const ZIP_MTIME = new Date('1980-01-02T00:00:00.000Z')

type RoCrateEntity = { '@id': string } & Record<string, unknown>
type RoCrateMetadataDocument = { '@context': string; '@graph': RoCrateEntity[] }

type ArtifactVersionRoCrateSource = Pick<
  ArtifactVersionProvenance,
  'descriptor' | 'contentStatus' | 'evidence'
> & {
  execution?: ArtifactExecutionSnapshot
  review?: ArtifactVersionReviewProjection
}

type ArtifactVersionRoCrateContentReaders = {
  readVersionContent: (versionId: string) => Promise<Uint8Array | undefined>
  readInputContent: (input: ArtifactVersionInputEvidence) => Promise<Uint8Array | undefined>
}

// Package snapshots can provide the same immutable evidence without loading renderer projections.
type ArtifactVersionRoCrateMetadataSource = Pick<
  ArtifactVersionRoCrateSource,
  'contentStatus' | 'evidence' | 'review'
> & {
  descriptor: Pick<ArtifactVersionRoCrateSource['descriptor'], 'originKind'>
  execution?: Pick<ArtifactExecutionSnapshot, 'runs'>
}

type RoCrateMetadataOptions = {
  profile?: 'lightweight' | 'complete'
  packagedDataPaths?: ReadonlyMap<string, string>
  omittedDataReasons?: ReadonlyMap<string, string>
}

const fragment = (value: string): string => value.replace(/[^a-zA-Z0-9._~-]+/gu, '-')

const reference = (id: string): { '@id': string } => ({ '@id': id })

const propertyValue = (
  name: string,
  value: string | number | boolean
): { '@type': string; name: string; value: string | number | boolean } => ({
  '@type': 'PropertyValue',
  name,
  value
})

const versionEntityId = (versionId: string): string => `urn:open-science:version:${versionId}`

const notebookActionStatus = (
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'interrupted' | 'cancelled'
): string =>
  status === 'completed'
    ? 'CompletedActionStatus'
    : status === 'queued'
      ? 'PotentialActionStatus'
      : status === 'running'
        ? 'ActiveActionStatus'
        : 'FailedActionStatus'

const computeActionStatus = (
  status: 'queued' | 'submitted' | 'running' | 'success' | 'failed' | 'timeout' | 'error'
): string =>
  status === 'success'
    ? 'CompletedActionStatus'
    : status === 'queued'
      ? 'PotentialActionStatus'
      : status === 'submitted' || status === 'running'
        ? 'ActiveActionStatus'
        : 'FailedActionStatus'

const reviewActionStatus = (lifecycle: 'running' | 'complete' | 'error'): string =>
  lifecycle === 'complete'
    ? 'CompletedActionStatus'
    : lifecycle === 'running'
      ? 'ActiveActionStatus'
      : 'FailedActionStatus'

const isoFromEpochMs = (value: number): string => new Date(value).toISOString()

const serializeRoCrateMetadata = (document: RoCrateMetadataDocument): string =>
  `${JSON.stringify(document, null, 2)}\n`

const provenanceSidecars = (source: ArtifactVersionRoCrateSource): Map<string, string> => {
  const sidecars = new Map<string, string>()
  sidecars.set(
    'provenance/artifact-version-evidence.json',
    `${JSON.stringify(
      {
        descriptor: source.descriptor,
        contentStatus: source.contentStatus,
        evidence: source.evidence
      },
      null,
      2
    )}\n`
  )
  if (source.execution)
    sidecars.set(
      'provenance/execution-snapshot.json',
      `${JSON.stringify(source.execution, null, 2)}\n`
    )
  if (source.review)
    sidecars.set('provenance/review-projection.json', `${JSON.stringify(source.review, null, 2)}\n`)
  return sidecars
}

const buildArtifactVersionRoCrateMetadata = (
  source: ArtifactVersionRoCrateMetadataSource,
  sidecars: ReadonlyMap<string, string> = new Map(),
  options: RoCrateMetadataOptions = {}
): RoCrateMetadataDocument => {
  const { descriptor, evidence } = source
  const profile = options.profile ?? 'lightweight'
  // ZIP entry names are filesystem paths; JSON-LD identifiers are URI references.
  const packagedDataPaths = new Map(
    [...(options.packagedDataPaths ?? [])].map(([versionId, path]) => [
      versionId,
      path.split('/').map(encodeURIComponent).join('/')
    ])
  )
  const omittedDataReasons = options.omittedDataReasons ?? new Map<string, string>()
  const payloadId =
    packagedDataPaths.get(evidence.version_id) ?? versionEntityId(evidence.version_id)
  const graph: RoCrateEntity[] = []
  const contextualIds: string[] = []
  const add = (entity: RoCrateEntity, contextual = false): void => {
    if (graph.some((existing) => existing['@id'] === entity['@id'])) return
    graph.push(entity)
    if (contextual) contextualIds.push(entity['@id'])
  }

  const payloadFile: RoCrateEntity = {
    '@type': 'File',
    '@id': payloadId,
    name: evidence.filename,
    contentSize: String(evidence.size_bytes),
    sha256: evidence.checksum,
    ...(evidence.content_type ? { encodingFormat: evidence.content_type } : {}),
    dateCreated: evidence.created_at,
    version: `v${evidence.version_number}`,
    description: packagedDataPaths.has(evidence.version_id)
      ? 'Immutable Open Science Artifact Version payload included in this RO-Crate and verified against its declared size and SHA-256 checksum.'
      : source.contentStatus.state === 'unavailable'
        ? `Immutable Open Science Artifact Version payload. Payload content is currently unavailable (${source.contentStatus.reason}) from the source installation; the checksum remains the authoritative identity, and the bytes are not included in this crate.`
        : omittedDataReasons.has(evidence.version_id)
          ? `Immutable Open Science Artifact Version payload. The bytes ${omittedDataReasons.get(evidence.version_id)} and are not included; the checksum remains the authoritative identity.`
          : profile === 'lightweight'
            ? 'Immutable Open Science Artifact Version payload. This lightweight crate references the payload by SHA-256 checksum and does not include the bytes.'
            : 'Immutable Open Science Artifact Version payload referenced by SHA-256 checksum; the bytes are not included in this crate.',
    ...(descriptor.originKind
      ? { additionalProperty: [propertyValue('originKind', descriptor.originKind)] }
      : {})
  }

  const inputEntities: RoCrateEntity[] = [...evidence.inputs]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((input) => {
      const packaged = packagedDataPaths.has(input.input_file_version_id)
      const omittedReason = omittedDataReasons.get(input.input_file_version_id)
      return {
        '@type': 'File',
        '@id':
          packagedDataPaths.get(input.input_file_version_id) ??
          versionEntityId(input.input_file_version_id),
        name: input.filename,
        contentSize: String(input.size_bytes),
        sha256: input.checksum,
        ...(input.content_type ? { encodingFormat: input.content_type } : {}),
        ...(input.source_created_at ? { dateCreated: input.source_created_at } : {}),
        description: packaged
          ? `Exact immutable input file version (${input.source_kind}) included in this RO-Crate and verified against its declared size and SHA-256 checksum.`
          : omittedReason
            ? `Exact immutable input file version (${input.source_kind}). The bytes ${omittedReason} and are not included; the checksum remains the authoritative identity.`
            : `Exact immutable input file version (${input.source_kind}). Referenced by SHA-256 checksum and not included in this crate.`
      }
    })

  const agentId = `urn:open-science:agent:${fragment(evidence.conversation.agent_frame_id)}`
  const agentEntity: RoCrateEntity = {
    '@type': 'SoftwareAgent',
    '@id': agentId,
    name: evidence.agent_name ?? 'Open Science agent',
    description:
      'Agent that produced the conversation branch in which this Artifact Version was published.'
  }

  const producer = evidence.producer
  const notebookProducer =
    producer.state === 'available' && !('kind' in producer) ? producer : undefined
  const connectorProducer =
    producer.state === 'available' && 'kind' in producer ? producer : undefined
  let producerCodeId: string | undefined
  let connectorToolId: string | undefined
  if (notebookProducer && evidence.reproduction_code) {
    producerCodeId = '#producer-code'
  } else if (connectorProducer) {
    connectorToolId = `urn:open-science:connector:${fragment(connectorProducer.connector_id)}/tool:${fragment(connectorProducer.tool_id)}`
  }

  const environment = evidence.environment
  let environmentId: string | undefined
  const packageIds: string[] = []
  if (environment) {
    environmentId = '#environment'
    const seenPackages = new Set<string>()
    for (const pkg of environment.packages) {
      const id = `#package/${fragment(pkg.ecosystem)}/${fragment(pkg.name)}`
      if (seenPackages.has(id)) continue
      seenPackages.add(id)
      packageIds.push(id)
    }
  }

  const kernelIds = new Map<string, string>()
  const kernelId = (kind: string): string => {
    const existing = kernelIds.get(kind)
    if (existing) return existing
    const id = `#kernel/${fragment(kind)}`
    kernelIds.set(kind, id)
    return id
  }

  const inputsByVersionId = new Map(
    evidence.inputs.map((input) => [input.input_file_version_id, input])
  )
  const createActionEntities: RoCrateEntity[] = []
  const runs = source.execution?.runs ?? []
  const producerRunId = notebookProducer?.producer_run_id
  for (const run of runs) {
    const isProducerRun = run.runId === producerRunId
    const instruments: Array<{ '@id': string }> = []
    if (isProducerRun && producerCodeId) instruments.push(reference(producerCodeId))
    if (isProducerRun && connectorToolId) instruments.push(reference(connectorToolId))
    if (environmentId && (isProducerRun || run.environmentName === environment?.environment_name)) {
      instruments.push(reference(environmentId))
    } else {
      instruments.push(reference(kernelId(run.kernelKind)))
    }
    const objectIds = [
      ...new Set(
        run.inputFileVersionKeys
          .map((key) => inputsByVersionId.get(key.inputFileVersionId))
          .filter((input): input is NonNullable<typeof input> => Boolean(input))
          .map(
            (input) =>
              packagedDataPaths.get(input.input_file_version_id) ??
              versionEntityId(input.input_file_version_id)
          )
      )
    ]
    createActionEntities.push({
      '@type': 'CreateAction',
      '@id': `#create-action/${fragment(run.runId)}`,
      name: `Notebook run ${run.runIndex} (${run.kernelKind})`,
      actionStatus: notebookActionStatus(run.status),
      startTime: run.startedAt,
      ...(run.completedAt ? { endTime: run.completedAt } : {}),
      agent: reference(agentId),
      instrument: instruments,
      object: objectIds.map(reference),
      ...(isProducerRun ? { result: [reference(payloadId)] } : {}),
      ...(run.status !== 'completed' ? { description: `Run status: ${run.status}.` } : {}),
      additionalProperty: [
        propertyValue('agentFrameId', run.agentFrameId),
        propertyValue('messageBranchId', run.messageBranchId),
        propertyValue('runtimeSegmentId', run.runtimeSegmentId),
        propertyValue('promptMessageId', run.promptMessageId),
        ...(run.kernelEpochId ? [propertyValue('kernelEpochId', run.kernelEpochId)] : [])
      ]
    })
  }
  if (!runs.length) {
    const instruments: Array<{ '@id': string }> = []
    if (producerCodeId) instruments.push(reference(producerCodeId))
    if (connectorToolId) instruments.push(reference(connectorToolId))
    if (environmentId) instruments.push(reference(environmentId))
    createActionEntities.push({
      '@type': 'CreateAction',
      '@id': '#create-action/publication',
      name: 'Artifact version publication',
      actionStatus:
        evidence.execution_status.state === 'unavailable'
          ? 'FailedActionStatus'
          : 'CompletedActionStatus',
      endTime: evidence.created_at,
      agent: reference(agentId),
      instrument: instruments,
      object: [...evidence.inputs]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((input) =>
          reference(
            packagedDataPaths.get(input.input_file_version_id) ??
              versionEntityId(input.input_file_version_id)
          )
        ),
      result: [reference(payloadId)],
      ...(evidence.execution_status.state === 'unavailable'
        ? {
            description: `Execution evidence is unavailable (${evidence.execution_status.reason}); this action records the publication event only.`
          }
        : {}),
      additionalProperty: [
        propertyValue('rootFrameId', evidence.conversation.root_frame_id),
        propertyValue('agentFrameId', evidence.conversation.agent_frame_id),
        propertyValue('messageBranchId', evidence.conversation.message_branch_id),
        propertyValue('runtimeSegmentId', evidence.conversation.runtime_segment_id),
        propertyValue('promptMessageId', evidence.conversation.prompt_message_id)
      ]
    })
  }

  const computeActionEntities: RoCrateEntity[] = (evidence.compute_executions ?? []).map(
    (compute) => ({
      '@type': 'CreateAction',
      '@id': `#create-action/compute/${fragment(compute.activity_id)}`,
      name: `Compute job ${compute.shape}`,
      actionStatus: computeActionStatus(compute.status),
      description: `Remote compute execution on provider ${compute.provider_id} (status: ${compute.status}).`
    })
  )

  const review = source.review
  let reviewerEntity: RoCrateEntity | undefined
  let assessActionEntity: RoCrateEntity | undefined
  const checkEntities: RoCrateEntity[] = []
  if (review) {
    const assessment = review.selectedVersionAssessment
    const reviewerId = `#reviewer/${fragment(assessment.model)}`
    reviewerEntity = {
      '@type': 'SoftwareAgent',
      '@id': reviewerId,
      name: assessment.model,
      description: 'Automated reviewer model that assessed this Artifact Version.'
    }
    const checkIds = review.selectedVersionChecks.map(
      (check) => `#review-check/${fragment(check.id)}`
    )
    assessActionEntity = {
      '@type': 'AssessAction',
      '@id': `#review/${fragment(assessment.id)}`,
      name: 'Artifact version review',
      actionStatus: reviewActionStatus(assessment.lifecycle),
      startTime: isoFromEpochMs(assessment.createdAt),
      endTime: isoFromEpochMs(assessment.updatedAt),
      agent: reference(reviewerId),
      object: [reference(payloadId)],
      result: checkIds.map(reference),
      description:
        assessment.outcome !== null
          ? `Review outcome: ${assessment.outcome}.`
          : (assessment.errorMessage ?? 'Review did not record an outcome.')
    }
    checkEntities.push(
      ...review.selectedVersionChecks.map((check, index): RoCrateEntity => ({
        '@type': 'Review',
        '@id': checkIds[index]!,
        itemReviewed: reference(payloadId),
        reviewBody: `${check.status}: ${check.claim}\n\nEvidence: ${check.evidence}`,
        additionalProperty: [
          propertyValue('status', check.status),
          propertyValue('resolution', check.resolution)
        ]
      }))
    )
  }

  const sidecarEntities: RoCrateEntity[] = [...sidecars].map(([path, content]) => ({
    '@type': 'File',
    '@id': path,
    name: path,
    encodingFormat: 'application/json',
    contentSize: String(Buffer.byteLength(content, 'utf8')),
    sha256: sha256(content),
    description: 'Verbatim Open Science provenance record retained alongside the RO-Crate metadata.'
  }))

  const producerCodeEntity: RoCrateEntity | undefined =
    notebookProducer && evidence.reproduction_code && producerCodeId
      ? {
          '@type': 'SoftwareSourceCode',
          '@id': producerCodeId,
          name: `Producer code for ${evidence.filename} (v${evidence.version_number})`,
          programmingLanguage: notebookProducer.kernel_kind,
          text: evidence.reproduction_code,
          description:
            'Terminal producer-run script captured at publication time. The complete multi-run execution history is retained in the provenance sidecars.'
        }
      : undefined
  const connectorToolEntity: RoCrateEntity | undefined = connectorProducer
    ? {
        '@type': 'SoftwareApplication',
        '@id': connectorToolId!,
        name: `Connector tool ${connectorProducer.tool_id}`,
        softwareVersion: connectorProducer.implementation_version,
        description: `App-owned Connector handler (connector ${connectorProducer.connector_id}, invocation ${connectorProducer.invocation_id}).`
      }
    : undefined
  const environmentEntity: RoCrateEntity | undefined = environment
    ? {
        '@type': 'SoftwareApplication',
        '@id': '#environment',
        name: environment.environment_name,
        applicationCategory: 'Notebook execution environment',
        ...(environment.runtime_version ? { softwareVersion: environment.runtime_version } : {}),
        ...(environment.platform ? { operatingSystem: environment.platform } : {}),
        ...(environment.architecture ? { processorRequirements: environment.architecture } : {}),
        ...(packageIds.length ? { softwareRequirements: packageIds.map(reference) } : {}),
        additionalProperty: [
          propertyValue('kernelKind', environment.kernel_kind),
          propertyValue('captureStatus', environment.capture_status),
          propertyValue('capturedAt', environment.captured_at)
        ],
        description:
          'Immutable environment inventory observed at production time. This is an audit record, not a solver lockfile; it does not capture every external runtime, system library, or package source, and cannot by itself recreate the environment.'
      }
    : undefined
  const packageEntities: RoCrateEntity[] = environment
    ? environment.packages
        .filter(
          (pkg, index, packages) =>
            packages.findIndex(
              (candidate) =>
                fragment(candidate.ecosystem) === fragment(pkg.ecosystem) &&
                fragment(candidate.name) === fragment(pkg.name)
            ) === index
        )
        .map((pkg) => ({
          '@type': 'SoftwareApplication',
          '@id': `#package/${fragment(pkg.ecosystem)}/${fragment(pkg.name)}`,
          name: pkg.name,
          ...(pkg.version ? { softwareVersion: pkg.version } : {}),
          additionalProperty: [
            propertyValue('ecosystem', pkg.ecosystem),
            propertyValue('loadedState', pkg.loaded_state)
          ]
        }))
    : []

  const rootEntity: RoCrateEntity = {
    '@type': 'Dataset',
    '@id': './',
    name: `${evidence.filename} (Artifact Version v${evidence.version_number}) RO-Crate`,
    // This crate describes the immutable version's publication, not the export time.
    datePublished: evidence.created_at,
    license: 'License information was not provided. This export grants no additional usage rights.',
    description:
      profile === 'lightweight'
        ? 'Open Science Artifact Version provenance crate (lightweight profile). Serializes the provenance captured for one immutable Artifact Version — checksums, producer code, execution history, exact input references, environment inventory, message-branch context, and reviewer evidence — as RO-Crate 1.1 metadata. Provenance is an audit and traceability record, not a deterministic replay contract. Data payloads and input files are referenced by SHA-256 checksum and are not included.'
        : omittedDataReasons.size
          ? 'Open Science Artifact Version provenance crate (complete profile). Includes every available data file that passed declared size and SHA-256 verification. Some data files could not be included and remain immutable checksum references, so this crate is not fully self-contained. Provenance is an audit and traceability record, not a deterministic replay contract.'
          : 'Open Science Artifact Version provenance crate (complete profile). Includes the Artifact Version payload and exact input file bytes together with their provenance as RO-Crate 1.1 metadata. Provenance is an audit and traceability record, not a deterministic replay contract.',
    mainEntity: reference(payloadId),
    conformsTo: reference(profile === 'complete' ? COMPLETE_PROFILE : LIGHTWEIGHT_PROFILE),
    hasPart: [
      ...new Set([
        ...sidecarEntities.map((entity) => entity['@id']),
        payloadId,
        ...inputEntities.map((entity) => entity['@id'])
      ])
    ].map(reference),
    ...(contextualIds.length ? { mentions: contextualIds.map(reference) } : {})
  }

  const metadataDescriptor: RoCrateEntity = {
    '@type': 'CreativeWork',
    '@id': 'ro-crate-metadata.json',
    about: reference('./'),
    conformsTo: reference(RO_CRATE_SPECIFICATION)
  }

  add(metadataDescriptor)
  add(rootEntity)
  for (const entity of sidecarEntities) add(entity)
  add(payloadFile)
  for (const entity of inputEntities) add(entity)
  add(agentEntity, true)
  if (producerCodeEntity) add(producerCodeEntity, true)
  if (connectorToolEntity) add(connectorToolEntity, true)
  if (environmentEntity) add(environmentEntity, true)
  for (const entity of packageEntities) add(entity)
  for (const id of kernelIds.values()) {
    add(
      {
        '@type': 'SoftwareApplication',
        '@id': id,
        name: `${id.replace('#kernel/', '')} kernel`,
        applicationCategory: 'Notebook kernel'
      },
      true
    )
  }
  for (const entity of createActionEntities) add(entity, true)
  for (const entity of computeActionEntities) add(entity, true)
  if (reviewerEntity) add(reviewerEntity, true)
  if (assessActionEntity) add(assessActionEntity, true)
  for (const entity of checkEntities) add(entity, true)

  return { '@context': RO_CRATE_CONTEXT, '@graph': graph }
}

const buildArtifactVersionRoCrateArchive = (source: ArtifactVersionRoCrateSource): Uint8Array => {
  const sidecars = provenanceSidecars(source)
  const metadata = buildArtifactVersionRoCrateMetadata(source, sidecars)
  const entries: Zippable = {
    'ro-crate-metadata.json': [strToU8(serializeRoCrateMetadata(metadata)), { mtime: ZIP_MTIME }],
    ...Object.fromEntries(
      [...sidecars].map(([path, content]) => [path, [strToU8(content), { mtime: ZIP_MTIME }]])
    )
  }
  return zipSync(entries, { level: 6 })
}

const buildArtifactVersionCompleteRoCrateArchive = async (
  source: ArtifactVersionRoCrateSource,
  readers: ArtifactVersionRoCrateContentReaders
): Promise<Uint8Array> => {
  const sidecars = provenanceSidecars(source)
  const packagedDataPaths = new Map<string, string>()
  const omittedDataReasons = new Map<string, string>()
  const dataEntries = new Map<string, Uint8Array>()
  const archivedChecksums = new Map<string, string>()
  const pathChecksums = new Map<string, string>()

  const include = async (
    versionId: string,
    filename: string,
    size: number,
    checksum: string,
    read: () => Promise<Uint8Array | undefined>
  ): Promise<void> => {
    const archivedPath = archivedChecksums.get(checksum)
    if (archivedPath) {
      packagedDataPaths.set(versionId, archivedPath)
      return
    }
    const bytes = await read()
    if (!bytes) {
      omittedDataReasons.set(versionId, 'could not be read from the source installation')
      return
    }
    if (bytes.byteLength !== size) {
      omittedDataReasons.set(versionId, 'failed size verification')
      return
    }
    if (sha256(Buffer.from(bytes)) !== checksum) {
      omittedDataReasons.set(versionId, 'failed checksum verification')
      return
    }
    const path = `data/${outputFilename(filename)}`
    // Reject collisions on case-insensitive and Unicode-normalizing filesystems too.
    const portablePath = path.normalize('NFD').toLowerCase()
    const existingChecksum = pathChecksums.get(portablePath)
    if (existingChecksum && existingChecksum !== checksum) {
      throw new Error(`RO-Crate archive path conflicts: ${path}`)
    }
    dataEntries.set(path, bytes)
    pathChecksums.set(portablePath, checksum)
    archivedChecksums.set(checksum, path)
    packagedDataPaths.set(versionId, path)
  }

  if (source.contentStatus.state === 'available') {
    await include(
      source.evidence.version_id,
      source.evidence.filename,
      source.evidence.size_bytes,
      source.evidence.checksum,
      () => readers.readVersionContent(source.evidence.version_id)
    )
  } else {
    omittedDataReasons.set(
      source.evidence.version_id,
      `are currently unavailable (${source.contentStatus.reason}) from the source installation`
    )
  }
  for (const input of [...source.evidence.inputs].sort(
    (left, right) => left.ordinal - right.ordinal
  )) {
    await include(
      input.input_file_version_id,
      input.filename,
      input.size_bytes,
      input.checksum,
      () => readers.readInputContent(input)
    )
  }

  const metadata = buildArtifactVersionRoCrateMetadata(source, sidecars, {
    profile: 'complete',
    packagedDataPaths,
    omittedDataReasons
  })
  const entries: Zippable = {
    'ro-crate-metadata.json': [strToU8(serializeRoCrateMetadata(metadata)), { mtime: ZIP_MTIME }],
    ...Object.fromEntries(
      [...sidecars].map(([path, content]) => [path, [strToU8(content), { mtime: ZIP_MTIME }]])
    ),
    ...Object.fromEntries(
      [...dataEntries].map(([path, bytes]) => [path, [bytes, { mtime: ZIP_MTIME, level: 0 }]])
    )
  }
  return zipSync(entries, { level: 6 })
}

export {
  buildArtifactVersionCompleteRoCrateArchive,
  buildArtifactVersionRoCrateArchive,
  buildArtifactVersionRoCrateMetadata,
  serializeRoCrateMetadata,
  COMPLETE_PROFILE,
  LIGHTWEIGHT_PROFILE,
  RO_CRATE_CONTEXT,
  RO_CRATE_SPECIFICATION
}
export type {
  ArtifactVersionRoCrateContentReaders,
  ArtifactVersionRoCrateSource,
  RoCrateEntity,
  RoCrateMetadataDocument
}
