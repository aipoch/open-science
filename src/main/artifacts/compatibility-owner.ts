import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type {
  ArtifactFile,
  ArtifactPreviewResult,
  ListProjectMessageArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest
} from '../../shared/artifacts'
import { readBoundedManagedFilePreview } from '../managed-file-preview'
import { createLogger } from '../logger'
import type { ArtifactRunMarkerReadResult } from './publication-types'
import {
  ArtifactStorageAccess,
  assertPathInsideArtifactRoot,
  assertSafePathSegment,
  isMissingFileError,
  isPathInsideRoot
} from './storage-access'
import { ARTIFACTS_DIR, PENDING_DIR, RUNS_DIR, SAFE_SEGMENT_PATTERN } from './storage-layout'

const log = createLogger('artifacts:repository')

type ArtifactCompatibilityOwnerOptions = {
  storage: ArtifactStorageAccess
  readRunMarkerForRecovery: (markerPath: string) => Promise<ArtifactRunMarkerReadResult>
}

class ArtifactCompatibilityOwner {
  constructor(private readonly options: ArtifactCompatibilityOwnerOptions) {}

  async listMessageFiles(request: ListProjectMessageArtifactsRequest): Promise<ArtifactFile[]> {
    const projectId = assertSafePathSegment(request.projectId)
    const sessionId = assertSafePathSegment(request.sessionId)
    const messageId = assertSafePathSegment(request.messageId)
    const messageDir = this.options.storage.getMessageDir(projectId, sessionId, messageId)
    const entries = await this.options.storage.readFileEntries(messageDir)

    return Promise.all(
      entries.map(async (entry) =>
        this.options.storage.createArtifactFile({
          projectId,
          sessionId,
          messageId,
          filename: entry.name,
          filePath: join(messageDir, entry.name),
          metadata: await this.options.storage.readArtifactMetadata(messageDir, entry.name)
        })
      )
    )
  }

  async listProjectArtifacts(
    projectId: string,
    activeRunIds: ReadonlySet<string> = new Set()
  ): Promise<ArtifactFile[]> {
    const project = assertSafePathSegment(projectId)
    const projectDir = this.options.storage.getProjectArtifactDir(project)
    const files: ArtifactFile[] = []

    for (const sessionId of await this.options.storage.readSubdirectoryNames(projectDir)) {
      if (!SAFE_SEGMENT_PATTERN.test(sessionId)) continue
      const sessionDir = join(projectDir, sessionId)

      for (const messageId of await this.options.storage.readSubdirectoryNames(sessionDir)) {
        if (!SAFE_SEGMENT_PATTERN.test(messageId)) continue
        const messageDir = join(sessionDir, messageId)
        for (const entry of await this.options.storage.readFileEntries(messageDir)) {
          const metadata = await this.options.storage.readArtifactMetadata(messageDir, entry.name)
          files.push(
            await this.options.storage.createArtifactFile({
              projectId: project,
              sessionId,
              messageId,
              filename: entry.name,
              filePath: join(messageDir, entry.name),
              metadata
            })
          )
        }
      }

      const pendingDir = join(sessionDir, PENDING_DIR)
      for (const runId of await this.options.storage.readSubdirectoryNames(pendingDir)) {
        if (!this.options.storage.isPendingArtifactRunDirectory(runId) || activeRunIds.has(runId)) {
          continue
        }
        const runDir = join(pendingDir, runId)
        for (const entry of await this.options.storage.readFileEntries(runDir)) {
          const metadata = await this.options.storage.readArtifactMetadata(runDir, entry.name)
          files.push(
            await this.options.storage.createArtifactFile({
              projectId: project,
              sessionId,
              runId,
              filename: entry.name,
              filePath: join(runDir, entry.name),
              metadata
            })
          )
        }
      }
    }
    return files
  }

  async resolveManagedFilePath(request: OpenArtifactFileRequest): Promise<string> {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.path !== 'string' ||
      request.path.trim().length === 0
    ) {
      throw new Error('Invalid artifact file path.')
    }

    const artifactRoot = resolve(this.options.storage.storageRoot, ARTIFACTS_DIR)
    const requestedPath = resolve(request.path)
    assertPathInsideArtifactRoot(artifactRoot, requestedPath)
    const resolvedArtifactRoot = await realpath(artifactRoot)
    let resolvedFilePath: string
    try {
      resolvedFilePath = await realpath(requestedPath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
      const recovered = await this.recoverFinalizedPendingPath(requestedPath)
      if (!recovered) throw error
      resolvedFilePath = await realpath(recovered)
    }
    assertPathInsideArtifactRoot(resolvedArtifactRoot, resolvedFilePath)
    if (!(await stat(resolvedFilePath)).isFile()) throw new Error('Artifact path is not a file.')
    return resolvedFilePath
  }

  private async recoverFinalizedPendingPath(requestedPath: string): Promise<string | undefined> {
    const runDir = dirname(requestedPath)
    const runId = basename(runDir)
    const pendingDir = dirname(runDir)
    if (basename(pendingDir) !== PENDING_DIR) return undefined
    const sourceSessionDir = dirname(pendingDir)
    const markerResult = SAFE_SEGMENT_PATTERN.test(runId)
      ? await this.options.readRunMarkerForRecovery(
          join(sourceSessionDir, RUNS_DIR, `${runId}.json`)
        )
      : { present: false }
    if (markerResult.present) {
      if (!markerResult.marker) {
        log.warn('artifact recovery skipped: run marker present but unreadable', { requestedPath })
        return undefined
      }
      if (!markerResult.marker.messageId) return undefined
      const candidate = join(
        dirname(sourceSessionDir),
        markerResult.marker.sessionId,
        markerResult.marker.messageId,
        basename(requestedPath)
      )
      return (await stat(candidate).catch(() => undefined))?.isFile() ? candidate : undefined
    }
    log.warn('artifact recovery skipped: stale pending path has no run marker', { requestedPath })
    return undefined
  }

  async resolveSessionArtifactFilePath(
    projectId: string,
    sessionId: string,
    path: string
  ): Promise<string> {
    const resolvedFilePath = await this.resolveManagedFilePath({ path })
    const sessionRoot = join(this.options.storage.getProjectArtifactDir(projectId), sessionId)
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

  async readManagedFilePreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    const filePath = await this.resolveManagedFilePath(request)
    return readBoundedManagedFilePreview(filePath, request, 'Invalid artifact preview encoding.')
  }
}

export { ArtifactCompatibilityOwner }
export type { ArtifactCompatibilityOwnerOptions }
