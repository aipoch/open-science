import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { Prisma } from '@prisma/client'

import type {
  AppGeneratedArtifactProducer,
  ArtifactConnectorArgumentValue,
  ArtifactProducerUnavailableReason,
  ArtifactVersionEvidence,
  CreateArtifactVersionRequest
} from '../../shared/artifact-provenance'
import type {
  NotebookEnvironmentManifest,
  NotebookRunEnvironmentCapture,
  NotebookRunInputFile,
  NotebookRunRecord
} from '../../shared/notebook'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import { NotebookRunRepository } from '../notebook/repository'
import {
  canonicalJson,
  isCanonicalJsonValue,
  sha256,
  type CanonicalJson
} from './provenance-canonical'
import {
  buildBoundedExecutionSnapshot,
  environmentEvidence,
  inputEvidence,
  resolveRunEnvironmentCapture
} from './provenance-execution-evidence'

const CONNECTOR_ARGUMENTS_MAX_BYTES = 64 * 1024
const CONNECTOR_IDENTITY_MAX_LENGTH = 256

const isConnectorProducerEvidence = (
  producer: ArtifactVersionEvidence['producer']
): producer is Extract<ArtifactVersionEvidence['producer'], { kind: 'connector' }> =>
  producer.state === 'available' && 'kind' in producer && producer.kind === 'connector'

const prepareConnectorExecution = (
  producer: AppGeneratedArtifactProducer
): {
  normalizedArguments: { [key: string]: ArtifactConnectorArgumentValue }
  argumentsChecksum: string
} => {
  const identities = [
    ['id', producer.connectorId],
    ['tool id', producer.toolId],
    ['invocation id', producer.invocationId],
    ['implementation version', producer.implementationVersion]
  ] as const
  for (const [label, value] of identities) {
    if (
      value.length === 0 ||
      value.length > CONNECTOR_IDENTITY_MAX_LENGTH ||
      Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 0x1f || codePoint === 0x7f
      })
    ) {
      throw new Error(`Invalid Connector ${label}.`)
    }
  }
  if (!isCanonicalJsonValue(producer.normalizedArguments)) {
    throw new Error('Connector normalized arguments must be finite canonical JSON values.')
  }
  const serialized = canonicalJson(producer.normalizedArguments as CanonicalJson)
  if (Buffer.byteLength(serialized, 'utf8') > CONNECTOR_ARGUMENTS_MAX_BYTES) {
    throw new Error('Connector normalized arguments exceed the provenance evidence limit.')
  }
  return {
    normalizedArguments: JSON.parse(serialized) as {
      [key: string]: ArtifactConnectorArgumentValue
    },
    argumentsChecksum: sha256(serialized)
  }
}

const connectorEvidenceIsValid = (evidence: ArtifactVersionEvidence): boolean => {
  const producer = evidence.producer
  const execution = evidence.connector_execution
  if (
    !isConnectorProducerEvidence(producer) ||
    !execution ||
    execution.schema_version !== 1 ||
    !isCanonicalJsonValue(execution.normalized_arguments)
  ) {
    return false
  }
  const serialized = canonicalJson(execution.normalized_arguments as CanonicalJson)
  return (
    Buffer.byteLength(serialized, 'utf8') <= CONNECTOR_ARGUMENTS_MAX_BYTES &&
    sha256(serialized) === execution.arguments_checksum &&
    execution.arguments_checksum === producer.arguments_checksum
  )
}

type ArtifactVersionProducerCapture =
  | {
      state: 'unavailable'
      reason: ArtifactProducerUnavailableReason
    }
  | {
      state: 'available'
      kind: 'notebook'
      notebookSessionId: string
      producerRunId: string
      producerRunIndex: number
      associationMethod: 'agent-declared-and-session-validated' | 'server-inferred-file-observation'
      kernelKind: NotebookRunRecord['kernelKind']
      environmentName?: string
      reproductionCode: string
      executionJson: string
      executionChecksum: string
      inputFiles: NotebookRunInputFile[]
      environmentCapture: NotebookRunEnvironmentCapture
      environmentManifest?: NotebookEnvironmentManifest
      environmentManifestChecksum?: string
    }
  | {
      state: 'available'
      kind: 'connector'
      connectorId: string
      toolId: string
      invocationId: string
      implementationVersion: string
      normalizedArguments: AppGeneratedArtifactProducer['normalizedArguments']
      argumentsChecksum: string
      inputFiles: NotebookRunInputFile[]
    }

type PreparedArtifactVersionPersistence = {
  notebookSessionId?: string
  producerRunId?: string
  producerRunIndex?: number
  evidenceJson: string
  evidenceChecksum: string
  executionSnapshotJson?: string
  executionSnapshotChecksum?: string
  inputs?: Prisma.ArtifactVersionUncheckedCreateInput['inputs']
}

type ArtifactProvenanceProducerCaptureOptions = {
  inputAuthority: Pick<ImmutableInputAuthority, 'validateVersion'>
  notebookRepository: Pick<NotebookRunRepository, 'readSessionDocuments'>
  createId: () => string
}

type PrepareVersionPersistenceInput = {
  request: CreateArtifactVersionRequest
  producer: ArtifactVersionProducerCapture
  artifactId: string
  versionId: string
  versionNumber: number
  checksum: string
  sizeBytes: number
  createdAt: Date
}

type ProducerScope = {
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
}

class ArtifactProvenanceProducerCapture {
  constructor(private readonly options: ArtifactProvenanceProducerCaptureOptions) {}

  async captureProducer(
    request: CreateArtifactVersionRequest,
    createdAt: Date,
    artifactChecksum: string,
    appGeneratedProducer?: AppGeneratedArtifactProducer
  ): Promise<ArtifactVersionProducerCapture> {
    if (appGeneratedProducer) {
      const execution = prepareConnectorExecution(appGeneratedProducer)
      const inputFiles = appGeneratedProducer.inputFiles ?? []
      await this.validateInputReferences(request.projectId, inputFiles, 'Connector')
      return {
        state: 'available',
        kind: 'connector',
        connectorId: appGeneratedProducer.connectorId,
        toolId: appGeneratedProducer.toolId,
        invocationId: appGeneratedProducer.invocationId,
        implementationVersion: appGeneratedProducer.implementationVersion,
        normalizedArguments: execution.normalizedArguments,
        argumentsChecksum: execution.argumentsChecksum,
        inputFiles
      }
    }
    // Local files require an app-side observation before an Agent-declared run may become evidence.
    // Inline bytes have no file observation, so they retain the declared run only after the durable
    // Notebook Session and graph-scope checks below succeed.
    if (
      request.producerRunId &&
      !request.sourceFileObservation &&
      request.sourceKind !== 'inline'
    ) {
      return { state: 'unavailable', reason: 'producer-source-unverifiable' }
    }
    if (request.producerRunId && !request.notebookSessionId) {
      throw new Error('producerRunId requires notebookSessionId in the active Artifact run.')
    }
    if (!request.notebookSessionId) {
      return { state: 'unavailable', reason: 'producer-not-supplied' }
    }
    if (!request.producerRunId && !request.sourceFileObservation) {
      return { state: 'unavailable', reason: 'producer-not-supplied' }
    }

    const documents = await this.options.notebookRepository.readSessionDocuments(
      request.projectId,
      request.notebookSessionId
    )
    const document =
      (request.producerRunId
        ? documents.find((candidate) =>
            candidate.runs.some((run) => run.runId === request.producerRunId)
          )
        : documents.find((candidate) =>
            candidate.runs.some((run) => run.agentFrameId === request.agentFrameId)
          )) ??
      documents[0] ??
      null
    const sourceFileObservation = request.sourceFileObservation
      ? await this.verifySourceFileObservation(
          document,
          request.sourceFileObservation,
          artifactChecksum
        )
      : undefined
    if (request.sourceFileObservation && !sourceFileObservation) {
      return { state: 'unavailable', reason: 'producer-source-unverifiable' }
    }
    const expected = {
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      messageBranchId: request.messageBranchId,
      runtimeSegmentId: request.runtimeSegmentId,
      promptMessageId: request.promptMessageId
    }
    const inferredProducerRunId = request.producerRunId
      ? undefined
      : await this.inferProducerRunId(document, sourceFileObservation, expected)
    const producerRunId = request.producerRunId ?? inferredProducerRunId
    if (!producerRunId) {
      return {
        state: 'unavailable',
        reason: request.sourceFileObservation
          ? 'producer-source-unverifiable'
          : 'producer-not-supplied'
      }
    }
    const producerRunIndex = document?.runs.findIndex((run) => run.runId === producerRunId) ?? -1
    const producerRun = document?.runs[producerRunIndex]

    if (!document || !producerRun || producerRunIndex < 0) {
      throw new Error(`Notebook producer run not found: ${producerRunId}`)
    }
    for (const [field, value] of Object.entries(expected)) {
      if (producerRun[field as keyof typeof expected] !== value) {
        if (field === 'agentFrameId') {
          throw new Error(
            'Notebook producer run belongs to a different agent frame. Have the producing agent publish it directly, or reference an already completed Artifact Version.'
          )
        }
        throw new Error(
          `Notebook producer run does not belong to the active Artifact ${field}: ${producerRunId}`
        )
      }
    }
    if (request.producerRunId && sourceFileObservation) {
      const observedOwners = await this.findObservedWorkingFileRunIds(
        document,
        sourceFileObservation,
        expected
      )
      if (observedOwners.length > 0 && !observedOwners.includes(request.producerRunId)) {
        throw new Error(
          `Declared producer source belongs to another Notebook run: ${observedOwners.join(', ')}`
        )
      }
      if (observedOwners.length !== 1) {
        return { state: 'unavailable', reason: 'producer-source-unverifiable' }
      }
    }

    const eligibleBranchIds = new Set(
      request.messageBranchAncestry?.length
        ? request.messageBranchAncestry
        : [request.messageBranchId]
    )
    if (!eligibleBranchIds.has(request.messageBranchId)) {
      throw new Error('Artifact Branch ancestry does not contain the active Branch.')
    }
    const eligibleMessageIds = request.messageAncestry?.length
      ? new Set(request.messageAncestry)
      : undefined
    if (eligibleMessageIds && !eligibleMessageIds.has(request.promptMessageId)) {
      throw new Error('Artifact Message ancestry does not contain the producer prompt.')
    }
    const eligibleRuns = document.runs
      .slice(0, producerRunIndex + 1)
      .map((run, runIndex) => ({ run, runIndex }))
      .filter(
        ({ run }) =>
          run.agentFrameId === request.agentFrameId &&
          !!run.messageBranchId &&
          eligibleBranchIds.has(run.messageBranchId) &&
          (eligibleMessageIds
            ? run.promptMessageId
              ? eligibleMessageIds.has(run.promptMessageId)
              : run.messageBranchId === request.messageBranchId
            : true)
      )
    const executionSnapshot = buildBoundedExecutionSnapshot(
      {
        schemaVersion: 2,
        rootFrameId: request.rootFrameId,
        agentFrameId: request.agentFrameId,
        messageBranchId: request.messageBranchId,
        terminalPromptMessageId: request.promptMessageId,
        producerRunId,
        producerRunIndex,
        createdAt: createdAt.toISOString()
      },
      eligibleRuns
    )
    const inputFiles = executionSnapshot.inputFiles
    await this.validateInputReferences(request.projectId, inputFiles)
    const executionJson = canonicalJson(executionSnapshot as unknown as CanonicalJson)
    const environment = resolveRunEnvironmentCapture(producerRun)

    return {
      state: 'available',
      kind: 'notebook',
      notebookSessionId: request.notebookSessionId,
      producerRunId,
      producerRunIndex,
      associationMethod: request.producerRunId
        ? 'agent-declared-and-session-validated'
        : 'server-inferred-file-observation',
      kernelKind: producerRun.kernelKind,
      environmentName: producerRun.environment,
      reproductionCode: producerRun.script,
      executionJson,
      executionChecksum: sha256(executionJson),
      inputFiles,
      environmentCapture: environment.capture,
      ...(environment.manifest && environment.checksum
        ? {
            environmentManifest: environment.manifest,
            environmentManifestChecksum: environment.checksum
          }
        : {})
    }
  }

  prepareVersionPersistence({
    request,
    producer,
    artifactId,
    versionId,
    versionNumber,
    checksum,
    sizeBytes,
    createdAt
  }: PrepareVersionPersistenceInput): PreparedArtifactVersionPersistence {
    const notebookProducer = producer.state === 'available' && producer.kind === 'notebook'
    const connectorProducer = producer.state === 'available' && producer.kind === 'connector'
    const producerInputs = producer.state === 'available' ? producer.inputFiles : []
    const evidence: ArtifactVersionEvidence = {
      app_session_id: request.appSessionId,
      artifact_id: artifactId,
      checksum,
      ...(request.contentType ? { content_type: request.contentType } : {}),
      conversation: {
        agent_frame_id: request.agentFrameId,
        message_branch_id: request.messageBranchId,
        prompt_message_id: request.promptMessageId,
        root_frame_id: request.rootFrameId,
        runtime_segment_id: request.runtimeSegmentId
      },
      created_at: createdAt.toISOString(),
      environment_status:
        producer.state !== 'available'
          ? { reason: producer.reason, state: 'unavailable' }
          : connectorProducer
            ? { reason: 'environment-not-supported', state: 'unavailable' }
            : producer.environmentCapture.state === 'unavailable'
              ? { reason: producer.environmentCapture.reason, state: 'unavailable' }
              : { state: producer.environmentCapture.state },
      ...(notebookProducer && producer.environmentManifest && producer.environmentManifestChecksum
        ? {
            environment: environmentEvidence(
              producer.environmentManifest,
              producer.environmentManifestChecksum
            )
          }
        : {}),
      execution_status:
        producer.state !== 'available'
          ? { reason: producer.reason, state: 'unavailable' }
          : connectorProducer
            ? { state: 'partial' }
            : { state: 'available' },
      ...(producer.state === 'available'
        ? notebookProducer
          ? {
              execution_snapshot_checksum: producer.executionChecksum,
              reproduction_code: producer.reproductionCode
            }
          : {
              connector_execution: {
                schema_version: 1,
                normalized_arguments: producer.normalizedArguments,
                arguments_checksum: producer.argumentsChecksum
              }
            }
        : {}),
      filename: request.filename,
      inputs: producerInputs.map((input, ordinal) => inputEvidence(input, ordinal)),
      is_user_upload: false,
      ...(request.agentName ? { agent_name: request.agentName } : {}),
      producer:
        producer.state === 'unavailable'
          ? { reason: producer.reason, state: 'unavailable' }
          : producer.kind === 'notebook'
            ? {
                association_method: producer.associationMethod,
                kernel_kind: producer.kernelKind,
                notebook_session_id: producer.notebookSessionId,
                producer_run_id: producer.producerRunId,
                run_index: producer.producerRunIndex,
                ...(producer.environmentCapture.state !== 'unavailable'
                  ? {
                      environment_manifest_checksum: producer.environmentCapture.manifestChecksum
                    }
                  : {}),
                state: 'available'
              }
            : {
                state: 'available',
                kind: 'connector',
                connector_id: producer.connectorId,
                tool_id: producer.toolId,
                invocation_id: producer.invocationId,
                implementation_version: producer.implementationVersion,
                arguments_checksum: producer.argumentsChecksum,
                association_method: 'app-owned-handler'
              },
      project_id: request.projectId,
      schema_version: 1,
      size_bytes: sizeBytes,
      version_id: versionId,
      version_number: versionNumber
    }
    const evidenceJson = canonicalJson(evidence as unknown as CanonicalJson)
    return {
      notebookSessionId: notebookProducer ? producer.notebookSessionId : undefined,
      producerRunId: notebookProducer ? producer.producerRunId : undefined,
      producerRunIndex: notebookProducer ? producer.producerRunIndex : undefined,
      evidenceJson,
      evidenceChecksum: sha256(evidenceJson),
      executionSnapshotJson: notebookProducer ? producer.executionJson : undefined,
      executionSnapshotChecksum: notebookProducer ? producer.executionChecksum : undefined,
      ...(producerInputs.length > 0
        ? {
            inputs: {
              create: producerInputs.map((input, ordinal) => ({
                id: this.options.createId(),
                ordinal,
                inputFileVersionId: input.inputFileVersionId,
                sourceKind: input.sourceKind,
                sourceFileId: input.sourceFileId,
                ...(input.sourceKind === 'artifact-version'
                  ? { sourceArtifactVersionId: input.inputFileVersionId }
                  : { sourceUploadVersionId: input.inputFileVersionId }),
                sourceVersionNumber: input.sourceVersionNumber,
                sourceCreatedAt: input.sourceCreatedAt
                  ? new Date(input.sourceCreatedAt)
                  : undefined,
                sourceProjectId: input.sourceProjectId,
                sourceSessionId: input.sourceSessionId,
                filename: input.filename,
                contentType: input.contentType,
                sizeBytes: BigInt(input.sizeBytes),
                checksum: input.checksum,
                storageKey: input.storageKey,
                strongestAssociation: input.association
              }))
            }
          }
        : {})
    }
  }

  private async inferProducerRunId(
    document: Awaited<ReturnType<NotebookRunRepository['findExisting']>>,
    observation: CreateArtifactVersionRequest['sourceFileObservation'],
    expected: ProducerScope
  ): Promise<string | undefined> {
    if (!document || !observation) return undefined
    const matches = await this.findObservedWorkingFileRunIds(document, observation, expected)
    return matches.length === 1 ? matches[0] : undefined
  }

  // Treat the RPC observation as an untrusted path hint. Main re-observes the source under the
  // Notebook's durable roots and proves that its bytes are exactly the immutable Artifact content
  // before the hint may participate in producer attribution.
  private async verifySourceFileObservation(
    document: Awaited<ReturnType<NotebookRunRepository['findExisting']>>,
    observation: NonNullable<CreateArtifactVersionRequest['sourceFileObservation']>,
    artifactChecksum: string
  ): Promise<NonNullable<CreateArtifactVersionRequest['sourceFileObservation']> | undefined> {
    if (
      !document ||
      !Number.isFinite(observation.sizeBytes) ||
      observation.sizeBytes < 0 ||
      !Number.isFinite(observation.mtimeMs) ||
      observation.mtimeMs < 0
    ) {
      return undefined
    }

    const observedPath = await realpath(resolve(observation.path)).catch(() => undefined)
    if (!observedPath) return undefined
    const roots = await Promise.all(
      [document.notebookSessionRoot, document.workspaceCwd].map((root) =>
        realpath(resolve(root)).catch(() => resolve(root))
      )
    )
    if (
      !roots.some((root) => {
        const relativePath = relative(root, observedPath)
        return (
          relativePath !== '' &&
          relativePath !== '..' &&
          !relativePath.startsWith(`..${sep}`) &&
          !isAbsolute(relativePath)
        )
      })
    ) {
      return undefined
    }

    const before = await stat(observedPath).catch(() => undefined)
    if (
      !before?.isFile() ||
      before.size !== observation.sizeBytes ||
      before.mtimeMs !== observation.mtimeMs
    ) {
      return undefined
    }
    const bytes = await readFile(observedPath).catch(() => undefined)
    const after = await stat(observedPath).catch(() => undefined)
    if (
      !bytes ||
      !after?.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      sha256(bytes) !== artifactChecksum
    ) {
      return undefined
    }

    return { path: observedPath, sizeBytes: after.size, mtimeMs: after.mtimeMs }
  }

  private async findObservedWorkingFileRunIds(
    document: NonNullable<Awaited<ReturnType<NotebookRunRepository['findExisting']>>>,
    observation: NonNullable<CreateArtifactVersionRequest['sourceFileObservation']>,
    expected: ProducerScope
  ): Promise<string[]> {
    if (
      !Number.isFinite(observation.sizeBytes) ||
      observation.sizeBytes < 0 ||
      !Number.isFinite(observation.mtimeMs) ||
      observation.mtimeMs < 0
    ) {
      return []
    }

    const canonicalPath = async (path: string): Promise<string> =>
      realpath(resolve(path)).catch(() => resolve(path))
    const observedPath = await canonicalPath(observation.path)
    const documentRoots = await Promise.all(
      [document.notebookSessionRoot, document.workspaceCwd].map(canonicalPath)
    )
    const isInsideDocumentRoot = documentRoots.some((root) => {
      const relativePath = relative(root, observedPath)
      return (
        relativePath !== '' &&
        relativePath !== '..' &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath)
      )
    })
    if (!isInsideDocumentRoot) return []

    const candidates = document.runs.filter((run) =>
      Object.entries(expected).every(
        ([field, value]) => run[field as keyof typeof expected] === value
      )
    )
    const workingFileMatches = (
      await Promise.all(
        candidates.map(async (run) => {
          for (const file of run.workingFiles) {
            if (
              (await canonicalPath(file.path)) === observedPath &&
              file.createdByRunId === run.runId &&
              file.size === observation.sizeBytes &&
              file.mtimeMs === observation.mtimeMs
            ) {
              return run.runId
            }
          }
          return undefined
        })
      )
    ).filter((runId): runId is string => runId !== undefined)

    // mtime is diagnostic context, not a causal execution receipt. Only a WorkingFile observation
    // attributed to one run may promote an omitted declaration to available producer evidence.
    return [...new Set(workingFileMatches)]
  }

  private async validateInputReferences(
    projectId: string,
    inputs: NotebookRunInputFile[],
    producerLabel = 'Notebook'
  ): Promise<void> {
    for (const input of inputs) {
      const validation = await this.options.inputAuthority.validateVersion(projectId, input)
      if (validation.state === 'project-mismatch') {
        throw new Error(
          `${producerLabel} input belongs to another Project: ${input.inputFileVersionId}`
        )
      }
      if (validation.state !== 'available') {
        const label = input.sourceKind === 'upload-version' ? 'Upload' : 'Artifact'
        throw new Error(
          `${producerLabel} ${label} input identity is corrupt: ${input.inputFileVersionId}`
        )
      }
    }
  }
}

export { ArtifactProvenanceProducerCapture, connectorEvidenceIsValid, isConnectorProducerEvidence }
export type { ArtifactVersionProducerCapture, PreparedArtifactVersionPersistence }
