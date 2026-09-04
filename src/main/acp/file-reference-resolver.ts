import { createReadStream, createWriteStream, rmSync } from 'node:fs'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import type { FileReference } from '../../shared/artifacts'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { isPathWithin } from '../../shared/local-fs'
import { MAX_UPLOAD_FILE_BYTES } from '../../shared/uploads'
import type { ArtifactRepository } from '../artifacts/repository'
import { createLogger, errorLogFields } from '../logger'
import type { UploadRepository } from '../uploads/repository'
import type {
  ManagedFileReadLease,
  ManagedFileVersionService
} from '../managed-file-versions/service'

const log = createLogger('acp-file-reference-resolver')

export type FileReferenceContext = {
  projectId: string
  sessionId: string
  connectionGeneration?: number
}

export type TrustedFileReferenceLease = Pick<
  ManagedFileReadLease,
  'size' | 'read' | 'readRange' | 'copyTo' | 'verifyUnchanged' | 'close'
>

export type ResolvedFileReference = {
  absolutePath: string
  uri: string
  name: string
  mimeType?: string
  size: number
  allowSkillImportReference: boolean
  sourceFileId?: string
  sourceSessionId?: string
  versionId?: string
  checksum?: string
  trustedLease?: TrustedFileReferenceLease
}

// This adapter is the deliberate extension seam for linked folders and other future file origins.
// An adapter must validate its own capability before returning an absolute path.
export type FileReferenceAdapter = {
  source: FileReference['source']
  resolve(
    context: FileReferenceContext,
    reference: FileReference
  ): Promise<Omit<ResolvedFileReference, 'uri' | 'size'>>
}

type FileReferenceResolverLifecycle = {
  resetSession: (sessionId: string) => void
  clearGeneration: (connectionGeneration: number) => void
  clear: () => void
}

// A read-only grant must not hand an Agent the user's source path. Each reference therefore gets a
// private snapshot under the OS temporary directory. The Agent may mutate that disposable snapshot,
// but the original remains outside the capability conveyed by the prompt. Random per-reference
// directories also keep asynchronous cleanup from racing a replacement Session with the same id.
class ReadOnlyLinkedFileProjection implements FileReferenceResolverLifecycle {
  private generation = 0
  private readonly sessionGenerations = new Map<string, number>()
  private readonly connectionGenerations = new Map<number, number>()
  private readonly directoriesByScope = new Map<string, Set<string>>()
  private readonly bytesByScope = new Map<string, number>()
  private readonly scopes = new Map<
    string,
    Readonly<{ connectionGeneration: number; sessionId: string }>
  >()
  private readonly pendingRemovalDirectories = new Map<string, number>()

  constructor(private readonly maxSessionBytes = MAX_UPLOAD_FILE_BYTES) {}

  async materialize(
    connectionGeneration: number,
    sessionId: string,
    sourcePath: string,
    sourceSize: number
  ): Promise<string> {
    const generation = this.generation
    const sessionGeneration = this.sessionGenerations.get(sessionId) ?? 0
    const connectionProjectionGeneration = this.connectionGenerations.get(connectionGeneration) ?? 0
    const scopeKey = this.scopeKey(connectionGeneration, sessionId)
    const sessionBytes = this.bytesByScope.get(scopeKey) ?? 0
    if (sourceSize > this.maxSessionBytes - sessionBytes) {
      throw new Error('Read-only linked-folder snapshots exceed the Session storage limit.')
    }
    let copiedBytes = 0
    let directory: string | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'open-science-linked-ro-'))
      if (
        !this.isCurrent(
          connectionGeneration,
          sessionId,
          generation,
          connectionProjectionGeneration,
          sessionGeneration
        )
      ) {
        throw new Error('Read-only linked-folder projection was superseded.')
      }
      this.scopes.set(scopeKey, { connectionGeneration, sessionId })
      let directories = this.directoriesByScope.get(scopeKey)
      if (!directories) {
        directories = new Set()
        this.directoriesByScope.set(scopeKey, directories)
      }
      directories.add(directory)

      const snapshotPath = join(directory, basename(sourcePath))
      await pipeline(
        createReadStream(sourcePath),
        new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            if (
              !this.isCurrent(
                connectionGeneration,
                sessionId,
                generation,
                connectionProjectionGeneration,
                sessionGeneration
              )
            ) {
              callback(new Error('Read-only linked-folder projection was superseded.'))
              return
            }
            const sessionBytes = this.bytesByScope.get(scopeKey) ?? 0
            if (sessionBytes + chunk.length > this.maxSessionBytes) {
              callback(
                new Error('Read-only linked-folder snapshots exceed the Session storage limit.')
              )
              return
            }
            copiedBytes += chunk.length
            this.bytesByScope.set(scopeKey, sessionBytes + chunk.length)
            callback(null, chunk)
          }
        }),
        createWriteStream(snapshotPath, { flags: 'wx' })
      )
      if (
        !this.isCurrent(
          connectionGeneration,
          sessionId,
          generation,
          connectionProjectionGeneration,
          sessionGeneration
        )
      ) {
        throw new Error('Read-only linked-folder projection was superseded.')
      }
      return snapshotPath
    } catch (error) {
      const current = this.isCurrent(
        connectionGeneration,
        sessionId,
        generation,
        connectionProjectionGeneration,
        sessionGeneration
      )
      if (current) {
        this.releaseReservation(scopeKey, copiedBytes)
      }
      if (directory) {
        const directories = this.directoriesByScope.get(scopeKey)
        directories?.delete(directory)
        if (directories?.size === 0) this.directoriesByScope.delete(scopeKey)
        if (current) this.removeDirectory(directory, connectionGeneration)
        else this.removeDirectorySynchronously(directory)
      }
      this.deleteScopeIfEmpty(scopeKey)
      throw error
    }
  }

  resetSession(sessionId: string): void {
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1)
    for (const [scopeKey, scope] of this.scopes) {
      if (scope.sessionId === sessionId) this.removeScope(scopeKey, false)
    }
  }

  clearGeneration(connectionGeneration: number): void {
    this.connectionGenerations.set(
      connectionGeneration,
      (this.connectionGenerations.get(connectionGeneration) ?? 0) + 1
    )
    for (const [scopeKey, scope] of this.scopes) {
      if (scope.connectionGeneration === connectionGeneration) this.removeScope(scopeKey, true)
    }
    for (const [directory, pendingGeneration] of this.pendingRemovalDirectories) {
      if (pendingGeneration !== connectionGeneration) continue
      this.pendingRemovalDirectories.delete(directory)
      this.removeDirectorySynchronously(directory)
    }
  }

  clear(): void {
    this.generation += 1
    this.sessionGenerations.clear()
    this.connectionGenerations.clear()
    const directories = new Set([
      ...[...this.directoriesByScope.values()].flatMap((value) => [...value]),
      ...this.pendingRemovalDirectories.keys()
    ])
    this.directoriesByScope.clear()
    this.bytesByScope.clear()
    this.scopes.clear()
    this.pendingRemovalDirectories.clear()
    for (const directory of directories) this.removeDirectorySynchronously(directory)
  }

  private isCurrent(
    connectionGeneration: number,
    sessionId: string,
    generation: number,
    connectionProjectionGeneration: number,
    sessionGeneration: number
  ): boolean {
    return (
      this.generation === generation &&
      (this.connectionGenerations.get(connectionGeneration) ?? 0) ===
        connectionProjectionGeneration &&
      (this.sessionGenerations.get(sessionId) ?? 0) === sessionGeneration
    )
  }

  private removeDirectory(directory: string, connectionGeneration: number): void {
    this.pendingRemovalDirectories.set(directory, connectionGeneration)
    void rm(directory, { recursive: true, force: true })
      .catch((error) => {
        log.warn('read-only linked-folder projection cleanup failed', errorLogFields(error))
      })
      .finally(() => this.pendingRemovalDirectories.delete(directory))
  }

  private removeDirectorySynchronously(directory: string): void {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      log.warn('read-only linked-folder projection cleanup failed', errorLogFields(error))
    }
  }

  private removeScope(scopeKey: string, synchronously: boolean): void {
    const scope = this.scopes.get(scopeKey)
    if (!scope) return
    const directories = this.directoriesByScope.get(scopeKey)
    this.directoriesByScope.delete(scopeKey)
    this.bytesByScope.delete(scopeKey)
    this.scopes.delete(scopeKey)
    if (!directories) return
    for (const directory of directories) {
      if (synchronously) this.removeDirectorySynchronously(directory)
      else this.removeDirectory(directory, scope.connectionGeneration)
    }
  }

  private releaseReservation(scopeKey: string, size: number): void {
    const next = Math.max(0, (this.bytesByScope.get(scopeKey) ?? 0) - size)
    if (next === 0) this.bytesByScope.delete(scopeKey)
    else this.bytesByScope.set(scopeKey, next)
  }

  private deleteScopeIfEmpty(scopeKey: string): void {
    if (!this.bytesByScope.has(scopeKey) && !this.directoriesByScope.has(scopeKey)) {
      this.scopes.delete(scopeKey)
    }
  }

  private scopeKey(connectionGeneration: number, sessionId: string): string {
    return `${connectionGeneration}:${sessionId}`
  }
}

export class FileReferenceResolver {
  private readonly adapters = new Map<FileReference['source'], FileReferenceAdapter>()

  constructor(
    adapters: FileReferenceAdapter[],
    private readonly lifecycle?: FileReferenceResolverLifecycle
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.source, adapter)
  }

  async resolve(
    context: FileReferenceContext,
    reference: FileReference
  ): Promise<ResolvedFileReference> {
    const adapter = this.adapters.get(reference.source)
    if (!adapter) throw new Error(`File reference source is not configured: ${reference.source}`)

    const resolved = await adapter.resolve(context, reference)
    try {
      const fileInfo = resolved.trustedLease ? undefined : await stat(resolved.absolutePath)
      if (fileInfo && !fileInfo.isFile()) throw new Error('Referenced path is not a file.')

      return {
        ...resolved,
        uri: pathToFileURL(resolved.absolutePath).href,
        size: resolved.trustedLease?.size ?? fileInfo!.size
      }
    } catch (error) {
      await resolved.trustedLease?.close().catch(() => undefined)
      throw error
    }
  }

  resetSession(sessionId: string): void {
    this.lifecycle?.resetSession(sessionId)
  }

  clearGeneration(connectionGeneration: number): void {
    this.lifecycle?.clearGeneration(connectionGeneration)
  }

  clear(): void {
    this.lifecycle?.clear()
  }
}

export const createManagedFileReferenceResolver = (dependencies: {
  uploads?: UploadRepository
  artifacts?: ArtifactRepository
  readOnlyProjectionMaxSessionBytes?: number
  // Resolves a granted local root id and current access level (settings-backed). Absent ⇒
  // linked-folder references stay unavailable, matching the pre-grant behavior.
  grantedRoots?: {
    resolveRoot: (rootId: string) => Promise<Pick<GrantedLocalRoot, 'path' | 'access'> | undefined>
  }
  managedFileVersions?: Pick<ManagedFileVersionService, 'openLatest'>
}): FileReferenceResolver => {
  const adapters: FileReferenceAdapter[] = []
  const readOnlyProjection = dependencies.grantedRoots
    ? new ReadOnlyLinkedFileProjection(dependencies.readOnlyProjectionMaxSessionBytes)
    : undefined

  const resolveLogicalReference = async (
    projectId: string,
    reference: Extract<FileReference, { source: 'artifact' | 'upload' }>
  ): Promise<ManagedFileReadLease> => {
    let sourceFileId = reference.sourceFileId
    if (reference.source === 'artifact') {
      const versionIdentity = parseArtifactVersionLocator(reference.path)
      if (versionIdentity) {
        if (versionIdentity.projectId !== projectId) {
          throw new Error('Artifact Version belongs to a different project.')
        }
        if (sourceFileId !== undefined && sourceFileId !== versionIdentity.artifactId) {
          throw new Error('Artifact source file does not match its Version locator.')
        }
        sourceFileId = versionIdentity.artifactId
        if (!dependencies.managedFileVersions) {
          throw new Error('Latest managed file resolution is not configured.')
        }
      }
    }
    if (!sourceFileId) {
      throw new Error('Managed file reference requires a logical identity.')
    }
    if (!dependencies.managedFileVersions) {
      throw new Error('Latest managed file resolution is not configured.')
    }
    return dependencies.managedFileVersions.openLatest({
      source: reference.source,
      projectId,
      fileId: sourceFileId
    })
  }

  if (dependencies.uploads || dependencies.managedFileVersions) {
    adapters.push({
      source: 'upload',
      resolve: async ({ projectId }, reference) => {
        if (reference.source !== 'upload') throw new Error('Invalid upload reference.')
        const logical = await resolveLogicalReference(projectId, reference)
        return {
          absolutePath: logical.path,
          name: logical.logicalFile.displayName,
          mimeType: logical.version.contentType ?? reference.mimeType,
          allowSkillImportReference: true,
          sourceFileId: logical.logicalFile.id,
          sourceSessionId: logical.logicalFile.sessionId,
          versionId: logical.version.id,
          checksum: logical.version.checksum,
          trustedLease: logical
        }
      }
    })
  }

  if (dependencies.artifacts || dependencies.managedFileVersions) {
    adapters.push({
      source: 'artifact',
      resolve: async ({ projectId }, reference) => {
        if (reference.source !== 'artifact') throw new Error('Invalid artifact reference.')
        const logical = await resolveLogicalReference(projectId, reference)
        return {
          absolutePath: logical.path,
          name: logical.logicalFile.displayName,
          mimeType: logical.version.contentType ?? reference.mimeType,
          allowSkillImportReference: false,
          sourceFileId: logical.logicalFile.id,
          sourceSessionId: logical.logicalFile.sessionId,
          versionId: logical.version.id,
          checksum: logical.version.checksum,
          trustedLease: logical
        }
      }
    })
  }

  if (dependencies.grantedRoots) {
    adapters.push({
      source: 'linked-folder',
      resolve: async ({ sessionId, connectionGeneration = 0 }, reference) => {
        if (reference.source !== 'linked-folder') {
          throw new Error('Invalid linked-folder reference.')
        }
        const root = await dependencies.grantedRoots!.resolveRoot(reference.rootId)
        if (!root) throw new Error(`Unknown granted folder root: ${reference.rootId}`)
        // The join is only lexical — the confinement proof is the realpath comparison below:
        // canonicalizing both sides catches '..' segments AND symlinks that point outside the
        // granted root, so neither can be used to escape it.
        const [resolvedRoot, resolvedFile] = await Promise.all([
          realpath(root.path),
          realpath(join(root.path, reference.relativePath))
        ])
        if (!isPathWithin(resolvedFile, resolvedRoot)) {
          throw new Error('Linked-folder reference escapes the granted folder.')
        }
        const fileInfo = await stat(resolvedFile)
        if (!fileInfo.isFile()) throw new Error('Referenced path is not a file.')
        return {
          absolutePath:
            root.access === 'ro'
              ? await readOnlyProjection!.materialize(
                  connectionGeneration,
                  sessionId,
                  resolvedFile,
                  fileInfo.size
                )
              : resolvedFile,
          name: reference.name,
          mimeType: reference.mimeType,
          allowSkillImportReference: false
        }
      }
    })
  }

  return new FileReferenceResolver(adapters, readOnlyProjection)
}
