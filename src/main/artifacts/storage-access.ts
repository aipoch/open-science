import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ArtifactDurability } from './durability'
import type {
  ArtifactMetadata,
  ArtifactPublicationStorage,
  PendingArtifactVersionRouting
} from './publication-types'
import {
  ARTIFACTS_DIR,
  CURRENT_RUN_FILE,
  METADATA_DIR,
  PENDING_DIR,
  SAFE_SEGMENT_PATTERN
} from './storage-layout'

type ArtifactStorageAccessDurability = ArtifactDurability & {
  readMarkerFile?: (path: string) => Promise<string>
}

const LEGACY_EXECUTION_HANDOFF_DIR = 'executions'
const LEGACY_EXECUTION_HANDOFF_FILE_PATTERN = /^artifact-run-\d+-\d+\.json$/

const assertSafePathSegment = (segment: string): string => {
  if (typeof segment !== 'string') throw new Error('Invalid artifact path segment')
  if (!SAFE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid artifact path segment: ${segment}`)
  }
  return segment
}

const normalizeArtifactVersionIds = (versionIds: readonly string[]): string[] => {
  if (!Array.isArray(versionIds) || versionIds.length === 0) {
    throw new Error('Artifact run marker requires Artifact Version ids.')
  }
  const normalized = versionIds
    .map(assertSafePathSegment)
    .sort((left, right) => left.localeCompare(right))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Artifact run marker Artifact Version ids must be unique.')
  }
  return normalized
}

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })

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

const getArtifactMetadataPath = (directory: string, filename: string): string =>
  join(directory, METADATA_DIR, `${encodeURIComponent(filename)}.json`)

const getProjectArtifactDir = (storageRoot: string, projectId: string): string =>
  join(storageRoot, ARTIFACTS_DIR, assertSafePathSegment(projectId))

const getArtifactCurrentRunFilePath = (
  storageRoot: string,
  projectId: string,
  sessionId: string
): string =>
  join(
    getProjectArtifactDir(storageRoot, projectId),
    assertSafePathSegment(sessionId),
    PENDING_DIR,
    CURRENT_RUN_FILE
  )

const assertPathInsideArtifactRoot = (artifactRoot: string, filePath: string): void => {
  const relativePath = relative(artifactRoot, filePath)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Artifact file is outside artifact storage.')
  }
  if (isAbsolute(relativePath)) throw new Error('Artifact file is outside artifact storage.')
}

const isPathInsideRoot = (root: string, filePath: string): boolean => {
  const relativePath = relative(root, filePath)
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
    ? !isAbsolute(relativePath)
    : false
}

const readFilePrefix = async (path: string, maxBytes = 512): Promise<Buffer> => {
  const handle = await open(path, 'r')
  try {
    const sample = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    return sample.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const importRootsError = (filePath: string, allowedImportRoots: string[]): Error => {
  const guidance =
    allowedImportRoots.length > 0
      ? ` Write the file under one of these directories and pass that path, or use inline content instead: ${allowedImportRoots.join(', ')}`
      : ' No import roots are configured; use inline content instead.'
  return new Error(
    `Artifact local source path is outside allowed artifact import roots (got "${filePath}").${guidance}`
  )
}

const resolveAllowedImportFilePath = async (
  filePath: string,
  allowedImportRoots: string[],
  relativeBaseDirs: string[] = []
): Promise<string> => {
  if (allowedImportRoots.length === 0) throw importRootsError(filePath, allowedImportRoots)
  if (relativeBaseDirs.length === 0 && !isAbsolute(filePath)) {
    throw new Error(
      `Artifact local source path does not exist: "${filePath}". A relative path resolves against the notebook session data dir or the session workspace, but this turn carries neither — pass an absolute path to the already-saved file instead.`
    )
  }
  const candidates = isAbsolute(filePath)
    ? [resolve(filePath)]
    : relativeBaseDirs.map((baseDir) => resolve(baseDir, filePath))
  let resolvedFilePath: string | undefined
  for (const candidate of candidates) {
    try {
      resolvedFilePath = await realpath(candidate)
      break
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  if (!resolvedFilePath) {
    throw new Error(
      `Artifact local source path does not exist: "${filePath}". Save the file to disk (inside the notebook session workspace) before calling write_artifact_file, pass an absolute path to an already-saved file, or use inline content instead.`
    )
  }
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
  if (!resolvedRoots.some((root) => isPathInsideRoot(root, resolvedFilePath))) {
    throw importRootsError(filePath, allowedImportRoots)
  }
  if (!(await stat(resolvedFilePath)).isFile()) {
    throw new Error('Artifact local source path is not a file.')
  }
  return resolvedFilePath
}

class ArtifactStorageAccess {
  constructor(
    readonly storageRoot: string,
    readonly durability: ArtifactStorageAccessDurability
  ) {}

  getProjectArtifactDir(projectId: string): string {
    return getProjectArtifactDir(this.storageRoot, projectId)
  }

  getPendingRunDir(projectId: string, sessionId: string, runId: string): string {
    return join(this.getProjectArtifactDir(projectId), sessionId, PENDING_DIR, runId)
  }

  getMessageDir(projectId: string, sessionId: string, messageId: string): string {
    return join(this.getProjectArtifactDir(projectId), sessionId, messageId)
  }

  async renameIfPresent(sourcePath: string, targetPath: string): Promise<boolean> {
    try {
      await rename(sourcePath, targetPath)
      return true
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  async readSubdirectoryNames(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }
  }

  async readFileEntries(directory: string): Promise<Array<{ name: string }>> {
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

  isPendingArtifactRunDirectory(name: string): boolean {
    return name !== LEGACY_EXECUTION_HANDOFF_DIR && SAFE_SEGMENT_PATTERN.test(name)
  }

  async cleanupLegacyExecutionHandoffs(directory: string): Promise<void> {
    for (const entry of await this.readFileEntries(directory)) {
      if (!LEGACY_EXECUTION_HANDOFF_FILE_PATTERN.test(entry.name)) continue
      const path = join(directory, entry.name)
      let value: unknown
      try {
        value = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        continue
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length !== 0
      ) {
        continue
      }
      await rm(path, { force: true })
    }
    await rmdir(directory).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ((error as { code?: unknown }).code === 'ENOENT' ||
          (error as { code?: unknown }).code === 'ENOTEMPTY')
      ) {
        return
      }
      throw error
    })
  }

  async writeArtifactMetadata(
    directory: string,
    filename: string,
    metadata: ArtifactMetadata
  ): Promise<void> {
    if (Object.values(metadata).every((value) => value === undefined)) return
    const metadataDirectory = join(directory, METADATA_DIR)
    await mkdir(metadataDirectory, { recursive: true })
    await this.durability.syncDirectory(directory)
    const path = getArtifactMetadataPath(directory, filename)
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
      await this.durability.syncFile(temporaryPath)
      await rename(temporaryPath, path)
      await this.durability.syncDirectory(metadataDirectory)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async readArtifactMetadata(directory: string, filename: string): Promise<ArtifactMetadata> {
    try {
      const metadata = JSON.parse(
        await readFile(getArtifactMetadataPath(directory, filename), 'utf8')
      ) as unknown
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return {}
      const value = metadata as Record<string, unknown>
      return {
        ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
        ...(typeof value.artifactId === 'string' ? { artifactId: value.artifactId } : {}),
        ...(typeof value.versionId === 'string' ? { versionId: value.versionId } : {}),
        ...(Number.isSafeInteger(value.versionNumber)
          ? { versionNumber: value.versionNumber as number }
          : {}),
        ...(typeof value.artifactRunId === 'string' ? { artifactRunId: value.artifactRunId } : {}),
        ...(typeof value.checksum === 'string' ? { checksum: value.checksum } : {}),
        ...(value.kind === 'plan' ? { kind: value.kind } : {})
      }
    } catch (error) {
      if (isMissingFileError(error)) return {}
      throw error
    }
  }

  toPendingRouting(metadata: ArtifactMetadata): PendingArtifactVersionRouting | undefined {
    if (
      !metadata.artifactId ||
      !SAFE_SEGMENT_PATTERN.test(metadata.artifactId) ||
      !metadata.versionId ||
      !SAFE_SEGMENT_PATTERN.test(metadata.versionId) ||
      !metadata.artifactRunId ||
      !SAFE_SEGMENT_PATTERN.test(metadata.artifactRunId) ||
      !Number.isSafeInteger(metadata.versionNumber) ||
      metadata.versionNumber! < 1 ||
      !metadata.checksum ||
      !/^[a-f0-9]{64}$/.test(metadata.checksum)
    ) {
      return undefined
    }
    return {
      artifactId: metadata.artifactId,
      versionId: metadata.versionId,
      versionNumber: metadata.versionNumber!,
      artifactRunId: metadata.artifactRunId,
      checksum: metadata.checksum,
      ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {})
    }
  }

  async moveArtifactMetadata(
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

  async recoverMovedArtifactMetadata(
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

  async createArtifactFile(request: {
    projectId: string
    sessionId: string
    filename: string
    filePath: string
    mimeType?: string
    metadata?: ArtifactMetadata
    messageId?: string
    runId?: string
  }): Promise<ArtifactFile> {
    const fileStat = await stat(request.filePath)
    const ownerId = request.messageId ?? request.runId ?? 'artifact'
    return {
      id: `${request.sessionId}:${ownerId}:${request.filename}`,
      projectId: request.projectId,
      sessionId: request.sessionId,
      messageId: request.messageId,
      runId: request.runId,
      name: request.filename,
      path: request.filePath,
      fileUrl: pathToFileURL(request.filePath).href,
      mimeType: request.metadata?.mimeType ?? request.mimeType,
      artifactId: request.metadata?.artifactId,
      versionId: request.metadata?.versionId,
      versionNumber: request.metadata?.versionNumber,
      checksum: request.metadata?.checksum,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    }
  }
}

const createArtifactPublicationStorage = (
  access: ArtifactStorageAccess,
  listMessageFiles: ArtifactPublicationStorage['listMessageFiles']
): ArtifactPublicationStorage => ({
  durability: access.durability,
  assertSafePathSegment,
  assertSafeFilename,
  normalizeArtifactVersionIds,
  getProjectArtifactDir: (projectId) => access.getProjectArtifactDir(projectId),
  getPendingRunDir: (projectId, sessionId, runId) =>
    access.getPendingRunDir(projectId, sessionId, runId),
  getMessageDir: (projectId, sessionId, messageId) =>
    access.getMessageDir(projectId, sessionId, messageId),
  getArtifactMetadataPath,
  resolveAllowedImportFilePath,
  readFilePrefix,
  renameIfPresent: (sourcePath, targetPath) => access.renameIfPresent(sourcePath, targetPath),
  readSubdirectoryNames: (directory) => access.readSubdirectoryNames(directory),
  readFileEntries: (directory) => access.readFileEntries(directory),
  isPendingArtifactRunDirectory: (name) => access.isPendingArtifactRunDirectory(name),
  cleanupLegacyExecutionHandoffs: (directory) => access.cleanupLegacyExecutionHandoffs(directory),
  readArtifactMetadata: (directory, filename) => access.readArtifactMetadata(directory, filename),
  writeArtifactMetadata: (directory, filename, metadata) =>
    access.writeArtifactMetadata(directory, filename, metadata),
  toPendingRouting: (metadata) => access.toPendingRouting(metadata),
  moveArtifactMetadata: (sourceDirectory, targetDirectory, filename) =>
    access.moveArtifactMetadata(sourceDirectory, targetDirectory, filename),
  recoverMovedArtifactMetadata: (sourceDirectory, targetDirectory) =>
    access.recoverMovedArtifactMetadata(sourceDirectory, targetDirectory),
  createArtifactFile: (request) => access.createArtifactFile(request),
  listMessageFiles,
  sha256,
  isMissingFileError
})

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

export {
  ArtifactStorageAccess,
  assertPathInsideArtifactRoot,
  assertSafePathSegment,
  createArtifactPublicationStorage,
  getArtifactCurrentRunFilePath,
  getProjectArtifactDir,
  isMissingFileError,
  isPathInsideRoot
}
export type { ArtifactStorageAccessDurability }
