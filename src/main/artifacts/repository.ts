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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import { createLogger } from '../logger'

const log = createLogger('artifacts:repository')

const ARTIFACTS_DIR = 'artifacts'
const PENDING_DIR = '.pending'
const METADATA_DIR = '.metadata'
// Per-run markers recording which app session + message a finalized run moved into, keyed by run id.
const RUNS_DIR = '.runs'
// Handoff file (directly under a session's .pending) naming the in-flight turn's run id for MCP writes.
const CURRENT_RUN_FILE = 'current-run.json'
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
  allowedImportRoots: string[]
): Promise<string> => {
  if (allowedImportRoots.length === 0) {
    throw importRootsError(filePath, allowedImportRoots)
  }

  let resolvedFilePath: string
  try {
    resolvedFilePath = await realpath(resolve(filePath))
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(
        `Artifact local source path does not exist: "${filePath}". Save the file to disk (inside the notebook session workspace) before calling write_artifact_file, or pass inline content instead.`
      )
    }
    throw error
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

    // Record where this run finalized so a stale `.pending/<run>` path recovers to this exact message,
    // not the newest same-named file in the session. Written on every finalize (idempotent).
    await this.writeRunMarker(projectName, sourceSessionId, runId, { sessionId, messageId })

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

  // Re-finalizes artifacts a crash left in `.pending` after the in-memory run claim was lost: the
  // session JSON persisted a `.pending/<run>/<file>` path, but the pending->message move never ran. Only
  // the artifactSessionId + runId segments are read from each path; the pending directory is rebuilt
  // from the storage root, so a corrupt stored path cannot point the move outside managed storage.
  // Idempotent — finalizeRunArtifacts tolerates files already moved. Returns the message's final files.
  async reconcilePendingArtifactPaths(request: {
    projectName: string
    sessionId: string
    messageId: string
    pendingPaths: string[]
  }): Promise<ArtifactFile[]> {
    const runs = new Map<string, { artifactSessionId: string; runId: string }>()

    for (const pendingPath of request.pendingPaths) {
      const parsed = this.parsePendingPath(pendingPath)
      if (parsed) runs.set(`${parsed.artifactSessionId}/${parsed.runId}`, parsed)
    }

    for (const { artifactSessionId, runId } of runs.values()) {
      await this.finalizeRunArtifacts({
        projectName: request.projectName,
        sessionId: request.sessionId,
        sourceSessionId: artifactSessionId,
        runId,
        messageId: request.messageId
      })
    }

    return this.listMessageFiles({
      projectName: request.projectName,
      sessionId: request.sessionId,
      messageId: request.messageId
    })
  }

  // Extracts the artifact session id and run id from a `.../<artifactSessionId>/.pending/<runId>/<file>`
  // path. Returns undefined when the path is not a pending path or the segments are unsafe.
  private parsePendingPath(
    pendingPath: string
  ): { artifactSessionId: string; runId: string } | undefined {
    if (typeof pendingPath !== 'string' || pendingPath.length === 0) return undefined

    const runDir = dirname(pendingPath)
    const runId = basename(runDir)
    const pendingDir = dirname(runDir)
    if (basename(pendingDir) !== PENDING_DIR) return undefined

    const artifactSessionId = basename(dirname(pendingDir))
    if (!SAFE_SEGMENT_PATTERN.test(runId) || !SAFE_SEGMENT_PATTERN.test(artifactSessionId)) {
      return undefined
    }

    return { artifactSessionId, runId }
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

  // Given a now-missing `.pending/<run>/<file>` artifact path, finds the same file after finalize moved
  // it, using ONLY the run marker written at finalize (`.runs/<run>.json`), which pins the exact app
  // session + message the run produced. An unmarked run is never recovered by guessing among same-named
  // files (that could cross-resolve to a different run's file); returns undefined instead. Also returns
  // undefined when the path is not a pending path or the marker's target no longer exists. Path safety
  // is still enforced by resolveManagedFilePath's root check on the returned path.
  private async recoverFinalizedPendingPath(requestedPath: string): Promise<string | undefined> {
    // requestedPath = <project>/<sourceSessionId>/.pending/<runId>/<file>
    const runDir = dirname(requestedPath)
    const runId = basename(runDir)
    const pendingDir = dirname(runDir)
    if (basename(pendingDir) !== PENDING_DIR) return undefined
    const sourceSessionDir = dirname(pendingDir)
    const filename = basename(requestedPath)

    // Marker path: resolve directly from the source-session dir the stale path already points into.
    const markerResult = SAFE_SEGMENT_PATTERN.test(runId)
      ? await this.readRunMarker(join(sourceSessionDir, RUNS_DIR, `${runId}.json`))
      : { present: false }

    // A marker file exists (the run WAS marked). Resolve ONLY to its pinned run→message target and
    // never fall back to another run's same-named file. A missing target (artifact deleted) or a
    // corrupt/unreadable marker both yield undefined — guessing here is the cross-run mis-read to avoid.
    if (markerResult.present) {
      if (!markerResult.marker) {
        log.warn('artifact recovery skipped: run marker present but unreadable', { requestedPath })
        return undefined
      }
      const projectDir = dirname(sourceSessionDir)
      const candidate = join(
        projectDir,
        markerResult.marker.sessionId,
        markerResult.marker.messageId,
        filename
      )
      const candidateStat = await stat(candidate).catch(() => undefined)
      return candidateStat?.isFile() ? candidate : undefined
    }

    // No marker at all. This is a legacy artifact (finalized before markers existed) OR one whose
    // best-effort marker write failed — the two are indistinguishable on disk. A same-name scan is
    // therefore unsafe even with a single candidate: if the run's own file was deleted and a different
    // run left an identically-named file, that lone candidate would be the WRONG run's file. So we do
    // not guess at all — recovery of an unmarked stale pending path returns undefined (a real 404). New
    // artifacts always carry a marker; the only loss is best-effort recovery of pre-marker legacy files,
    // whose finalized paths are already what a reloaded session persists (it doesn't hold pending paths).
    log.warn('artifact recovery skipped: stale pending path has no run marker', { requestedPath })
    return undefined
  }

  // Reads a small text preview from a managed artifact without exposing arbitrary filesystem reads.
  async readManagedFilePreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    const filePath = await this.resolveManagedFilePath(request)
    return readBoundedManagedFilePreview(filePath, request, 'Invalid artifact preview encoding.')
  }

  // Resolves the per-run marker path under the source (artifact) session, keyed by run id — the same
  // scope a stale pending path carries, so recovery can find it without knowing the app session id.
  private getRunMarkerPath(projectName: string, sourceSessionId: string, runId: string): string {
    return join(
      getProjectArtifactDir(this.storageRoot, projectName),
      sourceSessionId,
      RUNS_DIR,
      `${runId}.json`
    )
  }

  // Persists the app session + message a run finalized into. Written atomically (temp + rename) so a
  // crash mid-write never leaves a half-written marker that would later read as corrupt. Best-effort: a
  // failure must not fail the finalize itself — recovery then treats the run as unmarked and only
  // recovers a stale path when the same-name match is unambiguous (never guessing across runs).
  private async writeRunMarker(
    projectName: string,
    sourceSessionId: string,
    runId: string,
    marker: { sessionId: string; messageId: string }
  ): Promise<void> {
    const markerPath = this.getRunMarkerPath(projectName, sourceSessionId, runId)
    const temporaryPath = `${markerPath}.${Date.now()}-${randomUUID()}.tmp`
    try {
      await mkdir(dirname(markerPath), { recursive: true })
      await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, 'utf8')
      await rename(temporaryPath, markerPath)
    } catch {
      // Non-fatal: the run still finalized; an unmarked run just isn't recoverable via stale pending
      // path. Remove any temp left behind so a failed write never litters the `.runs` dir (matches the
      // atomic-write cleanup elsewhere in this repository).
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  // Reads a run marker, distinguishing three states so recovery can act safely:
  //   { present: false }            — no marker file (legacy artifact, or a marker write that failed).
  //   { present: true }             — a marker file exists but is unreadable/corrupt/invalid.
  //   { present: true, marker }     — a valid marker pinning the run's app session + message.
  // The present-but-invalid case must NOT fall back to a same-name scan: the run WAS marked, so a
  // damaged marker means "cannot resolve", not "guess among other runs' files".
  private async readRunMarker(
    markerPath: string
  ): Promise<{ present: boolean; marker?: { sessionId: string; messageId: string } }> {
    let raw: string
    try {
      raw = await readFile(markerPath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) return { present: false }
      // Present but unreadable (e.g. permissions): treat as a damaged marker, not absent.
      return { present: true }
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { sessionId?: unknown }).sessionId === 'string' &&
        typeof (parsed as { messageId?: unknown }).messageId === 'string'
      ) {
        const { sessionId, messageId } = parsed as { sessionId: string; messageId: string }
        if (SAFE_SEGMENT_PATTERN.test(sessionId) && SAFE_SEGMENT_PATTERN.test(messageId)) {
          return { present: true, marker: { sessionId, messageId } }
        }
      }
      return { present: true }
    } catch {
      return { present: true }
    }
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
