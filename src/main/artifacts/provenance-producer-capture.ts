import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { Prisma } from '@prisma/client'

import type {
  AppGeneratedArtifactProducer,
  ArtifactConnectorArgumentValue,
  ArtifactComputeExecutionEvidence,
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
import { getNotebookSessionRoot, NotebookRunRepository } from '../notebook/repository'
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
      computeExecutions: ArtifactComputeExecutionEvidence[]
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
  storageRoot: string
  createId: () => string
  computeJobReader?: {
    findByProducer(
      projectId: string,
      sessionId: string,
      producerRunId: string
    ): Promise<ArtifactComputeExecutionEvidence[]>
  }
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
  activeRuntimeSegmentId: string
  activePromptMessageId: string
  eligibleBranchIds: ReadonlySet<string>
  eligibleMessageIds: ReadonlySet<string>
}

type SourceFileObservation = NonNullable<CreateArtifactVersionRequest['sourceFileObservation']>
type SourceFileObservationAssessment = {
  notebookSessionOwned: boolean
  verified?: SourceFileObservation
}

const isStrictDescendant = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested)
}

const canonicalPath = async (path: string): Promise<string> =>
  realpath(resolve(path)).catch(() => resolve(path))
const producerScopeMismatch = (
  run: NotebookRunRecord,
  scope: ProducerScope
): keyof NotebookRunRecord | null => {
  if (run.rootFrameId !== scope.rootFrameId) return 'rootFrameId'
  if (run.agentFrameId !== scope.agentFrameId) return 'agentFrameId'
  if (!run.messageBranchId || !scope.eligibleBranchIds.has(run.messageBranchId))
    return 'messageBranchId'
  if (!run.promptMessageId || !scope.eligibleMessageIds.has(run.promptMessageId))
    return 'promptMessageId'
  return run.promptMessageId === scope.activePromptMessageId &&
    run.runtimeSegmentId !== scope.activeRuntimeSegmentId
    ? 'runtimeSegmentId'
    : null
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
    if (request.producerRunId && !request.notebookSessionId) {
      throw new Error('producerRunId requires notebookSessionId in the active Artifact run.')
    }
    // Agent-declared local files require an app observation; inline bytes use the durable checks below.
    if (
      request.producerRunId &&
      !request.sourceFileObservation &&
      request.sourceKind !== 'inline'
    ) {
      throw new Error(`Notebook producer source observation is required: ${request.producerRunId}`)
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
    const sourceFileAssessment = request.sourceFileObservation
      ? await this.assessSourceFileObservation(
          document,
          request.sourceFileObservation,
          artifactChecksum,
          getNotebookSessionRoot(
            this.options.storageRoot,
            request.projectId,
            request.notebookSessionId
          )
        )
      : undefined
    const sourceFileObservation = sourceFileAssessment?.verified
    if (request.sourceFileObservation && !sourceFileObservation) {
      if (request.producerRunId) {
        throw new Error(`Notebook producer source could not be verified: ${request.producerRunId}`)
      }
      if (sourceFileAssessment?.notebookSessionOwned) {
        throw new Error('Notebook source observation could not be verified.')
      }
      return { state: 'unavailable', reason: 'producer-source-unverifiable' }
    }
    const eligibleBranchIds = new Set(
      request.messageBranchAncestry?.length
        ? request.messageBranchAncestry
        : [request.messageBranchId]
    )
    if (!eligibleBranchIds.has(request.messageBranchId)) {
      throw new Error('Artifact Branch ancestry does not contain the active Branch.')
    }
    const eligibleMessageIds = new Set(
      request.messageAncestry?.length ? request.messageAncestry : [request.promptMessageId]
    )
    if (!eligibleMessageIds.has(request.promptMessageId)) {
      throw new Error('Artifact Message ancestry does not contain the producer prompt.')
    }
    const scope: ProducerScope = {
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      activeRuntimeSegmentId: request.runtimeSegmentId,
      activePromptMessageId: request.promptMessageId,
      eligibleBranchIds,
      eligibleMessageIds
    }
    const inferredProducerRunId = request.producerRunId
      ? undefined
      : await this.inferProducerRunId(document, sourceFileObservation, scope)
    const producerRunId = request.producerRunId ?? inferredProducerRunId
    if (!producerRunId) {
      if (sourceFileAssessment?.notebookSessionOwned) {
        throw new Error('Notebook source must have exactly one eligible Run owner.')
      }
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
    const scopeMismatch = producerScopeMismatch(producerRun, scope)
    if (scopeMismatch) {
      if (scopeMismatch === 'agentFrameId') {
        throw new Error(
          'Notebook producer run belongs to a different agent frame. Have the producing agent publish it directly, or reference an already completed Artifact Version.'
        )
      }
      throw new Error(
        `Notebook producer run does not belong to the active Artifact ${scopeMismatch}: ${producerRunId}`
      )
    }
    if (request.producerRunId && sourceFileObservation) {
      const observedOwners = await this.findObservedWorkingFileRunIds(
        document,
        sourceFileObservation,
        scope
      )
      if (observedOwners.length > 0 && !observedOwners.includes(request.producerRunId)) {
        throw new Error(
          `Declared producer source belongs to another Notebook run: ${observedOwners.join(', ')}`
        )
      }
      if (observedOwners.length !== 1) {
        throw new Error(`Producer source must have exactly one Run owner: ${request.producerRunId}`)
      }
    }

    const eligibleRuns = document.runs
      .slice(0, producerRunIndex + 1)
      .map((run, runIndex) => ({ run, runIndex }))
      .filter(({ run }) => producerScopeMismatch(run, scope) === null)
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
    const computeExecutions =
      (await this.options.computeJobReader?.findByProducer(
        request.projectId,
        request.notebookSessionId,
        producerRunId
      )) ?? []

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
      computeExecutions: computeExecutions.slice(0, 100),
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
      ...(notebookProducer && producer.computeExecutions.length > 0
        ? { compute_executions: producer.computeExecutions }
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
    scope: ProducerScope
  ): Promise<string | undefined> {
    if (!document || !observation) return undefined
    const matches = await this.findObservedWorkingFileRunIds(document, observation, scope)
    return matches.length === 1 ? matches[0] : undefined
  }

  // Main re-observes the untrusted RPC path under durable roots and proves its bytes match the
  // immutable Artifact content before the hint participates in producer attribution.
  private async assessSourceFileObservation(
    document: Awaited<ReturnType<NotebookRunRepository['findExisting']>>,
    observation: SourceFileObservation,
    artifactChecksum: string,
    notebookSessionRoot: string
  ): Promise<SourceFileObservationAssessment> {
    const observedPath = await canonicalPath(observation.path)
    const rootPaths = [notebookSessionRoot, ...(document ? [document.workspaceCwd] : [])]
    const roots = await Promise.all(rootPaths.map(canonicalPath))
    const assessment = { notebookSessionOwned: isStrictDescendant(roots[0], observedPath) }
    if (
      !Number.isFinite(observation.sizeBytes) ||
      observation.sizeBytes < 0 ||
      !Number.isFinite(observation.mtimeMs) ||
      observation.mtimeMs < 0
    ) {
      return assessment
    }
    if (!roots.some((root) => isStrictDescendant(root, observedPath))) {
      return assessment
    }
    const before = await stat(observedPath).catch(() => undefined)
    if (
      !before?.isFile() ||
      before.size !== observation.sizeBytes ||
      before.mtimeMs !== observation.mtimeMs
    ) {
      return assessment
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
      return assessment
    }
    return {
      ...assessment,
      verified: { path: observedPath, sizeBytes: after.size, mtimeMs: after.mtimeMs }
    }
  }

  private async findObservedWorkingFileRunIds(
    document: NonNullable<Awaited<ReturnType<NotebookRunRepository['findExisting']>>>,
    observation: SourceFileObservation,
    scope: ProducerScope
  ): Promise<string[]> {
    if (
      !Number.isFinite(observation.sizeBytes) ||
      observation.sizeBytes < 0 ||
      !Number.isFinite(observation.mtimeMs) ||
      observation.mtimeMs < 0
    ) {
      return []
    }

    const observedPath = await canonicalPath(observation.path)
    const documentRoots = await Promise.all(
      [document.notebookSessionRoot, document.workspaceCwd].map(canonicalPath)
    )
    const isInsideDocumentRoot = documentRoots.some((root) =>
      isStrictDescendant(root, observedPath)
    )
    if (!isInsideDocumentRoot) return []

    const candidates = document.runs.filter((run) => producerScopeMismatch(run, scope) === null)
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
