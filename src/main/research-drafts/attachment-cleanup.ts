import type { PrismaClient } from '@prisma/client'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { UploadedAttachment } from '../../shared/uploads'
import type { ContentRepository } from '../storage/content-repository'

export type ResearchAttachmentScan = { complete: boolean; sessions: PersistedChatSession[] }
export type ResearchAttachmentCleanupReceipt = {
  removedVersionIds: string[]
  retainedVersionIds: string[]
}

// Finalized uploads normally belong to the managed archive. This deliberately narrower owner can
// release only unpublished research-draft bytes, before any writable Session or submission can
// own them. Its caller must hold the data-root and Project mutation gates for the whole operation.
export class ResearchAttachmentCleanup {
  constructor(
    private readonly getClient: () => Promise<PrismaClient>,
    private readonly scanSessions: () => Promise<ResearchAttachmentScan>,
    private readonly sweep: ContentRepository['sweep'],
    private readonly isSingleEditor: () => boolean
  ) {}

  async release(
    projectId: string,
    draftId: string,
    attachments: UploadedAttachment[]
  ): Promise<ResearchAttachmentCleanupReceipt> {
    const candidates = attachments.filter((file) => file.versionId)
    const receipt: ResearchAttachmentCleanupReceipt = {
      removedVersionIds: [],
      retainedVersionIds: candidates.map((file) => file.versionId!)
    }
    if (!candidates.length || !this.isSingleEditor()) return receipt
    const scan = await this.scanSessions()
    const sessions = scan.sessions.filter((session) => session.projectId === projectId)
    // Ordinary composers may own in-memory references that are not in SQLite. Do not collect in
    // their presence, or after an incomplete/deleted-session scan. Imported sources are immutable.
    if (!scan.complete || sessions.some((session) => !session.packageOrigin)) return receipt
    const readonlyIds = new Set(sessions.map((session) => session.id))
    const sessionJson = JSON.stringify(sessions)
    const client = await this.getClient()
    const contentIds: string[] = []
    for (const attachment of candidates) {
      const versionId = attachment.versionId!
      if (sessionJson.includes(versionId) || sessionJson.includes(attachment.id)) continue
      const removed = await client.$transaction(async (tx) => {
        const project = await tx.project.findFirst({
          where: { id: projectId, deletedAt: null, archivedAt: null }
        })
        if (!project || !this.isSingleEditor()) return false
        const origins = await tx.fileOriginSession.findMany({
          where: { projectId },
          select: { sessionId: true, state: true }
        })
        if (
          origins.some(
            (origin) =>
              origin.state !== 'active' ||
              (!readonlyIds.has(origin.sessionId) &&
                !origin.sessionId.startsWith('research-draft-'))
          )
        )
          return false
        const file = await tx.uploadFile.findFirst({
          where: { id: attachment.id, projectId, sessionId: `research-draft-${draftId}` },
          include: { versions: true }
        })
        const version = file?.versions[0]
        if (
          !file ||
          file.currentVersionId !== null ||
          file.versions.length !== 1 ||
          !version ||
          version.id !== versionId ||
          version.state !== 'ready' ||
          version.versionNumber !== 1 ||
          version.basedOnVersionId ||
          !version.contentBlobId
        )
          return false
        // The Files projection means another composer/preview may have observed this Version.
        // Do not delete its managed authority even when that view has not yet persisted a message.
        const counts = await Promise.all([
          tx.managedFile.count({
            where: { OR: [{ sourceFileId: file.id }, { sourceVersionId: versionId }] }
          }),
          tx.managedFileVersionWriteOperation.count({ where: { sourceFileId: file.id } }),
          tx.artifactVersionInput.count({
            where: { OR: [{ sourceUploadVersionId: versionId }, { inputFileVersionId: versionId }] }
          }),
          tx.pdfAnnotation.count({ where: { versionId } }),
          tx.pdfAnnotationImport.count({ where: { versionId } }),
          tx.visionEvidence.count({ where: { uploadVersionId: versionId } })
        ])
        if (counts.some((count) => count > 0)) return false
        const [drafts, submissions, references, bookmarks, previews] = await Promise.all([
          tx.researchDraft.findMany({ where: { state: 'active' }, select: { payloadJson: true } }),
          // Cancel sending keeps a recoverable question, so cancelled payloads still own bytes.
          tx.researchSubmission.findMany({ select: { payloadJson: true } }),
          tx.replayQuestionContext.findMany({ select: { contextJson: true } }),
          tx.bookmark.findMany({ select: { sourceJson: true } }),
          tx.projectPreviewState.findMany({ select: { items: true } })
        ])
        const serialized = [
          ...drafts.map((row) => row.payloadJson),
          ...submissions.map((row) => row.payloadJson),
          ...references.map((row) => row.contextJson),
          ...bookmarks.map((row) => row.sourceJson),
          ...previews.map((row) => row.items)
        ]
        if (serialized.some((json) => json.includes(versionId) || json.includes(file.id)))
          return false
        await tx.uploadFile.update({ where: { id: file.id }, data: { currentVersionId: null } })
        await tx.uploadVersion.delete({ where: { id: versionId } })
        await tx.uploadFile.delete({ where: { id: file.id } })
        contentIds.push(version.contentBlobId)
        return true
      })
      if (removed) receipt.removedVersionIds.push(versionId)
    }
    receipt.retainedVersionIds = receipt.retainedVersionIds.filter(
      (id) => !receipt.removedVersionIds.includes(id)
    )
    // Shared blobs and live read/publication leases remain protected by the existing content owner.
    // A failed byte sweep leaves registry authority for the ordinary startup orphan sweep to retry.
    if (contentIds.length) await this.sweep({ createdBefore: new Date(Date.now() + 1), contentIds })
    return receipt
  }
}
