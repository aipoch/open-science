import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import {
  DEFAULT_UPLOAD_PROJECT_NAME,
  PENDING_UPLOAD_SESSION_ID,
  type DeleteUploadRequest,
  type StageUploadFilesRequest,
  type UploadedAttachment
} from '../../shared/uploads'
import { readBoundedManagedFilePreview } from '../managed-file-preview'

const UPLOADS_DIR = 'uploads'
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type CreateAttachmentInput = {
  id: string
  sessionId: string
  filename: string
  originalName: string
  filePath: string
  mimeType?: string
}

// Accepts only path segments that cannot escape the managed upload layout.
const assertSafePathSegment = (segment: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid upload path segment: ${segment}`)
  }

  return segment
}

// Allows the temporary staging directory while still validating durable session ids.
const assertSafeSessionId = (sessionId: string): string => {
  if (sessionId === PENDING_UPLOAD_SESSION_ID) return sessionId

  return assertSafePathSegment(sessionId)
}

// Converts user-provided or clipboard filenames into safe, display-friendly basenames.
const toSafeUploadFilename = (filename: string): string => {
  const leafName = basename((filename.trim() || 'upload').replace(/\\/g, '/'))
  const safeName = leafName
    .replace(/[^A-Za-z0-9._ -]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/g, '')
    .replace(/[. ]+$/g, '')
    .trim()

  return safeName && safeName !== PENDING_UPLOAD_SESSION_ID ? safeName : 'upload'
}

// Keeps duplicate upload names stable by suffixing before the original extension.
const appendFilenameSuffix = (filename: string, suffix: number): string => {
  const extension = extname(filename)
  const baseName = basename(filename, extension)

  return `${baseName}-${suffix}${extension}`
}

// Rejects direct traversal and absolute-path escapes before and after canonicalization.
const assertPathInsideRoot = (rootPath: string, filePath: string): void => {
  const relativePath = relative(rootPath, filePath)

  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Upload file is outside upload storage.')
  }
  if (isAbsolute(relativePath)) {
    throw new Error('Upload file is outside upload storage.')
  }
}

// Narrows platform file errors without depending on Node-specific exception classes.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

// Detects exclusive-write collisions so callers can allocate the next available filename.
const isFileExistsError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'EEXIST'

// Owns app-managed uploads so renderer paths are always validated in the main process.
class UploadRepository {
  // The storage root is the app persistence root; this class appends uploads/project/session.
  constructor(private readonly storageRoot: string) {}

  // Writes selected or pasted files to the pending session directory before a prompt is sent.
  async stageFiles(request: StageUploadFilesRequest): Promise<UploadedAttachment[]> {
    const directory = this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID)

    await mkdir(directory, { recursive: true })

    return Promise.all(
      request.files.map(async (file) => {
        // Preserve the original display name separately from the sanitized filesystem name.
        const originalName = file.name.trim() || 'upload'
        const { filename, filePath } = await this.writeUniqueFile(
          directory,
          toSafeUploadFilename(originalName),
          Buffer.from(file.content, 'base64')
        )

        return this.createAttachment({
          id: randomUUID(),
          sessionId: PENDING_UPLOAD_SESSION_ID,
          filename,
          originalName,
          filePath,
          mimeType: file.mimeType
        })
      })
    )
  }

  // Moves pending attachments into their durable session directory once the runtime id is known.
  async finalizePendingSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[]
  ): Promise<UploadedAttachment[]> {
    const safeSessionId = assertSafePathSegment(sessionId)

    return Promise.all(
      attachments.map((attachment) => this.finalizeAttachment(safeSessionId, attachment))
    )
  }

  // Deletes an app-managed upload after resolving the caller path through the trust boundary.
  async deleteUpload(request: DeleteUploadRequest): Promise<void> {
    try {
      await rm(await this.resolveManagedUploadPath(request), { force: true })
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
  }

  // Resolves a renderer-provided upload path only after root and symlink checks pass.
  async resolveManagedUploadPath(request: DeleteUploadRequest): Promise<string> {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.path !== 'string' ||
      request.path.trim().length === 0
    ) {
      throw new Error('Invalid upload file path.')
    }

    const uploadRoot = this.getUploadRoot()
    const requestedPath = resolve(request.path)

    assertPathInsideRoot(uploadRoot, requestedPath)

    // Canonical paths catch symlinks that start inside storage but point outside it.
    const resolvedUploadRoot = await realpath(uploadRoot)
    const resolvedFilePath = await realpath(requestedPath)

    assertPathInsideRoot(resolvedUploadRoot, resolvedFilePath)

    if (!(await stat(resolvedFilePath)).isFile()) {
      throw new Error('Upload path is not a file.')
    }

    return resolvedFilePath
  }

  // Reads upload previews through the shared bounded reader after upload-specific path validation.
  async readManagedUploadPreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    const filePath = await this.resolveManagedUploadPath(request)
    return readBoundedManagedFilePreview(filePath, request, 'Invalid upload preview encoding.')
  }

  // Converts one pending attachment record into a durable session-owned upload record.
  private async finalizeAttachment(
    sessionId: string,
    attachment: UploadedAttachment
  ): Promise<UploadedAttachment> {
    if (attachment.sessionId === sessionId) {
      // Finalization is idempotent when the attachment already belongs to the target session.
      const targetDir = this.getSessionUploadDir(sessionId)
      const resolvedFilePath = await this.resolveManagedUploadPath({ path: attachment.path })

      assertPathInsideRoot(await realpath(targetDir), resolvedFilePath)

      return attachment
    }

    if (attachment.sessionId !== PENDING_UPLOAD_SESSION_ID) {
      throw new Error('Upload attachment belongs to a different session.')
    }

    const pendingDir = this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID)
    const targetDir = this.getSessionUploadDir(sessionId)
    const sourcePath = await this.resolveManagedUploadPath({ path: attachment.path })

    assertPathInsideRoot(await realpath(pendingDir), sourcePath)
    await mkdir(targetDir, { recursive: true })

    // Copy-then-delete keeps the target allocation exclusive while supporting cross-device moves.
    const { filename, filePath } = await this.moveToUniqueFile(
      sourcePath,
      targetDir,
      attachment.name
    )

    return this.createAttachment({
      ...attachment,
      sessionId,
      filename,
      filePath
    })
  }

  // Returns the top-level upload directory under the app persistence root.
  private getUploadRoot(): string {
    return resolve(this.storageRoot, UPLOADS_DIR)
  }

  // Returns the per-project upload directory for the current workspace project.
  private getProjectUploadDir(): string {
    return join(this.getUploadRoot(), DEFAULT_UPLOAD_PROJECT_NAME)
  }

  // Returns the staging or durable directory for one upload session.
  private getSessionUploadDir(sessionId: string): string {
    return join(this.getProjectUploadDir(), assertSafeSessionId(sessionId))
  }

  // Writes a new file without overwriting an existing upload with the same display name.
  private async writeUniqueFile(
    directory: string,
    filename: string,
    content: Buffer
  ): Promise<{ filename: string; filePath: string }> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? filename : appendFilenameSuffix(filename, attempt + 1)
      const filePath = join(directory, candidate)

      try {
        // The wx flag makes the write fail when another upload already claimed this filename.
        await writeFile(filePath, content, { flag: 'wx' })
        return { filename: candidate, filePath }
      } catch (error) {
        if (isFileExistsError(error)) continue
        throw error
      }
    }

    throw new Error(`Could not allocate upload filename: ${filename}`)
  }

  // Moves an already-staged file into a target directory while preserving unique filenames.
  private async moveToUniqueFile(
    sourcePath: string,
    targetDir: string,
    filename: string
  ): Promise<{ filename: string; filePath: string }> {
    const safeFilename = toSafeUploadFilename(filename)

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate =
        attempt === 0 ? safeFilename : appendFilenameSuffix(safeFilename, attempt + 1)
      const filePath = join(targetDir, candidate)

      try {
        // COPYFILE_EXCL provides the same no-overwrite guarantee as the staging write.
        await copyFile(sourcePath, filePath, constants.COPYFILE_EXCL)
        await rm(sourcePath, { force: true })
        return { filename: candidate, filePath }
      } catch (error) {
        if (isFileExistsError(error)) continue
        throw error
      }
    }

    throw new Error(`Could not allocate upload filename: ${safeFilename}`)
  }

  // Builds the renderer-safe attachment metadata from the trusted file on disk.
  private async createAttachment(input: CreateAttachmentInput): Promise<UploadedAttachment> {
    return {
      id: input.id,
      sessionId: input.sessionId,
      name: input.filename,
      originalName: input.originalName,
      path: input.filePath,
      mimeType: input.mimeType,
      size: (await stat(input.filePath)).size
    }
  }
}

export { UploadRepository }
