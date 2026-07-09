import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  ArtifactFile,
  ArtifactPreviewResult,
  ListPendingRunArtifactsRequest,
  ListProjectMessageArtifactsRequest,
  MovePendingRunArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  WritePendingArtifactFileRequest
} from '../../shared/artifacts'
import { readBoundedManagedFilePreview } from '../managed-file-preview'

const ARTIFACTS_DIR = 'artifacts'
const PENDING_DIR = '.pending'
const METADATA_DIR = '.metadata'
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type ArtifactMetadata = {
  mimeType?: string
}

type ArtifactRepositoryWriteOptions = {
  allowedImportRoots?: string[]
}

// Accepts only path segments that cannot escape the managed artifact layout.
const assertSafePathSegment = (segment: string): string => {
  if (typeof segment !== 'string') {
    throw new Error('Invalid artifact path segment')
  }

  if (!SAFE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid artifact path segment: ${segment}`)
  }

  return segment
}

// Allows display-friendly filenames while rejecting separators, reserved metadata names, and shell-hostile input.
const assertSafeFilename = (filename: string): string => {
  if (
    filename.length === 0 ||
    filename !== basename(filename) ||
    filename === '.' ||
    filename === '..' ||
    filename === METADATA_DIR ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes(':') ||
    hasControlCharacter(filename)
  ) {
    throw new Error(`Invalid artifact filename: ${filename}`)
  }

  return filename
}

// Keeps artifact references stable within the session/message or session/run owner that produced them.
const createArtifactId = (sessionId: string, ownerId: string, filename: string): string =>
  `${sessionId}:${ownerId}:${filename}`

// Stores per-file metadata outside the user-visible file list without changing artifact filenames.
const getArtifactMetadataPath = (directory: string, filename: string): string =>
  join(directory, METADATA_DIR, `${encodeURIComponent(filename)}.json`)

// Rejects filenames that would be invisible or unsafe in common filesystem UIs.
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)

    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })

// Resolves the root directory for one logical project under the app persistence root.
const getProjectArtifactDir = (storageRoot: string, projectName: string): string =>
  join(storageRoot, ARTIFACTS_DIR, assertSafePathSegment(projectName))

// Guards renderer-open requests against both relative traversal and absolute-path escape.
const assertPathInsideArtifactRoot = (artifactRoot: string, filePath: string): void => {
  const relativePath = relative(artifactRoot, filePath)

  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Artifact file is outside artifact storage.')
  }
  if (isAbsolute(relativePath)) {
    throw new Error('Artifact file is outside artifact storage.')
  }
}

const isPathInsideRoot = (root: string, filePath: string): boolean => {
  const relativePath = relative(root, filePath)

  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
    ? !isAbsolute(relativePath)
    : false
}

const resolveAllowedImportFilePath = async (
  filePath: string,
  allowedImportRoots: string[]
): Promise<string> => {
  if (allowedImportRoots.length === 0) {
    throw new Error('Artifact local source path is outside allowed artifact import roots.')
  }

  const resolvedFilePath = await realpath(resolve(filePath))
  const resolvedRoots = (
    await Promise.all(
      allowedImportRoots.map(async (root) => {
        try {
          return await realpath(resolve(root))
        } catch (error) {
          if (isMissingFileError(error)) return undefined
          throw error
        }
      })
    )
  ).filter((root): root is string => typeof root === 'string')
  const isAllowed = resolvedRoots.some((root) => isPathInsideRoot(root, resolvedFilePath))

  if (!isAllowed) {
    throw new Error('Artifact local source path is outside allowed artifact import roots.')
  }

  const fileStat = await stat(resolvedFilePath)

  if (!fileStat.isFile()) {
    throw new Error('Artifact local source path is not a file.')
  }

  return resolvedFilePath
}

// Gives the MCP tool a small run-context file to read without trusting model-supplied ids.
const getArtifactCurrentRunFilePath = (
  storageRoot: string,
  projectName: string,
  sessionId: string
): string =>
  join(
    getProjectArtifactDir(storageRoot, projectName),
    assertSafePathSegment(sessionId),
    PENDING_DIR,
    'current-run.json'
  )

// Owns app-managed artifact paths so callers never concatenate user-controlled segments.
class ArtifactRepository {
  constructor(private readonly storageRoot: string) {}

  // Writes a generated file into the run's pending directory before it is attached to a message.
  async writePendingFile(
    request: WritePendingArtifactFileRequest,
    options: ArtifactRepositoryWriteOptions = {}
  ): Promise<ArtifactFile> {
    const projectName = assertSafePathSegment(request.projectName)
    const sessionId = assertSafePathSegment(request.sessionId)
    const runId = assertSafePathSegment(request.runId)
    const filename = assertSafeFilename(request.filename)
    const directory = this.getPendingRunDir(projectName, sessionId, runId)
    const filePath = join(directory, filename)
    const temporaryPath = `${filePath}.${Date.now()}-${randomUUID()}.tmp`

    await mkdir(directory, { recursive: true })

    try {
      if (request.source.kind === 'localPath') {
        const sourcePath = await resolveAllowedImportFilePath(
          request.source.path,
          options.allowedImportRoots ?? []
        )

        await copyFile(sourcePath, temporaryPath)
      } else {
        await writeFile(
          temporaryPath,
          request.source.encoding === 'base64'
            ? Buffer.from(request.source.content, 'base64')
            : Buffer.from(request.source.content, 'utf8')
        )
      }

      await rename(temporaryPath, filePath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }

    await this.writeArtifactMetadata(directory, filename, {
      mimeType: request.mimeType
    })

    return this.createArtifactFile({
      projectName,
      sessionId,
      runId,
      filename,
      filePath,
      mimeType: request.mimeType
    })
  }

  // Moves all pending run files into the final message directory and returns the message file list.
  async finalizeRunArtifacts(request: MovePendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    const projectName = assertSafePathSegment(request.projectName)
    const sessionId = assertSafePathSegment(request.sessionId)
    const sourceSessionId = assertSafePathSegment(request.sourceSessionId ?? request.sessionId)
    const runId = assertSafePathSegment(request.runId)
    const messageId = assertSafePathSegment(request.messageId)
    const pendingDir = this.getPendingRunDir(projectName, sourceSessionId, runId)
    const messageDir = this.getMessageDir(projectName, sessionId, messageId)
    const entries = await this.readFileEntries(pendingDir)

    if (entries.length === 0) {
      // A repeated finalize may find files already moved; recover metadata and return the final state.
      await this.recoverMovedArtifactMetadata(pendingDir, messageDir)
      await rm(pendingDir, { recursive: true, force: true })
      return this.listMessageFiles({ projectName, sessionId, messageId })
    }

    await mkdir(messageDir, { recursive: true })

    for (const entry of entries) {
      await rename(join(pendingDir, entry.name), join(messageDir, entry.name))
      await this.moveArtifactMetadata(pendingDir, messageDir, entry.name)
    }

    await this.recoverMovedArtifactMetadata(pendingDir, messageDir)
    await rm(pendingDir, { recursive: true, force: true })

    return this.listMessageFiles({ projectName, sessionId, messageId })
  }

  // Lists files that have been written by the agent but not yet owned by a renderer message.
  async listPendingRunFiles(request: ListPendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    const projectName = assertSafePathSegment(request.projectName)
    const sessionId = assertSafePathSegment(request.sessionId)
    const runId = assertSafePathSegment(request.runId)
    const pendingDir = this.getPendingRunDir(projectName, sessionId, runId)
    const entries = await this.readFileEntries(pendingDir)

    return Promise.all(
      entries.map(async (entry) => {
        const metadata = await this.readArtifactMetadata(pendingDir, entry.name)

        return this.createArtifactFile({
          projectName,
          sessionId,
          runId,
          filename: entry.name,
          filePath: join(pendingDir, entry.name),
          mimeType: metadata.mimeType
        })
      })
    )
  }

  // Lists finalized artifacts for one message in renderer-friendly display order.
  async listMessageFiles(request: ListProjectMessageArtifactsRequest): Promise<ArtifactFile[]> {
    const projectName = assertSafePathSegment(request.projectName)
    const sessionId = assertSafePathSegment(request.sessionId)
    const messageId = assertSafePathSegment(request.messageId)
    const messageDir = this.getMessageDir(projectName, sessionId, messageId)
    const entries = await this.readFileEntries(messageDir)

    return Promise.all(
      entries.map(async (entry) => {
        const metadata = await this.readArtifactMetadata(messageDir, entry.name)

        return this.createArtifactFile({
          projectName,
          sessionId,
          messageId,
          filename: entry.name,
          filePath: join(messageDir, entry.name),
          mimeType: metadata.mimeType
        })
      })
    )
  }

  // Resolves a renderer-provided artifact path only after canonical root and symlink checks pass.
  async resolveManagedFilePath(request: OpenArtifactFileRequest): Promise<string> {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.path !== 'string' ||
      request.path.trim().length === 0
    ) {
      throw new Error('Invalid artifact file path.')
    }

    const artifactRoot = resolve(this.storageRoot, ARTIFACTS_DIR)
    const requestedPath = resolve(request.path)

    assertPathInsideArtifactRoot(artifactRoot, requestedPath)

    const resolvedArtifactRoot = await realpath(artifactRoot)
    const resolvedFilePath = await realpath(requestedPath)

    assertPathInsideArtifactRoot(resolvedArtifactRoot, resolvedFilePath)

    const fileStat = await stat(resolvedFilePath)

    if (!fileStat.isFile()) {
      throw new Error('Artifact path is not a file.')
    }

    return resolvedFilePath
  }

  // Reads a small text preview from a managed artifact without exposing arbitrary filesystem reads.
  async readManagedFilePreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    const filePath = await this.resolveManagedFilePath(request)
    return readBoundedManagedFilePreview(filePath, request, 'Invalid artifact preview encoding.')
  }

  // Builds the temporary directory for files generated during one active assistant turn.
  private getPendingRunDir(projectName: string, sessionId: string, runId: string): string {
    return join(getProjectArtifactDir(this.storageRoot, projectName), sessionId, PENDING_DIR, runId)
  }

  // Builds the durable directory displayed under one completed assistant message.
  private getMessageDir(projectName: string, sessionId: string, messageId: string): string {
    return join(getProjectArtifactDir(this.storageRoot, projectName), sessionId, messageId)
  }

  // Reads only direct files, returning an empty list when an artifact directory does not exist yet.
  private async readFileEntries(directory: string): Promise<Array<{ name: string }>> {
    try {
      const entries = await readdir(directory, { withFileTypes: true })

      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => ({ name: entry.name }))
        .sort((left, right) => left.name.localeCompare(right.name))
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }
  }

  // Persists optional metadata separately so artifact bytes remain exactly what the agent wrote.
  private async writeArtifactMetadata(
    directory: string,
    filename: string,
    metadata: ArtifactMetadata
  ): Promise<void> {
    if (!metadata.mimeType) return

    const metadataDirectory = join(directory, METADATA_DIR)

    await mkdir(metadataDirectory, { recursive: true })
    await writeFile(
      getArtifactMetadataPath(directory, filename),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8'
    )
  }

  // Reads trusted metadata written by this repository while tolerating older files without metadata.
  private async readArtifactMetadata(
    directory: string,
    filename: string
  ): Promise<ArtifactMetadata> {
    try {
      const rawMetadata = await readFile(getArtifactMetadataPath(directory, filename), 'utf8')
      const metadata = JSON.parse(rawMetadata) as unknown

      if (
        typeof metadata === 'object' &&
        metadata !== null &&
        'mimeType' in metadata &&
        typeof (metadata as { mimeType?: unknown }).mimeType === 'string'
      ) {
        return { mimeType: (metadata as { mimeType: string }).mimeType }
      }

      return {}
    } catch (error) {
      if (isMissingFileError(error)) return {}
      throw error
    }
  }

  // Moves sidecar metadata with its artifact file and ignores absent metadata for older artifacts.
  private async moveArtifactMetadata(
    sourceDirectory: string,
    targetDirectory: string,
    filename: string
  ): Promise<void> {
    try {
      await mkdir(join(targetDirectory, METADATA_DIR), { recursive: true })
      await rename(
        getArtifactMetadataPath(sourceDirectory, filename),
        getArtifactMetadataPath(targetDirectory, filename)
      )
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
  }

  // Completes metadata moves after interrupted or replayed finalization attempts.
  private async recoverMovedArtifactMetadata(
    sourceDirectory: string,
    targetDirectory: string
  ): Promise<void> {
    const entries = await this.readFileEntries(targetDirectory)

    await Promise.all(
      entries.map((entry) =>
        this.moveArtifactMetadata(sourceDirectory, targetDirectory, entry.name)
      )
    )
  }

  // Materializes filesystem state into the shared ArtifactFile DTO used by IPC and persistence.
  private async createArtifactFile({
    projectName,
    sessionId,
    filename,
    filePath,
    mimeType,
    messageId,
    runId
  }: {
    projectName: string
    sessionId: string
    filename: string
    filePath: string
    mimeType?: string
    messageId?: string
    runId?: string
  }): Promise<ArtifactFile> {
    const fileStat = await stat(filePath)
    const ownerId = messageId ?? runId ?? 'artifact'

    return {
      id: createArtifactId(sessionId, ownerId, filename),
      projectName,
      sessionId,
      messageId,
      runId,
      name: filename,
      path: filePath,
      fileUrl: pathToFileURL(filePath).href,
      mimeType,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    }
  }
}

// Treats missing directories and optional sidecars as empty state rather than hard failures.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

export { ArtifactRepository, getArtifactCurrentRunFilePath, getProjectArtifactDir }
