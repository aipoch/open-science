import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import { normalizeArtifactFilename as normalizeFilename } from './provenance-version-writer'
import { resolveStorageKey, storageKey } from './provenance-storage'
import { ArtifactCompatibilityScanIncompleteError, type ArtifactRepository } from './repository'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type ArtifactUnindexedRecoveryState = {
  projectId: string
  appSessionId: string
  provenanceRoot: string
  lineageEntries: Dirent[]
}

const artifactUnindexedRecoveryState = Symbol('artifactUnindexedRecoveryState')

type ArtifactUnindexedRecoverySnapshot = {
  readonly [artifactUnindexedRecoveryState]: ArtifactUnindexedRecoveryState
}

type ArtifactUnindexedRecoveryResult = {
  recoveredVersionIds: string[]
  quarantinedVersionIds: string[]
}

type ArtifactProvenanceUnindexedRecoveryOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  compatibilityRepository: Pick<ArtifactRepository, 'findPendingVersionRouting'>
  createId: () => string
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const validRecoveryFilename = (value: string): boolean =>
  value.length > 0 &&
  value !== '.' &&
  value !== '..' &&
  !value.includes('/') &&
  !value.includes('\\')

const assertSafeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

class ArtifactProvenanceUnindexedRecovery {
  constructor(private readonly options: ArtifactProvenanceUnindexedRecoveryOptions) {}

  async prepareSession(
    projectId: string,
    appSessionId: string
  ): Promise<ArtifactUnindexedRecoverySnapshot> {
    const provenanceRoot = resolveStorageKey(
      this.options.storageRoot,
      storageKey('artifacts', projectId, appSessionId, '.provenance')
    )
    const lineageEntries = await readdir(provenanceRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          return []
        }
        throw error
      }
    )
    return {
      [artifactUnindexedRecoveryState]: {
        projectId,
        appSessionId,
        provenanceRoot,
        lineageEntries
      }
    }
  }

  async reconcileSession(
    snapshot: ArtifactUnindexedRecoverySnapshot
  ): Promise<ArtifactUnindexedRecoveryResult> {
    const state = snapshot[artifactUnindexedRecoveryState]
    const result: ArtifactUnindexedRecoveryResult = {
      recoveredVersionIds: [],
      quarantinedVersionIds: []
    }
    const client = await this.options.getClient()
    for (const lineageEntry of state.lineageEntries) {
      if (
        !lineageEntry.isDirectory() ||
        lineageEntry.name === '.staging' ||
        lineageEntry.name === '.quarantine' ||
        !SAFE_SEGMENT_PATTERN.test(lineageEntry.name)
      ) {
        continue
      }
      const versionsRoot = join(state.provenanceRoot, lineageEntry.name, 'versions')
      const versionEntries = await readdir(versionsRoot, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
          ) {
            return []
          }
          throw error
        }
      )
      for (const versionEntry of versionEntries) {
        if (!versionEntry.isDirectory() || !SAFE_SEGMENT_PATTERN.test(versionEntry.name)) continue
        const existing = await client.artifactVersion.findUnique({
          where: { id: versionEntry.name },
          select: { id: true }
        })
        if (existing) continue

        const versionDirectory = join(versionsRoot, versionEntry.name)
        try {
          await this.recoverVersion({
            projectId: state.projectId,
            appSessionId: state.appSessionId,
            artifactId: lineageEntry.name,
            versionId: versionEntry.name,
            versionDirectory
          })
          result.recoveredVersionIds.push(versionEntry.name)
        } catch (error) {
          // Do not turn an unreadable sidecar elsewhere in the Project into evidence that this
          // immutable Version is unowned. An incomplete scan is retryable, not quarantine proof.
          if (error instanceof ArtifactCompatibilityScanIncompleteError) continue
          // A concurrent reconciler may have inserted the same immutable row. Re-check before moving
          // anything; only a still-unowned directory is eligible for quarantine.
          const wonByAnotherWriter = await client.artifactVersion.findUnique({
            where: { id: versionEntry.name },
            select: { id: true }
          })
          if (wonByAnotherWriter) continue
          const quarantineDirectory = join(
            state.provenanceRoot,
            '.quarantine',
            'recovered-unlinked',
            lineageEntry.name,
            `${versionEntry.name}-${this.options.createId()}`
          )
          await mkdir(dirname(quarantineDirectory), { recursive: true })
          await rename(versionDirectory, quarantineDirectory)
          result.quarantinedVersionIds.push(versionEntry.name)
        }
      }
    }
    return result
  }

  private async recoverVersion(input: {
    projectId: string
    appSessionId: string
    artifactId: string
    versionId: string
    versionDirectory: string
  }): Promise<void> {
    const evidenceJson = await readFile(join(input.versionDirectory, 'evidence.json'), 'utf8')
    const evidence = recordValue(JSON.parse(evidenceJson))
    if (!evidence || canonicalJson(evidence as CanonicalJson) !== evidenceJson) {
      throw new Error('Recovered Artifact evidence is not canonical.')
    }
    const filename = stringValue(evidence.filename)
    const versionNumber = numberValue(evidence.version_number)
    const sizeBytes = numberValue(evidence.size_bytes)
    const checksum = stringValue(evidence.checksum)
    const createdAtValue = stringValue(evidence.created_at)
    const conversation = recordValue(evidence.conversation)
    if (
      evidence.schema_version !== 1 ||
      evidence.project_id !== input.projectId ||
      evidence.app_session_id !== input.appSessionId ||
      evidence.artifact_id !== input.artifactId ||
      evidence.version_id !== input.versionId ||
      !filename ||
      !validRecoveryFilename(filename) ||
      !Number.isInteger(versionNumber) ||
      (versionNumber ?? 0) < 1 ||
      !Number.isSafeInteger(sizeBytes) ||
      (sizeBytes ?? -1) < 0 ||
      !checksum ||
      !SHA256_PATTERN.test(checksum) ||
      !createdAtValue ||
      Number.isNaN(Date.parse(createdAtValue)) ||
      !conversation
    ) {
      throw new Error('Recovered Artifact evidence identity is invalid.')
    }
    const rootFrameId = assertSafeSegment(
      stringValue(conversation.root_frame_id) ?? '',
      'root frame id'
    )
    const agentFrameId = assertSafeSegment(
      stringValue(conversation.agent_frame_id) ?? '',
      'agent frame id'
    )
    const messageBranchId = assertSafeSegment(
      stringValue(conversation.message_branch_id) ?? '',
      'message branch id'
    )
    const runtimeSegmentId = assertSafeSegment(
      stringValue(conversation.runtime_segment_id) ?? '',
      'runtime segment id'
    )
    const promptMessageId = assertSafeSegment(
      stringValue(conversation.prompt_message_id) ?? '',
      'prompt message id'
    )
    const content = await readFile(join(input.versionDirectory, 'content'))
    if (content.byteLength !== sizeBytes || sha256(content) !== checksum) {
      throw new Error('Recovered Artifact content is corrupt.')
    }

    const producer = recordValue(evidence.producer)
    const executionStatus = recordValue(evidence.execution_status)
    let executionSnapshotJson: string | undefined
    let executionSnapshotChecksum: string | undefined
    let producerRunId: string | undefined
    let producerRunIndex: number | undefined
    let notebookSessionId: string | undefined
    if (executionStatus?.state === 'available') {
      executionSnapshotJson = await readFile(join(input.versionDirectory, 'execution.json'), 'utf8')
      executionSnapshotChecksum = stringValue(evidence.execution_snapshot_checksum)
      if (
        !executionSnapshotChecksum ||
        sha256(executionSnapshotJson) !== executionSnapshotChecksum
      ) {
        throw new Error('Recovered Artifact execution snapshot is corrupt.')
      }
      const execution = recordValue(JSON.parse(executionSnapshotJson))
      producerRunId = stringValue(producer?.producer_run_id)
      producerRunIndex = numberValue(producer?.run_index)
      notebookSessionId = stringValue(producer?.notebook_session_id)
      if (
        !execution ||
        execution.schemaVersion !== 2 ||
        execution.producerRunId !== producerRunId ||
        execution.producerRunIndex !== producerRunIndex
      ) {
        throw new Error('Recovered Artifact producer binding is invalid.')
      }
    }

    const snapshot = await this.findOwningMessageSnapshot({
      projectId: input.projectId,
      appSessionId: input.appSessionId,
      versionId: input.versionId,
      rootFrameId,
      agentFrameId,
      messageBranchId
    })
    const pendingRoute = await this.options.compatibilityRepository.findPendingVersionRouting({
      projectId: input.projectId,
      artifactId: input.artifactId,
      versionId: input.versionId
    })
    if (snapshot && pendingRoute) {
      throw new Error('Recovered Artifact has conflicting finalized and pending ownership proofs.')
    }
    if (!snapshot && !pendingRoute) {
      throw new Error('Recovered Artifact has no exact lifecycle ownership proof.')
    }
    if (
      pendingRoute &&
      (pendingRoute.versionNumber !== versionNumber ||
        normalizeFilename(pendingRoute.filename) !== normalizeFilename(filename) ||
        pendingRoute.checksum !== checksum ||
        (pendingRoute.mimeType ?? undefined) !== (stringValue(evidence.content_type) ?? undefined))
    ) {
      throw new Error('Recovered Artifact pending routing does not match immutable evidence.')
    }

    const rawInputs = Array.isArray(evidence.inputs) ? evidence.inputs : []
    const inputs = rawInputs.map((value, index) => {
      const item = recordValue(value)
      const sourceKind = stringValue(item?.source_kind)
      const inputFileVersionId = stringValue(item?.input_file_version_id)
      const sourceFileId = stringValue(item?.source_file_id)
      const sourceProjectId = stringValue(item?.source_project_id)
      const sourceSessionId = stringValue(item?.source_session_id)
      const inputFilename = stringValue(item?.filename)
      const inputChecksum = stringValue(item?.checksum)
      const storageKeyValue = stringValue(item?.storage_key)
      const inputSize = numberValue(item?.size_bytes)
      if (
        item?.ordinal !== index ||
        (sourceKind !== 'artifact-version' && sourceKind !== 'upload-version') ||
        !inputFileVersionId ||
        !sourceFileId ||
        !sourceProjectId ||
        !sourceSessionId ||
        !inputFilename ||
        !inputChecksum ||
        !storageKeyValue ||
        !Number.isSafeInteger(inputSize)
      ) {
        throw new Error('Recovered Artifact input evidence is invalid.')
      }
      return {
        id: this.options.createId(),
        ordinal: index,
        inputFileVersionId,
        sourceKind,
        sourceFileId,
        sourceArtifactVersionId: sourceKind === 'artifact-version' ? inputFileVersionId : undefined,
        sourceUploadVersionId: sourceKind === 'upload-version' ? inputFileVersionId : undefined,
        sourceVersionNumber: numberValue(item.source_version_number),
        sourceCreatedAt: stringValue(item.source_created_at)
          ? new Date(stringValue(item.source_created_at)!)
          : undefined,
        sourceProjectId,
        sourceSessionId,
        filename: inputFilename,
        contentType: stringValue(item.content_type),
        sizeBytes: BigInt(inputSize!),
        checksum: inputChecksum,
        storageKey: storageKeyValue,
        strongestAssociation: stringValue(item.strongest_association) ?? 'captured-version'
      }
    })

    const client = await this.options.getClient()
    await client.$transaction(async (transaction) => {
      await transaction.fileOriginSession.upsert({
        where: {
          projectId_sessionId: { projectId: input.projectId, sessionId: input.appSessionId }
        },
        create: { projectId: input.projectId, sessionId: input.appSessionId },
        update: {}
      })
      const normalizedFilename = normalizeFilename(filename)
      const lineageByName = await transaction.artifactLineage.findUnique({
        where: {
          projectId_sessionId_normalizedFilename: {
            projectId: input.projectId,
            sessionId: input.appSessionId,
            normalizedFilename
          }
        }
      })
      if (lineageByName && lineageByName.id !== input.artifactId) {
        throw new Error('Recovered Artifact lineage conflicts with an existing filename identity.')
      }
      const lineageById = await transaction.artifactLineage.findUnique({
        where: { id: input.artifactId }
      })
      if (
        lineageById &&
        (lineageById.projectId !== input.projectId ||
          lineageById.sessionId !== input.appSessionId ||
          lineageById.normalizedFilename !== normalizedFilename)
      ) {
        throw new Error('Recovered Artifact lineage ownership conflicts with SQLite.')
      }
      if (!lineageById) {
        await transaction.artifactLineage.create({
          data: {
            id: input.artifactId,
            projectId: input.projectId,
            sessionId: input.appSessionId,
            normalizedFilename,
            filename
          }
        })
      }
      await transaction.artifactVersion.create({
        data: {
          id: input.versionId,
          artifactId: input.artifactId,
          versionNumber: versionNumber!,
          filename,
          artifactRunId: pendingRoute?.artifactRunId ?? `recovered-${input.versionId}`,
          rootFrameId,
          agentFrameId,
          messageBranchId,
          runtimeSegmentId,
          promptMessageId,
          notebookSessionId,
          producerRunId,
          producerRunIndex,
          messageId: snapshot?.terminalMessageId,
          messageSnapshotId: snapshot?.id,
          state: snapshot ? 'finalized' : 'pending',
          contentStorageKey: storageKey(
            'artifacts',
            input.projectId,
            input.appSessionId,
            '.provenance',
            input.artifactId,
            'versions',
            input.versionId,
            'content'
          ),
          evidenceStorageKey: storageKey(
            'artifacts',
            input.projectId,
            input.appSessionId,
            '.provenance',
            input.artifactId,
            'versions',
            input.versionId,
            'evidence.json'
          ),
          contentType: stringValue(evidence.content_type),
          sizeBytes: BigInt(sizeBytes!),
          checksum,
          evidenceJson,
          evidenceChecksum: sha256(evidenceJson),
          evidenceSchemaVersion: 1,
          executionSnapshotJson,
          executionSnapshotChecksum,
          executionSnapshotStorageKey: executionSnapshotJson
            ? storageKey(
                'artifacts',
                input.projectId,
                input.appSessionId,
                '.provenance',
                input.artifactId,
                'versions',
                input.versionId,
                'execution.json'
              )
            : undefined,
          executionSnapshotSchemaVersion: executionSnapshotJson ? 2 : undefined,
          ...(inputs.length > 0 ? { inputs: { create: inputs } } : {}),
          createdAt: new Date(createdAtValue)
        }
      })
    })
  }

  private async findOwningMessageSnapshot(input: {
    projectId: string
    appSessionId: string
    versionId: string
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
  }): Promise<{ id: string; terminalMessageId: string } | undefined> {
    const client = await this.options.getClient()
    const candidates = await client.artifactMessageSnapshot.findMany({
      where: {
        projectId: input.projectId,
        sessionId: input.appSessionId,
        rootFrameId: input.rootFrameId,
        agentFrameId: input.agentFrameId,
        messageBranchId: input.messageBranchId,
        state: 'ready'
      }
    })
    const matches: Array<{ id: string; terminalMessageId: string }> = []
    for (const candidate of candidates) {
      try {
        const serialized = await readFile(
          resolveStorageKey(this.options.storageRoot, candidate.storageKey),
          'utf8'
        )
        if (!candidate.checksum || sha256(serialized) !== candidate.checksum) continue
        const payload = recordValue(JSON.parse(serialized))
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const messageRecords = messages.map(recordValue)
        const messageIds = new Set(messageRecords.map((message) => stringValue(message?.id)))
        const hasCompleteParentChain = messageRecords.every((message, index) => {
          if (!message || !stringValue(message.id)) return false
          const parentMessageId = stringValue(message.parentMessageId)
          return index === 0
            ? parentMessageId === undefined
            : parentMessageId === stringValue(messageRecords[index - 1]?.id)
        })
        const terminal = recordValue(messages.at(-1))
        const artifacts = Array.isArray(terminal?.artifacts) ? terminal.artifacts : []
        const parts = Array.isArray(terminal?.parts) ? terminal.parts : []
        const ownsVersion =
          artifacts.some((artifact) => recordValue(artifact)?.versionId === input.versionId) ||
          parts.some(
            (part) =>
              recordValue(part)?.type === 'artifact' &&
              recordValue(part)?.versionId === input.versionId
          )
        if (
          (payload?.schemaVersion === 2 || payload?.schemaVersion === 3) &&
          payload?.snapshotId === candidate.id &&
          payload.rootFrameId === input.rootFrameId &&
          payload.agentFrameId === input.agentFrameId &&
          payload.messageBranchId === input.messageBranchId &&
          payload.terminalMessageId === candidate.terminalMessageId &&
          messages.length === candidate.messageCount &&
          messageIds.size === messages.length &&
          hasCompleteParentChain &&
          (payload.schemaVersion !== 3 ||
            (Array.isArray(payload.activities) && Array.isArray(payload.activityGroups))) &&
          terminal?.id === candidate.terminalMessageId &&
          ownsVersion
        ) {
          matches.push({ id: candidate.id, terminalMessageId: candidate.terminalMessageId })
        }
      } catch {
        // A corrupt candidate cannot prove ownership; another valid snapshot may still do so.
      }
    }
    return matches.length === 1 ? matches[0] : undefined
  }
}

export {
  ArtifactProvenanceUnindexedRecovery,
  type ArtifactUnindexedRecoveryResult,
  type ArtifactUnindexedRecoverySnapshot
}
