import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import type {
  ArtifactFile,
  ArtifactSourceFileObservation,
  ListPendingRunArtifactsRequest,
  MovePendingRunArtifactsRequest,
  WritePendingArtifactFileRequest
} from '../../shared/artifacts'
import { runPendingFileTransaction } from './pending-file-transaction'
import { parseArtifactRunFinalizationMarker } from './run-marker-codec'
import { METADATA_DIR, PENDING_DIR, RUNS_DIR, SAFE_SEGMENT_PATTERN } from './storage-layout'
import type {
  ArtifactPublicationStorage,
  ArtifactRunFinalizationMarker,
  ArtifactRunMarkerReadResult,
  BindPendingArtifactVersionRouting,
  PendingArtifactRunPublication,
  PendingArtifactVersionRoute,
  PendingArtifactVersionRouting,
  PendingArtifactVersionRoutingRequest,
  PendingFileTransactionOptions,
  PrepareArtifactRunFinalizationRequest
} from './publication-types'

class ArtifactCompatibilityScanIncompleteError extends Error {
  constructor(cause: unknown) {
    super('Artifact compatibility storage could not be scanned completely.', { cause })
    this.name = 'ArtifactCompatibilityScanIncompleteError'
  }
}

class ArtifactPublicationOwner {
  private readonly pendingFileWrites = new Map<string, Promise<void>>()

  constructor(private readonly storage: ArtifactPublicationStorage) {}

  async writePendingFile(
    request: WritePendingArtifactFileRequest,
    options: PendingFileTransactionOptions = {}
  ): Promise<ArtifactFile> {
    return this.withPendingFileTransaction(request, options, async (artifact) => artifact)
  }

  async ensurePendingVersionRouting(request: PendingArtifactVersionRoutingRequest): Promise<void> {
    const normalized = this.normalizeRoutingRequest(request)
    await this.withPendingFileWriteLock(this.writeKey(normalized), () =>
      this.publishPendingVersionRoutingLocked(normalized)
    )
  }

  private normalizeRoutingRequest(
    request: PendingArtifactVersionRoutingRequest
  ): PendingArtifactVersionRoutingRequest {
    const runId = this.storage.assertSafePathSegment(request.runId)
    const artifactRunId = this.storage.assertSafePathSegment(request.routing.artifactRunId)
    if (artifactRunId !== runId) throw new Error('Artifact routing run identity mismatch.')
    if (!Number.isSafeInteger(request.routing.versionNumber) || request.routing.versionNumber < 1) {
      throw new Error('Artifact routing version number is invalid.')
    }
    if (!/^[a-f0-9]{64}$/.test(request.routing.checksum)) {
      throw new Error('Artifact routing checksum is invalid.')
    }
    return {
      ...request,
      projectName: this.storage.assertSafePathSegment(request.projectName),
      sessionId: this.storage.assertSafePathSegment(request.sessionId),
      runId,
      filename: this.storage.assertSafeFilename(request.filename),
      routing: {
        ...request.routing,
        artifactId: this.storage.assertSafePathSegment(request.routing.artifactId),
        versionId: this.storage.assertSafePathSegment(request.routing.versionId),
        artifactRunId
      }
    }
  }

  private async publishPendingVersionRoutingLocked(
    input: PendingArtifactVersionRoutingRequest
  ): Promise<void> {
    const request = this.normalizeRoutingRequest(input)
    const { projectName, sessionId, runId, filename, routing } = request
    const directory = this.storage.getPendingRunDir(projectName, sessionId, runId)
    const filePath = join(directory, filename)
    await mkdir(directory, { recursive: true })
    const existing = await this.storage.readArtifactMetadata(directory, filename)
    const existingRouting = this.storage.toPendingRouting(existing)
    if (
      existingRouting &&
      !request.allowRoutingReplacement &&
      (existingRouting.artifactId !== routing.artifactId ||
        existingRouting.versionId !== routing.versionId ||
        existingRouting.versionNumber !== routing.versionNumber ||
        existingRouting.artifactRunId !== routing.artifactRunId ||
        existingRouting.checksum !== routing.checksum)
    ) {
      throw new Error('Artifact pending routing conflicts with an existing Version.')
    }
    let bytes: Buffer
    try {
      bytes = await readFile(filePath)
    } catch (error) {
      if (!this.storage.isMissingFileError(error)) throw error
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`
      try {
        await copyFile(request.sourcePath, temporaryPath)
        bytes = await readFile(temporaryPath)
        if (this.storage.sha256(bytes) !== routing.checksum) {
          throw new Error('Artifact routing source checksum mismatch.')
        }
        await this.storage.durability.syncFile(temporaryPath)
        await rename(temporaryPath, filePath)
        await this.storage.durability.syncDirectory(directory)
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
    }
    if (this.storage.sha256(bytes) !== routing.checksum) {
      if (existingRouting || !request.replaceUnroutedBytes) {
        throw new Error('Artifact pending bytes conflict with Version routing.')
      }
      const replacementPath = `${filePath}.${randomUUID()}.tmp`
      try {
        await copyFile(request.sourcePath, replacementPath)
        const replacement = await readFile(replacementPath)
        if (this.storage.sha256(replacement) !== routing.checksum) {
          throw new Error('Artifact routing source checksum mismatch.')
        }
        await this.storage.durability.syncFile(replacementPath)
        await rename(replacementPath, filePath)
        await this.storage.durability.syncDirectory(directory)
      } finally {
        await rm(replacementPath, { force: true }).catch(() => undefined)
      }
    }
    await this.storage.writeArtifactMetadata(directory, filename, {
      ...routing,
      mimeType: routing.mimeType ?? existing.mimeType,
      kind: existing.kind
    })
  }

  async findPendingVersionRouting(request: {
    projectName: string
    artifactId: string
    versionId: string
  }): Promise<PendingArtifactVersionRoute | undefined> {
    const projectName = this.storage.assertSafePathSegment(request.projectName)
    const artifactId = this.storage.assertSafePathSegment(request.artifactId)
    const versionId = this.storage.assertSafePathSegment(request.versionId)
    const matches: PendingArtifactVersionRoute[] = []
    try {
      for (const storageSessionId of await this.storage.readSubdirectoryNames(
        this.storage.getProjectArtifactDir(projectName)
      )) {
        if (!SAFE_SEGMENT_PATTERN.test(storageSessionId)) continue
        const pendingRoot = join(
          this.storage.getProjectArtifactDir(projectName),
          storageSessionId,
          PENDING_DIR
        )
        for (const runId of await this.storage.readSubdirectoryNames(pendingRoot)) {
          if (!this.storage.isPendingArtifactRunDirectory(runId)) continue
          const runDirectory = join(pendingRoot, runId)
          for (const entry of await this.storage.readFileEntries(runDirectory)) {
            const routing = this.storage.toPendingRouting(
              await this.storage.readArtifactMetadata(runDirectory, entry.name)
            )
            if (
              !routing ||
              routing.artifactId !== artifactId ||
              routing.versionId !== versionId ||
              routing.artifactRunId !== runId
            ) {
              continue
            }
            const path = join(runDirectory, entry.name)
            if (this.storage.sha256(await readFile(path)) !== routing.checksum) continue
            matches.push({ ...routing, storageSessionId, filename: entry.name, path })
          }
        }
      }
    } catch (error) {
      throw new ArtifactCompatibilityScanIncompleteError(error)
    }
    if (matches.length > 1) {
      throw new Error('Artifact pending routing is ambiguous across compatibility storage.')
    }
    return matches[0]
  }

  async findPendingFileForRun(request: {
    projectName: string
    runId: string
    filename: string
    checksum: string
  }): Promise<{ storageSessionId: string; path: string } | undefined> {
    const projectName = this.storage.assertSafePathSegment(request.projectName)
    const runId = this.storage.assertSafePathSegment(request.runId)
    const filename = this.storage.assertSafeFilename(request.filename)
    const projectDirectory = this.storage.getProjectArtifactDir(projectName)
    const matches: Array<{ storageSessionId: string; path: string }> = []
    try {
      for (const storageSessionId of await this.storage.readSubdirectoryNames(projectDirectory)) {
        if (!SAFE_SEGMENT_PATTERN.test(storageSessionId)) continue
        const path = join(projectDirectory, storageSessionId, PENDING_DIR, runId, filename)
        try {
          if (this.storage.sha256(await readFile(path)) === request.checksum) {
            matches.push({ storageSessionId, path })
          }
        } catch (error) {
          if (!this.storage.isMissingFileError(error)) throw error
        }
      }
    } catch (error) {
      throw new ArtifactCompatibilityScanIncompleteError(error)
    }
    if (matches.length > 1) {
      throw new Error('Artifact pending file owner is ambiguous across compatibility storage.')
    }
    return matches[0]
  }

  async withPendingFileTransaction<Result>(
    request: WritePendingArtifactFileRequest,
    options: PendingFileTransactionOptions,
    operation: (
      artifact: ArtifactFile,
      sourceFileObservation: ArtifactSourceFileObservation | undefined,
      bindVersionRouting: BindPendingArtifactVersionRouting
    ) => Promise<Result>
  ): Promise<Result> {
    const normalized = {
      ...request,
      projectName: this.storage.assertSafePathSegment(request.projectName),
      sessionId: this.storage.assertSafePathSegment(request.sessionId),
      runId: this.storage.assertSafePathSegment(request.runId),
      filename: this.storage.assertSafeFilename(request.filename)
    }
    return this.withPendingFileWriteLock(this.writeKey(normalized), () =>
      runPendingFileTransaction<Result, PendingArtifactVersionRouting>({
        request: normalized,
        writeOptions: options,
        storage: this.storage,
        publishRouting: (routing, sourcePath) =>
          this.publishPendingVersionRoutingLocked({ ...normalized, sourcePath, routing }),
        operation
      })
    )
  }

  private writeKey(request: {
    projectName: string
    sessionId: string
    runId: string
    filename: string
  }): string {
    return `${request.projectName}\0${request.sessionId}\0${request.runId}\0${request.filename}`
  }

  private async withPendingFileWriteLock<Result>(
    key: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const previous = this.pendingFileWrites.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.then(() => current)
    this.pendingFileWrites.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.pendingFileWrites.get(key) === tail) this.pendingFileWrites.delete(key)
    }
  }

  async finalizeRunArtifacts(request: MovePendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    const projectName = this.storage.assertSafePathSegment(request.projectName)
    const sessionId = this.storage.assertSafePathSegment(request.sessionId)
    const sourceSessionId = this.storage.assertSafePathSegment(
      request.sourceSessionId ?? request.sessionId
    )
    const runId = this.storage.assertSafePathSegment(request.runId)
    const messageId = this.storage.assertSafePathSegment(request.messageId)
    const artifactVersionIds = request.artifactVersionIds
      ? this.storage.normalizeArtifactVersionIds(request.artifactVersionIds)
      : undefined
    const pendingDir = this.storage.getPendingRunDir(projectName, sourceSessionId, runId)
    const messageDir = this.storage.getMessageDir(projectName, sessionId, messageId)
    const entries = await this.storage.readFileEntries(pendingDir)
    await this.writeRunMarker(projectName, sourceSessionId, runId, {
      sessionId,
      messageId,
      ...(artifactVersionIds ? { artifactVersionIds } : {}),
      ...(request.provenanceContext ? { provenanceContext: request.provenanceContext } : {})
    })
    if (entries.length === 0) {
      await this.storage.recoverMovedArtifactMetadata(pendingDir, messageDir)
      await rm(pendingDir, { recursive: true, force: true })
      return this.storage.listMessageFiles({ projectName, sessionId, messageId })
    }
    await mkdir(messageDir, { recursive: true })
    for (const entry of entries) {
      await rename(join(pendingDir, entry.name), join(messageDir, entry.name))
      await this.storage.moveArtifactMetadata(pendingDir, messageDir, entry.name)
    }
    await this.storage.recoverMovedArtifactMetadata(pendingDir, messageDir)
    await rm(pendingDir, { recursive: true, force: true })
    return this.storage.listMessageFiles({ projectName, sessionId, messageId })
  }

  async prepareRunFinalization(request: PrepareArtifactRunFinalizationRequest): Promise<void> {
    const safe = this.storage.assertSafePathSegment
    const artifactVersionIds = request.artifactVersionIds
      ? this.storage.normalizeArtifactVersionIds(request.artifactVersionIds)
      : undefined
    await this.writeRunMarker(
      safe(request.projectName),
      safe(request.sourceSessionId),
      safe(request.runId),
      {
        sessionId: safe(request.sessionId),
        ...(artifactVersionIds ? { artifactVersionIds } : {}),
        provenanceContext: {
          rootFrameId: safe(request.provenanceContext.rootFrameId),
          agentFrameId: safe(request.provenanceContext.agentFrameId),
          messageBranchId: safe(request.provenanceContext.messageBranchId),
          runtimeSegmentId: safe(request.provenanceContext.runtimeSegmentId),
          promptMessageId: safe(request.provenanceContext.promptMessageId)
        }
      }
    )
  }

  async listPendingRunFiles(request: ListPendingRunArtifactsRequest): Promise<ArtifactFile[]> {
    const projectName = this.storage.assertSafePathSegment(request.projectName)
    const sessionId = this.storage.assertSafePathSegment(request.sessionId)
    const runId = this.storage.assertSafePathSegment(request.runId)
    const pendingDir = this.storage.getPendingRunDir(projectName, sessionId, runId)
    return Promise.all(
      (await this.storage.readFileEntries(pendingDir)).map(async (entry) =>
        this.storage.createArtifactFile({
          projectName,
          sessionId,
          runId,
          filename: entry.name,
          filePath: join(pendingDir, entry.name),
          metadata: await this.storage.readArtifactMetadata(pendingDir, entry.name)
        })
      )
    )
  }

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
    return this.storage.listMessageFiles(request)
  }

  private parsePendingPath(path: string): { artifactSessionId: string; runId: string } | undefined {
    if (typeof path !== 'string' || path.length === 0) return undefined
    const runDir = dirname(path)
    const runId = basename(runDir)
    const pendingDir = dirname(runDir)
    const artifactSessionId = basename(dirname(pendingDir))
    return basename(pendingDir) === PENDING_DIR &&
      SAFE_SEGMENT_PATTERN.test(runId) &&
      SAFE_SEGMENT_PATTERN.test(artifactSessionId)
      ? { artifactSessionId, runId }
      : undefined
  }

  async listPendingRunPublications(
    projectNameValue: string
  ): Promise<PendingArtifactRunPublication[]> {
    const projectName = this.storage.assertSafePathSegment(projectNameValue)
    const projectDirectory = this.storage.getProjectArtifactDir(projectName)
    const publications: PendingArtifactRunPublication[] = []
    const observedRunIds = new Set<string>()
    try {
      for (const sourceSessionId of await this.storage.readSubdirectoryNames(projectDirectory)) {
        if (!SAFE_SEGMENT_PATTERN.test(sourceSessionId)) continue
        const pendingDirectory = join(projectDirectory, sourceSessionId, PENDING_DIR)
        for (const runId of await this.storage.readSubdirectoryNames(pendingDirectory)) {
          if (!this.storage.isPendingArtifactRunDirectory(runId)) {
            if (runId === 'executions') {
              await this.storage.cleanupLegacyExecutionHandoffs(join(pendingDirectory, runId))
            }
            continue
          }
          if (!SAFE_SEGMENT_PATTERN.test(runId)) continue
          const runDirectory = join(pendingDirectory, runId)
          const files = await this.storage.readFileEntries(runDirectory)
          const metadataFiles =
            files.length === 0
              ? await this.storage.readFileEntries(join(runDirectory, METADATA_DIR))
              : []
          if (files.length === 0 && metadataFiles.length === 0) continue
          if (observedRunIds.has(runId)) {
            throw new Error(
              `Artifact pending publication run is ambiguous across compatibility storage: ${runId}`
            )
          }
          observedRunIds.add(runId)
          const markerResult = await this.readRunMarker(
            this.getRunMarkerPath(projectName, sourceSessionId, runId)
          )
          if (markerResult.present && !markerResult.marker) {
            throw new Error(`Artifact pending publication marker is corrupt: ${runId}`)
          }
          publications.push({
            sourceSessionId,
            runId,
            ...(markerResult.marker ? { marker: markerResult.marker } : {})
          })
        }
      }
    } catch (error) {
      throw new ArtifactCompatibilityScanIncompleteError(error)
    }
    return publications
  }

  async readRunMarkerForRecovery(markerPath: string): Promise<ArtifactRunMarkerReadResult> {
    return this.readRunMarker(markerPath)
  }

  async findRunFinalizationMarker(
    projectNameValue: string,
    runIdValue: string
  ): Promise<(ArtifactRunFinalizationMarker & { sourceSessionId: string }) | undefined> {
    const projectName = this.storage.assertSafePathSegment(projectNameValue)
    const runId = this.storage.assertSafePathSegment(runIdValue)
    const projectDirectory = this.storage.getProjectArtifactDir(projectName)
    const sessions = await readdir(projectDirectory, { withFileTypes: true }).catch((error) => {
      if (this.storage.isMissingFileError(error)) return []
      throw error
    })
    const matches: Array<ArtifactRunFinalizationMarker & { sourceSessionId: string }> = []
    for (const session of sessions) {
      if (!session.isDirectory() || !SAFE_SEGMENT_PATTERN.test(session.name)) continue
      const result = await this.readRunMarker(
        this.getRunMarkerPath(projectName, session.name, runId)
      )
      if (!result.present) continue
      if (!result.marker) return undefined
      matches.push({ ...result.marker, sourceSessionId: session.name })
    }
    return matches.length === 1 ? matches[0] : undefined
  }

  private getRunMarkerPath(projectName: string, sourceSessionId: string, runId: string): string {
    return join(
      this.storage.getProjectArtifactDir(projectName),
      sourceSessionId,
      RUNS_DIR,
      `${runId}.json`
    )
  }

  private async writeRunMarker(
    projectName: string,
    sourceSessionId: string,
    runId: string,
    marker: ArtifactRunFinalizationMarker
  ): Promise<void> {
    const markerPath = this.getRunMarkerPath(projectName, sourceSessionId, runId)
    const temporaryPath = `${markerPath}.${Date.now()}-${randomUUID()}.tmp`
    let markerToWrite = marker
    try {
      const markerDirectory = dirname(markerPath)
      await mkdir(markerDirectory, { recursive: true })
      await this.storage.durability.syncDirectory(dirname(markerDirectory))
      const existing = await this.readRunMarker(markerPath)
      if (existing.present) {
        if (!existing.marker) throw new Error('Existing Artifact run marker is corrupt.')
        if (existing.marker.sessionId !== marker.sessionId) {
          throw new Error('Artifact run marker is already owned by a different message.')
        }
        if (
          existing.marker.messageId &&
          marker.messageId &&
          existing.marker.messageId !== marker.messageId
        ) {
          throw new Error('Artifact run marker is already owned by a different message.')
        }
        if (
          existing.marker.provenanceContext &&
          marker.provenanceContext &&
          JSON.stringify(existing.marker.provenanceContext) !==
            JSON.stringify(marker.provenanceContext)
        ) {
          throw new Error(
            'Artifact run marker Provenance context conflicts with an existing commit.'
          )
        }
        if (
          existing.marker.artifactVersionIds &&
          marker.artifactVersionIds &&
          JSON.stringify(existing.marker.artifactVersionIds) !==
            JSON.stringify(marker.artifactVersionIds)
        ) {
          throw new Error('Artifact run marker Version ids conflict with an existing commit.')
        }
        markerToWrite = {
          sessionId: marker.sessionId,
          ...(marker.messageId || existing.marker.messageId
            ? { messageId: marker.messageId ?? existing.marker.messageId }
            : {}),
          ...(marker.provenanceContext || existing.marker.provenanceContext
            ? { provenanceContext: marker.provenanceContext ?? existing.marker.provenanceContext }
            : {}),
          ...(marker.artifactVersionIds || existing.marker.artifactVersionIds
            ? {
                artifactVersionIds: marker.artifactVersionIds ?? existing.marker.artifactVersionIds
              }
            : {})
        }
        if (JSON.stringify(existing.marker) === JSON.stringify(markerToWrite)) {
          await this.storage.durability.syncFile(markerPath)
          await this.storage.durability.syncDirectory(markerDirectory)
          return
        }
      }
      await writeFile(temporaryPath, `${JSON.stringify(markerToWrite)}\n`, 'utf8')
      await this.storage.durability.syncFile(temporaryPath)
      await rename(temporaryPath, markerPath)
      await this.storage.durability.syncDirectory(markerDirectory)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async readRunMarker(markerPath: string): Promise<ArtifactRunMarkerReadResult> {
    let raw: string
    try {
      raw = this.storage.durability.readMarkerFile
        ? await this.storage.durability.readMarkerFile(markerPath)
        : await readFile(markerPath, 'utf8')
    } catch (error) {
      if (this.storage.isMissingFileError(error)) return { present: false }
      throw error
    }
    try {
      return parseArtifactRunFinalizationMarker(
        JSON.parse(raw) as unknown,
        this.storage.normalizeArtifactVersionIds
      )
    } catch {
      return { present: true }
    }
  }
}

export { ArtifactCompatibilityScanIncompleteError, ArtifactPublicationOwner }
export type {
  ArtifactRunFinalizationMarker,
  BindPendingArtifactVersionRouting,
  PendingArtifactRunPublication,
  PendingArtifactVersionRoute,
  PendingArtifactVersionRouting,
  PendingArtifactVersionRoutingRequest,
  PendingFileTransactionOptions,
  PrepareArtifactRunFinalizationRequest
}
