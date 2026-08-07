import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  ArtifactFile,
  ArtifactPreviewResult,
  ArtifactSourceFileObservation,
  ListPendingRunArtifactsRequest,
  ListProjectMessageArtifactsRequest,
  MovePendingRunArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  WritePendingArtifactFileRequest
} from '../../shared/artifacts'
import { readBoundedManagedFilePreview } from '../managed-file-preview'
import {
  defaultArtifactDurability,
  type ArtifactDurability as ArtifactRepositoryDurability
} from './durability'
import {
  ArtifactCompatibilityScanIncompleteError,
  ArtifactPublicationOwner,
  type ArtifactRunFinalizationMarker,
  type BindPendingArtifactVersionRouting,
  type PendingArtifactRunPublication,
  type PendingArtifactVersionRoute,
  type PendingArtifactVersionRouting,
  type PendingArtifactVersionRoutingRequest,
  type PrepareArtifactRunFinalizationRequest
} from './publication-owner'
import {
  ARTIFACTS_DIR,
  CURRENT_RUN_FILE,
  METADATA_DIR,
  PENDING_DIR,
  SAFE_SEGMENT_PATTERN
} from './storage-layout'

type ArtifactMetadata = {
  mimeType?: string
  artifactId?: string
  versionId?: string
  versionNumber?: number
  artifactRunId?: string
  checksum?: string
  kind?: 'plan'
}

type ArtifactRepositoryWriteOptions = {
  allowedImportRoots?: string[]
  // Ordered base directories a RELATIVE localPath is resolved against — the notebook kernel's cwd
  // (the session data dir) first, then the session workspace. Lets the agent pass the same bare
  // filename it saved (e.g. "plot.png") whether it saved through the kernel or with plain shell
  // tools; the first base where the file EXISTS wins. Absolute paths ignore these. With no bases a
  // relative path is REJECTED — it is never resolved against the process cwd.
  relativeBaseDirs?: string[]
}

type ArtifactRepositoryStorage = ArtifactRepositoryDurability & {
  readMarkerFile?: (path: string) => Promise<string>
}

export type { ArtifactRepositoryDurability }

const defaultArtifactRepositoryDurability = defaultArtifactDurability

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

// Builds an actionable rejection: name the allowed roots so the agent can re-save the file inside one
// of them (e.g. the notebook session workspace) or fall back to inline content, instead of retrying
// blindly against a path outside the sandbox (e.g. /tmp).
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
  if (allowedImportRoots.length === 0) {
    throw importRootsError(filePath, allowedImportRoots)
  }

  // A relative path with no base dir must NOT fall back to path.resolve's default (the process cwd):
  // the HTTP MCP host runs inside the app process, whose cwd is not the session workspace, so the
  // file would report "does not exist" even when it sits inside an allowed root — or worse, pick up
  // an unrelated same-named file under cwd. Reject and ask for an absolute path instead.
  if (relativeBaseDirs.length === 0 && !isAbsolute(filePath)) {
    throw new Error(
      `Artifact local source path does not exist: "${filePath}". A relative path resolves against the notebook session data dir or the session workspace, but this turn carries neither — pass an absolute path to the already-saved file instead.`
    )
  }

  // Resolve a relative path against the turn's base dirs in order — the notebook data dir (the
  // kernel's cwd) first, then the session workspace — taking the first candidate that EXISTS, so a
  // bare "plot.png" points at the file the agent just saved wherever it saved it, never at the MCP
  // process's own cwd. An absolute path skips the bases entirely.
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
  const isAllowed = resolvedRoots.some((root) => isPathInsideRoot(root, resolvedFilePath))

  if (!isAllowed) {
    throw importRootsError(filePath, allowedImportRoots)
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
    CURRENT_RUN_FILE
  )

// Owns app-managed artifact paths so callers never concatenate user-controlled segments.
class ArtifactRepository {
  private readonly publicationOwner: ArtifactPublicationOwner

  constructor(
    private readonly storageRoot: string,
    private readonly durability: ArtifactRepositoryStorage = defaultArtifactRepositoryDurability
  ) {
    this.publicationOwner = new ArtifactPublicationOwner({
      durability,
      assertSafePathSegment,
      assertSafeFilename,
      normalizeArtifactVersionIds,
      getProjectArtifactDir: (projectName) => getProjectArtifactDir(storageRoot, projectName),
      getPendingRunDir: (projectName, sessionId, runId) =>
        this.getPendingRunDir(projectName, sessionId, runId),
      getMessageDir: (projectName, sessionId, messageId) =>
        this.getMessageDir(projectName, sessionId, messageId),
      getArtifactMetadataPath,
      resolveAllowedImportFilePath,
      readFilePrefix,
      renameIfPresent: (sourcePath, targetPath) => this.renameIfPresent(sourcePath, targetPath),
      readSubdirectoryNames: (directory) => this.readSubdirectoryNames(directory),
      readFileEntries: (directory) => this.readFileEntries(directory),
      readArtifactMetadata: (directory, filename) => this.readArtifactMetadata(directory, filename),
      writeArtifactMetadata: (directory, filename, metadata) =>
        this.writeArtifactMetadata(directory, filename, metadata),
      toPendingRouting: (metadata) => this.toPendingRouting(metadata),
      moveArtifactMetadata: (sourceDirectory, targetDirectory, filename) =>
        this.moveArtifactMetadata(sourceDirectory, targetDirectory, filename),
      recoverMovedArtifactMetadata: (sourceDirectory, targetDirectory) =>
        this.recoverMovedArtifactMetadata(sourceDirectory, targetDirectory),
      createArtifactFile: (request) => this.createArtifactFile(request),
      listMessageFiles: (request) => this.listMessageFiles(request),
      sha256,
      isMissingFileError
    })
  }

  async writePendingFile(
    request: WritePendingArtifactFileRequest,
    options: ArtifactRepositoryWriteOptions = {}
  ): Promise<ArtifactFile> {
    return this.publicationOwner.writePendingFile(request, options)
  }

  async ensurePendingVersionRouting(request: PendingArtifactVersionRoutingRequest): Promise<void> {
    return this.publicationOwner.ensurePendingVersionRouting(request)
  }

  async findPendingVersionRouting(request: {
    projectName: string
    artifactId: string
    versionId: string
  }): Promise<PendingArtifactVersionRoute | undefined> {
    return this.publicationOwner.findPendingVersionRouting(request)
  }

  async findPendingFileForRun(request: {
    projectName: string
    runId: string
    filename: string
    checksum: string
  }): Promise<{ storageSessionId: string; path: string } | undefined> {
    return this.publicationOwner.findPendingFileForRun(request)
  }

  async withPendingFileTransaction<Result>(
    request: WritePendingArtifactFileRequest,
    options: ArtifactRepositoryWriteOptions,
    operation: (
      artifact: ArtifactFile,
      sourceFileObservation: ArtifactSourceFileObservation | undefined,
      bindVersionRouting: BindPendingArtifactVersionRouting
    ) => Promise<Result>
  ): Promise<Result> {
    return this.publicationOwner.withPendingFileTransaction(request, options, operation)
  }

  private async renameIfPresent(sourcePath: string, targetPath: string): Promise<boolean> {
    try {
      await rename(sourcePath, targetPath)
      return true
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  async finalizeRunArtifacts(request: MovePendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    return this.publicationOwner.finalizeRunArtifacts(request)
  }

  async prepareRunFinalization(request: PrepareArtifactRunFinalizationRequest): Promise<void> {
    return this.publicationOwner.prepareRunFinalization(request)
  }

  async listPendingRunFiles(request: ListPendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    return this.publicationOwner.listPendingRunFiles(request)
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
          metadata
        })
      })
    )
  }

  async reconcilePendingArtifactPaths(request: {
    projectName: string
    sessionId: string
    messageId: string
    pendingPaths: string[]
  }): Promise<ArtifactFile[]> {
    return this.publicationOwner.reconcilePendingArtifactPaths(request)
  }

  // Enumerates every artifact on disk for one project, across all sessions — finalized files under
  // message directories, plus files a crashed turn left behind in `.pending/<run>/` with no owning
  // message (which startup reconciliation cannot claim). Skips sidecar metadata and the current-run
  // handoff. Used to surface orphaned artifacts whose owning session/message no longer exists, so a
  // delete or a mid-turn crash never strands files that the user was promised would remain.
  //
  // `activeRunIds` are the runs of turns the caller knows are IN FLIGHT right now (from live runtime
  // state, not the persisted current-run.json handoff — that file survives a crash and would then hide
  // the crashed run's files forever). Their pending files are still being written, so they are excluded
  // from the orphan list; every other pending run is a crashed/ownerless run and is surfaced.
  async listProjectArtifacts(
    projectName: string,
    activeRunIds: ReadonlySet<string> = new Set()
  ): Promise<ArtifactFile[]> {
    const project = assertSafePathSegment(projectName)
    const projectDir = getProjectArtifactDir(this.storageRoot, project)
    const files: ArtifactFile[] = []

    // Session and message dirs use safe segments; the pattern also skips the `.pending`/`.metadata`
    // dot-directories, so only real session/message directories are traversed here.
    for (const sessionId of await this.readSubdirectoryNames(projectDir)) {
      if (!SAFE_SEGMENT_PATTERN.test(sessionId)) continue
      const sessionDir = join(projectDir, sessionId)

      for (const messageId of await this.readSubdirectoryNames(sessionDir)) {
        if (!SAFE_SEGMENT_PATTERN.test(messageId)) continue
        const messageDir = join(sessionDir, messageId)

        for (const entry of await this.readFileEntries(messageDir)) {
          const metadata = await this.readArtifactMetadata(messageDir, entry.name)

          files.push(
            await this.createArtifactFile({
              projectName: project,
              sessionId,
              messageId,
              filename: entry.name,
              filePath: join(messageDir, entry.name),
              mimeType: metadata.mimeType
            })
          )
        }
      }

      // Ownerless pending files: a turn that crashed before the renderer attached its artifacts leaves
      // files here with no message to reconcile against, so surface them rather than hide them forever.
      // Only `.pending/<run>/` subdirectories hold artifacts; the `current-run.json` handoff is a plain
      // file and is skipped by the subdirectory walk. A run the caller reports as in-flight is skipped
      // (its files are mid-write and will finalize into a message shortly); a crashed run is NOT in that
      // live set, so its leftover files correctly surface as orphans.
      const pendingDir = join(sessionDir, PENDING_DIR)
      for (const runId of await this.readSubdirectoryNames(pendingDir)) {
        if (!SAFE_SEGMENT_PATTERN.test(runId)) continue
        if (activeRunIds.has(runId)) continue
        const runDir = join(pendingDir, runId)

        for (const entry of await this.readFileEntries(runDir)) {
          const metadata = await this.readArtifactMetadata(runDir, entry.name)

          files.push(
            await this.createArtifactFile({
              projectName: project,
              sessionId,
              runId,
              filename: entry.name,
              filePath: join(runDir, entry.name),
              mimeType: metadata.mimeType
            })
          )
        }
      }
    }

    return files
  }

  async listPendingRunPublications(projectName: string): Promise<PendingArtifactRunPublication[]> {
    return this.publicationOwner.listPendingRunPublications(projectName)
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
    let resolvedFilePath: string
    try {
      resolvedFilePath = await realpath(requestedPath)
    } catch (error) {
      // A preview/open can hold a `.pending/<run>/<file>` path that finalizeRunArtifacts has already
      // moved to `<session>/<messageId>/<file>`. Recover the finalized copy so the pending->message
      // transition does not surface as a spurious ENOENT.
      if (!isMissingFileError(error)) throw error
      const recovered = await this.recoverFinalizedPendingPath(requestedPath)
      if (!recovered) throw error
      resolvedFilePath = await realpath(recovered)
    }

    assertPathInsideArtifactRoot(resolvedArtifactRoot, resolvedFilePath)

    const fileStat = await stat(resolvedFilePath)

    if (!fileStat.isFile()) {
      throw new Error('Artifact path is not a file.')
    }

    return resolvedFilePath
  }

  // resolveManagedFilePath additionally bound to one project/session subtree: an artifact record
  // may only resolve to a file under its own declaring session, so a stale or crafted record (or a
  // symlink inside the artifact root) cannot pull another session's or project's files into an
  // export. Throws when the real path escapes that subtree.
  async resolveSessionArtifactFilePath(
    projectName: string,
    sessionId: string,
    path: string
  ): Promise<string> {
    const resolvedFilePath = await this.resolveManagedFilePath({ path })
    const sessionRoot = join(getProjectArtifactDir(this.storageRoot, projectName), sessionId)

    let resolvedSessionRoot: string
    try {
      resolvedSessionRoot = await realpath(sessionRoot)
    } catch {
      throw new Error('Artifact file is outside the declaring session.')
    }

    if (!isPathInsideRoot(resolvedSessionRoot, resolvedFilePath)) {
      throw new Error('Artifact file is outside the declaring session.')
    }

    return resolvedFilePath
  }

  private recoverFinalizedPendingPath(requestedPath: string): Promise<string | undefined> {
    return this.publicationOwner.recoverFinalizedPendingPath(requestedPath)
  }

  // Reads a small text preview from a managed artifact without exposing arbitrary filesystem reads.
  async readManagedFilePreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    const filePath = await this.resolveManagedFilePath(request)
    return readBoundedManagedFilePreview(filePath, request, 'Invalid artifact preview encoding.')
  }

  async findRunFinalizationMarker(
    projectName: string,
    runId: string
  ): Promise<(ArtifactRunFinalizationMarker & { sourceSessionId: string }) | undefined> {
    return this.publicationOwner.findRunFinalizationMarker(projectName, runId)
  }

  // Builds the temporary directory for files generated during one active assistant turn.
  private getPendingRunDir(projectName: string, sessionId: string, runId: string): string {
    return join(getProjectArtifactDir(this.storageRoot, projectName), sessionId, PENDING_DIR, runId)
  }

  // Builds the durable directory displayed under one completed assistant message.
  private getMessageDir(projectName: string, sessionId: string, messageId: string): string {
    return join(getProjectArtifactDir(this.storageRoot, projectName), sessionId, messageId)
  }

  // Reads only direct subdirectory names, returning an empty list when the directory does not exist.
  private async readSubdirectoryNames(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true })

      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }
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
    if (Object.values(metadata).every((value) => value === undefined)) return

    const metadataDirectory = join(directory, METADATA_DIR)
    await mkdir(metadataDirectory, { recursive: true })
    // Persist creation of `.metadata/` itself before publishing a routing file inside it. Without
    // the parent barrier, a crash can lose the newly-created directory even though the sidecar file
    // and its own directory entry were individually synced.
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

  // Reads trusted metadata written by this repository while tolerating older files without metadata.
  private async readArtifactMetadata(
    directory: string,
    filename: string
  ): Promise<ArtifactMetadata> {
    try {
      const rawMetadata = await readFile(getArtifactMetadataPath(directory, filename), 'utf8')
      const metadata = JSON.parse(rawMetadata) as unknown

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

  private toPendingRouting(metadata: ArtifactMetadata): PendingArtifactVersionRouting | undefined {
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
    metadata,
    messageId,
    runId
  }: {
    projectName: string
    sessionId: string
    filename: string
    filePath: string
    mimeType?: string
    metadata?: ArtifactMetadata
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
      mimeType: metadata?.mimeType ?? mimeType,
      artifactId: metadata?.artifactId,
      versionId: metadata?.versionId,
      versionNumber: metadata?.versionNumber,
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

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

export {
  ArtifactCompatibilityScanIncompleteError,
  ArtifactRepository,
  getArtifactCurrentRunFilePath,
  getProjectArtifactDir
}
export type {
  ArtifactRunFinalizationMarker,
  PendingArtifactRunPublication,
  PendingArtifactVersionRoute,
  PendingArtifactVersionRouting
}
