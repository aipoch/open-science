import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UploadedAttachment } from '../../shared/uploads'
import type { UploadRepository } from '../uploads/repository'

type SaveRecoveryTextInput = {
  projectId: string
  sessionId: string
  messageId: string
  text: string
  uploads: Pick<UploadRepository, 'stageLocalFile' | 'finalizePendingSessionUploads'>
  // Must durably upsert by attachment.id on the source message, preserving unrelated attachments.
  // Receives only a published immutable Version. Publication first establishes Session ownership
  // in UploadFile/FileOriginSession; a failed message bind must not delete those owned bytes.
  attach: (messageId: string, attachment: UploadedAttachment) => Promise<void>
}

export const saveRecoveryText = async (
  input: SaveRecoveryTextInput
): Promise<UploadedAttachment> => {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-recovery-'))
  const sourcePath = join(directory, 'content.txt')
  try {
    await writeFile(sourcePath, input.text, { encoding: 'utf8', mode: 0o600 })
    const digest = createHash('sha256').update(input.text).digest('hex').slice(0, 12)
    const staged = await input.uploads.stageLocalFile({
      transferId: randomUUID(),
      sourcePath,
      name: `recovery-${digest}.jsonl`,
      // A dedicated media type keeps provider preparation on its reference-only path.
      mimeType: 'application/vnd.open-science.recovery+jsonl',
      size: Buffer.byteLength(input.text)
    })
    const [finalized] = await input.uploads.finalizePendingSessionUploads(
      input.sessionId,
      [staged],
      input.projectId
    )
    if (!finalized?.versionId)
      throw new Error('Recovery text publication did not return an immutable attachment.')
    await input.attach(input.messageId, finalized)
    return finalized
  } finally {
    // On publication failure the upload owner may already have committed a staging Version.
    // Keep its pending source for recoverStagingUploads; that owner also reclaims crash-orphaned
    // transfers. Deleting it here could destroy the only recoverable bytes of a durable Version.
    await rm(directory, { recursive: true, force: true })
  }
}
export type { SaveRecoveryTextInput }
