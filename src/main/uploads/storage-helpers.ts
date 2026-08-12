import { constants } from 'node:fs'
import { copyFile, link, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  DEFAULT_UPLOAD_PROJECT_NAME,
  PENDING_UPLOAD_SESSION_ID,
  type UploadedAttachment
} from '../../shared/uploads'

const UPLOADS_DIR = 'uploads'
const STAGING_UPLOAD_SESSION_ID = '.staging'
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
const assertPathInsideRoot = (
  rootPath: string,
  filePath: string,
  errorMessage = 'Upload file is outside upload storage.'
): void => {
  const relativePath = relative(rootPath, filePath)

  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(errorMessage)
  }
  if (isAbsolute(relativePath)) {
    throw new Error(errorMessage)
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

const getUploadRoot = (storageRoot: string): string => resolve(storageRoot, UPLOADS_DIR)

const getSessionUploadDir = (storageRoot: string, sessionId: string): string => {
  const safeSessionId =
    sessionId === STAGING_UPLOAD_SESSION_ID ? sessionId : assertSafeSessionId(sessionId)
  return join(getUploadRoot(storageRoot), DEFAULT_UPLOAD_PROJECT_NAME, safeSessionId)
}

// Moves an already-staged file into a target directory while preserving unique filenames.
const moveToUniqueUploadFile = async (
  sourcePath: string,
  targetDir: string,
  filename: string
): Promise<{ filename: string; filePath: string }> => {
  const safeFilename = toSafeUploadFilename(filename)

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? safeFilename : appendFilenameSuffix(safeFilename, attempt + 1)
    const filePath = join(targetDir, candidate)

    try {
      // A same-volume hard link commits the staged inode without a multi-GB second copy. Cross-
      // device or unsupported filesystems fall back to exclusive copy, preserving old behavior.
      try {
        await link(sourcePath, filePath)
      } catch (linkError) {
        if (isFileExistsError(linkError)) throw linkError
        await copyFile(sourcePath, filePath, constants.COPYFILE_EXCL)
      }
      await rm(sourcePath, { force: true })
      return { filename: candidate, filePath }
    } catch (error) {
      if (isFileExistsError(error)) continue
      throw error
    }
  }

  throw new Error(`Could not allocate upload filename: ${safeFilename}`)
}

// Builds renderer-safe attachment metadata from a trusted managed file on disk.
const createUploadedAttachment = async (
  input: CreateAttachmentInput
): Promise<UploadedAttachment> => ({
  id: input.id,
  sessionId: input.sessionId,
  name: input.filename,
  originalName: input.originalName,
  path: input.filePath,
  mimeType: input.mimeType,
  size: (await stat(input.filePath)).size
})

export {
  STAGING_UPLOAD_SESSION_ID,
  UPLOADS_DIR,
  assertPathInsideRoot,
  assertSafePathSegment,
  createUploadedAttachment,
  getSessionUploadDir,
  getUploadRoot,
  isFileExistsError,
  isMissingFileError,
  moveToUniqueUploadFile,
  toSafeUploadFilename
}
