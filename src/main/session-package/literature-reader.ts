import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrismaClient, Prisma } from '@prisma/client'
import {
  sessionPackageReceiptSchema,
  sessionPackageManifestSchema
} from '../../shared/session-package'
import type { ResolvedLiteratureAttachmentVersion } from '../literature/attachment-authority'
import type { ContentReadLease } from '../storage/content-repository'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import { assertPackageSourcePath, readPackageJson, fileChecksum } from './archive'
import { packageLiteratureSchema } from './literature'

// Receipt membership grants access only to an imported snapshot, never an arbitrary Upload ID.
export class PackageLiteratureReader {
  constructor(
    private readonly options: {
      storageRoot: string
      getClient: () => Promise<PrismaClient>
      files: Pick<ManagedFileVersionService, 'openVersion'>
    }
  ) {}

  private async member(
    versionId: string
  ): Promise<
    | { row: Prisma.UploadVersionGetPayload<{ include: { uploadFile: true } }>; itemId: string }
    | undefined
  > {
    const client = await this.options.getClient()
    const row = await client.uploadVersion.findUnique({
      where: { id: versionId },
      include: { uploadFile: true }
    })
    if (!row) return undefined
    const { projectId, sessionId } = row.uploadFile
    const base = `artifacts/${projectId}/${sessionId}`
    const forkReceipt = await lstat(join(this.options.storageRoot, base, '.session-fork')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    )
    const directory = `${base}/${forkReceipt ? '.session-fork' : '.session-package'}`
    try {
      await assertPackageSourcePath(this.options.storageRoot, `${directory}/receipt.json`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const root = join(this.options.storageRoot, directory)
    const receipt = sessionPackageReceiptSchema.parse(
      await readPackageJson(join(root, 'receipt.json'))
    )
    if (receipt.projectId !== projectId || receipt.sessionId !== sessionId)
      throw new Error('Literature package owner mismatch.')
    await assertPackageSourcePath(root, 'source/manifest.json')
    if ((await fileChecksum(join(root, 'source/manifest.json'))) !== receipt.manifestChecksum)
      throw new Error('Literature package manifest changed.')
    const manifest = sessionPackageManifestSchema.parse(
      await readPackageJson(join(root, 'source/manifest.json'))
    )
    const recordEntry = manifest.inventory.find((entry) => entry.path === 'records.json')
    await assertPackageSourcePath(root, 'source/records.json')
    if (
      !recordEntry ||
      (await fileChecksum(join(root, 'source/records.json'))) !== recordEntry.checksum
    )
      throw new Error('Literature package metadata changed.')
    const records = (await readPackageJson(join(root, 'source/records.json'))) as {
      literature?: unknown
    }
    if (!records.literature) return undefined
    const literature = packageLiteratureSchema.parse(records.literature)
    const entry = literature.attachments.find(
      (entry) => receipt.identities[entry.versionId] === versionId
    )
    if (!entry) return undefined
    const file = receipt.files.find((file) => file.localStorageKey === row.contentStorageKey)
    if (
      receipt.identities[entry.attachmentId] !== row.uploadFileId ||
      row.contentType !== 'application/pdf' ||
      row.state !== 'ready'
    )
      throw new Error('Literature package Version identity mismatch.')
    // An excluded PDF retains metadata but never acquires access through another local file.
    if (!file) throw new Error('This Literature PDF was not included in the Session package.')
    if (file.localChecksum !== row.checksum)
      throw new Error('Literature package content identity mismatch.')
    return { row, itemId: receipt.identities[entry.itemId] }
  }

  async resolveVersion(
    versionId: string
  ): Promise<ResolvedLiteratureAttachmentVersion | undefined> {
    const member = await this.member(versionId)
    if (!member) return undefined
    const { row, itemId } = member
    const lease = await this.options.files.openVersion(
      { source: 'upload', projectId: row.uploadFile.projectId, fileId: row.uploadFileId },
      versionId
    )
    try {
      return {
        itemId,
        attachmentId: row.uploadFileId,
        versionId,
        versionNumber: row.versionNumber,
        filename: row.filename,
        contentType: 'application/pdf',
        sizeBytes: Number(row.sizeBytes),
        checksum: row.checksum,
        storageKey: row.contentStorageKey,
        path: lease.path
      }
    } finally {
      await lease.close()
    }
  }

  async openContent(versionId: string): Promise<ContentReadLease> {
    const member = await this.member(versionId)
    if (!member) throw new Error('Literature package attachment is unavailable.')
    const { row } = member
    const lease = await this.options.files.openVersion(
      { source: 'upload', projectId: row.uploadFile.projectId, fileId: row.uploadFileId },
      versionId
    )
    return { ...lease, checksum: row.checksum }
  }
}
