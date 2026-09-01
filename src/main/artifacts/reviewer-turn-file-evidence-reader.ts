import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

import type { PrismaClient } from '@prisma/client'

import type { NotebookRunInputFile } from '../../shared/notebook'
import type {
  ReviewerFileContentStatus,
  ReviewerFileEvidenceDescriptor,
  ReviewerSourceEvidenceDescriptor,
  ReviewerWorkProductEvidenceDescriptor
} from '../../shared/reviewer'
import type { ReviewerFileEvidenceRecord } from '../reviewer/turn-evidence'
import type { NotebookRunRepository } from '../notebook/repository'
import { resolveStorageKey } from './provenance-storage'

type ReviewerTurnFileEvidenceReaderOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  notebookRepository: Pick<NotebookRunRepository, 'readSessionDocuments'>
}

type SourceCandidate = {
  descriptor: ReviewerFileEvidenceDescriptor
  executionId?: string
  directlyRead: boolean
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const producerEvidence = (
  evidenceJson: string | null
): { available: boolean; connectorInvocationId?: string } => {
  if (!evidenceJson) return { available: false }
  try {
    const producer = recordValue(recordValue(JSON.parse(evidenceJson))?.producer)
    return {
      available: producer?.state === 'available',
      ...(producer?.kind === 'connector' && typeof producer.invocation_id === 'string'
        ? { connectorInvocationId: producer.invocation_id }
        : {})
    }
  } catch {
    return { available: false }
  }
}

type DescriptorInput =
  | (Omit<ReviewerWorkProductEvidenceDescriptor, 'sizeBytes' | 'mimeType'> & {
      sizeBytes: number | bigint
      mimeType?: string | null
    })
  | (Omit<ReviewerSourceEvidenceDescriptor, 'sizeBytes' | 'mimeType'> & {
      sizeBytes: number | bigint
      mimeType?: string | null
    })

const descriptor = (input: DescriptorInput): ReviewerFileEvidenceDescriptor => {
  const base = {
    versionId: input.versionId,
    filename: input.filename,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    sizeBytes: Number(input.sizeBytes),
    checksum: input.checksum,
    traceAvailable: input.traceAvailable,
    contentStatus: input.contentStatus
  }
  if (input.role === 'work_product') {
    return { ...base, role: input.role, scopeReason: input.scopeReason }
  }
  return { ...base, role: input.role, scopeReason: input.scopeReason }
}

export class ReviewerTurnFileEvidenceReader {
  constructor(private readonly options: ReviewerTurnFileEvidenceReaderOptions) {}

  private async contentStatus(
    storageKey: string,
    expectedSize: number | bigint,
    expectedChecksum: string
  ): Promise<ReviewerFileContentStatus> {
    try {
      const path = resolveStorageKey(this.options.storageRoot, storageKey)
      const file = await stat(path)
      if (file.size !== Number(expectedSize)) return 'checksum-mismatch'
      const hash = createHash('sha256')
      await pipeline(createReadStream(path), hash)
      return hash.digest('hex') === expectedChecksum ? 'available' : 'checksum-mismatch'
    } catch {
      return 'missing'
    }
  }

  async resolve(request: {
    projectId: string
    sessionId: string
    artifactVersionIds: readonly string[]
    messageIds: readonly string[]
  }): Promise<ReviewerFileEvidenceRecord[]> {
    const versionIds = [...new Set(request.artifactVersionIds)]
    const client = await this.options.getClient()
    const versions =
      versionIds.length === 0
        ? []
        : await client.artifactVersion.findMany({
            where: {
              id: { in: versionIds },
              state: 'finalized',
              messageId: { in: [...request.messageIds] },
              artifact: { is: { projectId: request.projectId, sessionId: request.sessionId } }
            },
            include: { inputs: { orderBy: { ordinal: 'asc' } } }
          })
    const workProducts: ReviewerFileEvidenceRecord[] = []
    const sourceCandidates = new Map<string, SourceCandidate[]>()
    const addSource = (candidate: SourceCandidate): void => {
      const candidates = sourceCandidates.get(candidate.descriptor.versionId) ?? []
      const sameExecution = candidates.find(
        (existing) =>
          existing.directlyRead === candidate.directlyRead &&
          existing.executionId === candidate.executionId
      )
      if (sameExecution) {
        sameExecution.descriptor = {
          ...sameExecution.descriptor,
          ...candidate.descriptor,
          traceAvailable:
            sameExecution.descriptor.traceAvailable || candidate.descriptor.traceAvailable,
          contentStatus:
            sameExecution.descriptor.contentStatus === 'available' ||
            candidate.descriptor.contentStatus === 'available'
              ? 'available'
              : sameExecution.descriptor.contentStatus === 'checksum-mismatch' ||
                  candidate.descriptor.contentStatus === 'checksum-mismatch'
                ? 'checksum-mismatch'
                : 'missing'
        }
      } else {
        candidates.push(candidate)
      }
      sourceCandidates.set(candidate.descriptor.versionId, candidates)
    }

    for (const versionId of versionIds) {
      const version = versions.find((candidate) => candidate.id === versionId)
      if (!version || !version.messageId) continue
      const producer = producerEvidence(version.evidenceJson)
      const executionId = version.producerRunId ?? producer.connectorInvocationId
      workProducts.push({
        ...descriptor({
          versionId: version.id,
          role: 'work_product',
          filename: version.filename,
          mimeType: version.contentType,
          sizeBytes: version.sizeBytes,
          checksum: version.checksum,
          scopeReason: 'produced-by-turn',
          traceAvailable: producer.available,
          contentStatus: await this.contentStatus(
            version.contentStorageKey,
            version.sizeBytes,
            version.checksum
          )
        }),
        messageId: version.messageId,
        executionId,
        directlyRead: false
      })
      for (const input of version.inputs) {
        const directlyRead = input.strongestAssociation === 'resolver-accessed'
        addSource({
          descriptor: descriptor({
            versionId: input.inputFileVersionId,
            role: 'source_document',
            filename: input.filename,
            mimeType: input.contentType,
            sizeBytes: input.sizeBytes,
            checksum: input.checksum,
            scopeReason: directlyRead ? 'read-by-turn' : 'artifact-input',
            traceAvailable: true,
            contentStatus: await this.contentStatus(
              input.storageKey,
              input.sizeBytes,
              input.checksum
            )
          }),
          executionId,
          directlyRead
        })
      }
    }

    const messageIds = new Set(request.messageIds)
    const documents = await this.options.notebookRepository.readSessionDocuments(
      request.projectId,
      request.sessionId
    )
    for (const run of documents.flatMap((document) => document.runs)) {
      if (!run.promptMessageId || !messageIds.has(run.promptMessageId)) continue
      for (const input of run.inputFiles ?? []) {
        if (input.association !== 'resolver-accessed') continue
        addSource({
          descriptor: await this.sourceDescriptor(input),
          executionId: run.runId,
          directlyRead: true
        })
      }
    }

    const sources = [...sourceCandidates.values()].flatMap((candidates) => {
      const direct = candidates.filter((candidate) => candidate.directlyRead)
      return (direct.length > 0 ? direct : candidates.slice(0, 1)).map((candidate) => ({
        ...candidate.descriptor,
        executionId: candidate.executionId,
        directlyRead: candidate.directlyRead
      }))
    })
    return [...workProducts, ...sources]
  }

  private async sourceDescriptor(
    input: NotebookRunInputFile
  ): Promise<ReviewerFileEvidenceDescriptor> {
    return descriptor({
      versionId: input.inputFileVersionId,
      role: 'source_document',
      filename: input.filename,
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      scopeReason: 'read-by-turn',
      traceAvailable: true,
      contentStatus: await this.contentStatus(input.storageKey, input.sizeBytes, input.checksum)
    })
  }
}
