import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

type VisionEvidenceSource =
  | Readonly<{ kind: 'upload-version'; uploadVersionId: string }>
  | Readonly<{ kind: 'message-image'; messageId: string; imageId: string }>

type FindVisionEvidenceInput = Readonly<{
  identityKey: string
  imageChecksum: string
  extractorFingerprint: string
  evidenceSchemaVersion: number
}>

type SaveVisionEvidenceInput = FindVisionEvidenceInput &
  Readonly<{
    projectId: string
    sessionId: string
    source: VisionEvidenceSource
    mimeType: string
    evidenceJson: string
  }>

type VisionEvidencePersistence = Readonly<{
  find(input: FindVisionEvidenceInput): Promise<string | undefined>
  save(input: SaveVisionEvidenceInput): Promise<void>
}>

type VisionEvidenceClient = Pick<
  PrismaClient,
  '$transaction' | 'project' | 'uploadVersion' | 'visionEvidence'
>
type VisionEvidenceClientProvider = () => Promise<VisionEvidenceClient>

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

class VisionEvidenceRepository implements VisionEvidencePersistence {
  constructor(private readonly clientProvider: VisionEvidenceClientProvider) {}

  async find(input: FindVisionEvidenceInput): Promise<string | undefined> {
    const client = await this.clientProvider()
    const row = await client.visionEvidence.findUnique({
      where: { id: input.identityKey },
      include: { uploadVersion: { include: { uploadFile: true } } }
    })
    if (
      !row ||
      row.imageChecksum !== input.imageChecksum ||
      row.extractorFingerprint !== input.extractorFingerprint ||
      row.evidenceSchemaVersion !== input.evidenceSchemaVersion ||
      row.evidenceChecksum !== sha256(row.evidenceJson) ||
      (row.sourceKind === 'upload-version' &&
        (row.uploadVersion === null ||
          row.uploadVersion.uploadFile.projectId !== row.projectId ||
          row.uploadVersion.uploadFile.sessionId !== row.sessionId))
    ) {
      return undefined
    }
    return row.evidenceJson
  }

  async save(input: SaveVisionEvidenceInput): Promise<void> {
    const client = await this.clientProvider()
    const sourceFields =
      input.source.kind === 'upload-version'
        ? {
            sourceKind: input.source.kind,
            uploadVersionId: input.source.uploadVersionId,
            sourceMessageId: null,
            sourceImageId: null
          }
        : {
            sourceKind: input.source.kind,
            uploadVersionId: null,
            sourceMessageId: input.source.messageId,
            sourceImageId: input.source.imageId
          }
    const data = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...sourceFields,
      imageChecksum: input.imageChecksum,
      mimeType: input.mimeType,
      extractorFingerprint: input.extractorFingerprint,
      evidenceSchemaVersion: input.evidenceSchemaVersion,
      evidenceJson: input.evidenceJson,
      evidenceChecksum: sha256(input.evidenceJson)
    }
    await client.$transaction(async (transaction) => {
      const owner = await transaction.project.findFirst({
        where: { id: input.projectId, deletedAt: null },
        select: { id: true }
      })
      if (!owner) return
      if (input.source.kind === 'upload-version') {
        const source = await transaction.uploadVersion.findFirst({
          where: {
            id: input.source.uploadVersionId,
            uploadFile: { projectId: input.projectId, sessionId: input.sessionId }
          },
          select: { id: true }
        })
        if (!source) return
      }
      await transaction.visionEvidence.upsert({
        where: { id: input.identityKey },
        create: { id: input.identityKey, ...data },
        update: data
      })
    })
  }

  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return
    const client = await this.clientProvider()
    await client.visionEvidence.deleteMany({ where: { sessionId: { in: [...sessionIds] } } })
  }

  async reconcileSessions(existingSessionIds: readonly string[]): Promise<void> {
    const client = await this.clientProvider()
    await client.visionEvidence.deleteMany({
      where: { sessionId: { notIn: [...existingSessionIds] } }
    })
  }
}

export { VisionEvidenceRepository }
export type {
  FindVisionEvidenceInput,
  SaveVisionEvidenceInput,
  VisionEvidencePersistence,
  VisionEvidenceSource
}
