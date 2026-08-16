import { rmSync } from 'node:fs'
import { copyFile, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { FileReference } from '../../shared/artifacts'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { isPathWithin } from '../../shared/local-fs'
import { MAX_UPLOAD_FILE_BYTES } from '../../shared/uploads'
import type { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createLogger, errorLogFields } from '../logger'
import type { UploadRepository } from '../uploads/repository'

const log = createLogger('acp-file-reference-resolver')

export type FileReferenceContext = {
  projectId: string
  sessionId: string
}

export type ResolvedFileReference = {
  absolutePath: string
  uri: string
  name: string
  mimeType?: string
  size: number
  allowSkillImportReference: boolean
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
  clear: () => void
}

// A read-only grant must not hand an Agent the user's source path. Each reference therefore gets a
// private snapshot under the OS temporary directory. The Agent may mutate that disposable snapshot,
// but the original remains outside the capability conveyed by the prompt. Random per-reference
// directories also keep asynchronous cleanup from racing a replacement Session with the same id.
class ReadOnlyLinkedFileProjection implements FileReferenceResolverLifecycle {
  private generation = 0
  private readonly sessionGenerations = new Map<string, number>()
  private readonly directoriesBySession = new Map<string, Set<string>>()
  private readonly bytesBySession = new Map<string, number>()
  private readonly pendingRemovalDirectories = new Set<string>()

  constructor(private readonly maxSessionBytes = MAX_UPLOAD_FILE_BYTES) {}

  async materialize(sessionId: string, sourcePath: string, sourceSize: number): Promise<string> {
    const generation = this.generation
    const sessionGeneration = this.sessionGenerations.get(sessionId) ?? 0
    const reservedBytes = this.bytesBySession.get(sessionId) ?? 0
    if (sourceSize > this.maxSessionBytes || reservedBytes + sourceSize > this.maxSessionBytes) {
      throw new Error('Read-only linked-folder snapshots exceed the Session storage limit.')
    }
    this.bytesBySession.set(sessionId, reservedBytes + sourceSize)

    let directory: string | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'open-science-linked-ro-'))
      if (!this.isCurrent(sessionId, generation, sessionGeneration)) {
        throw new Error('Read-only linked-folder projection was superseded.')
      }
      let directories = this.directoriesBySession.get(sessionId)
      if (!directories) {
        directories = new Set()
        this.directoriesBySession.set(sessionId, directories)
      }
      directories.add(directory)

      const snapshotPath = join(directory, basename(sourcePath))
      await copyFile(sourcePath, snapshotPath)
      if (!this.isCurrent(sessionId, generation, sessionGeneration)) {
        throw new Error('Read-only linked-folder projection was superseded.')
      }
      return snapshotPath
    } catch (error) {
      const current = this.isCurrent(sessionId, generation, sessionGeneration)
      if (current) {
        this.releaseReservation(sessionId, sourceSize)
      }
      if (directory) {
        const directories = this.directoriesBySession.get(sessionId)
        directories?.delete(directory)
        if (directories?.size === 0) this.directoriesBySession.delete(sessionId)
        if (current) this.removeDirectory(directory)
        else this.removeDirectorySynchronously(directory)
      }
      throw error
    }
  }

  resetSession(sessionId: string): void {
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1)
    const directories = this.directoriesBySession.get(sessionId)
    this.directoriesBySession.delete(sessionId)
    this.bytesBySession.delete(sessionId)
    if (directories) {
      for (const directory of directories) this.removeDirectory(directory)
    }
  }

  clear(): void {
    this.generation += 1
    this.sessionGenerations.clear()
    const directories = new Set([
      ...[...this.directoriesBySession.values()].flatMap((value) => [...value]),
      ...this.pendingRemovalDirectories
    ])
    this.directoriesBySession.clear()
    this.bytesBySession.clear()
    this.pendingRemovalDirectories.clear()
    for (const directory of directories) this.removeDirectorySynchronously(directory)
  }

  private isCurrent(sessionId: string, generation: number, sessionGeneration: number): boolean {
    return (
      this.generation === generation &&
      (this.sessionGenerations.get(sessionId) ?? 0) === sessionGeneration
    )
  }

  private removeDirectory(directory: string): void {
    this.pendingRemovalDirectories.add(directory)
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

  private releaseReservation(sessionId: string, size: number): void {
    const next = Math.max(0, (this.bytesBySession.get(sessionId) ?? 0) - size)
    if (next === 0) this.bytesBySession.delete(sessionId)
    else this.bytesBySession.set(sessionId, next)
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
    const fileInfo = await stat(resolved.absolutePath)
    if (!fileInfo.isFile()) throw new Error('Referenced path is not a file.')

    return {
      ...resolved,
      uri: pathToFileURL(resolved.absolutePath).href,
      size: fileInfo.size
    }
  }

  resetSession(sessionId: string): void {
    this.lifecycle?.resetSession(sessionId)
  }

  clear(): void {
    this.lifecycle?.clear()
  }
}

export const createManagedFileReferenceResolver = (dependencies: {
  uploads?: UploadRepository
  artifacts?: ArtifactRepository
  artifactVersions?: Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>>
  readOnlyProjectionMaxSessionBytes?: number
  // Resolves a granted local root id and current access level (settings-backed). Absent ⇒
  // linked-folder references stay unavailable, matching the pre-grant behavior.
  grantedRoots?: {
    resolveRoot: (rootId: string) => Promise<Pick<GrantedLocalRoot, 'path' | 'access'> | undefined>
  }
}): FileReferenceResolver => {
  const adapters: FileReferenceAdapter[] = []
  const readOnlyProjection = dependencies.grantedRoots
    ? new ReadOnlyLinkedFileProjection(dependencies.readOnlyProjectionMaxSessionBytes)
    : undefined

  if (dependencies.uploads) {
    adapters.push({
      source: 'upload',
      resolve: async ({ projectId, sessionId }, reference) => {
        if (reference.source !== 'upload') throw new Error('Invalid upload reference.')
        let absolutePath: string
        try {
          absolutePath = await dependencies.uploads!.resolveSessionUploadPath(
            sessionId,
            { path: reference.path },
            projectId
          )
        } catch {
          // A turn-scoped `@` selection is an explicit user capability and may intentionally refer
          // to a managed upload from another Session. Project ownership remains an app-issued
          // boundary: native Versions and trusted legacy mappings must still belong to this Project.
          absolutePath = await dependencies.uploads!.resolveManagedUploadPath(
            { path: reference.path },
            { projectId }
          )
        }
        return {
          absolutePath,
          name: reference.name,
          mimeType: reference.mimeType,
          allowSkillImportReference: true
        }
      }
    })
  }

  if (dependencies.artifacts) {
    adapters.push({
      source: 'artifact',
      resolve: async ({ projectId }, reference) => {
        if (reference.source !== 'artifact') throw new Error('Invalid artifact reference.')
        const versionIdentity = parseArtifactVersionLocator(reference.path)
        if (versionIdentity) {
          if (versionIdentity.projectId !== projectId) {
            throw new Error('Artifact Version belongs to a different project.')
          }
          if (!dependencies.artifactVersions?.resolveVersionContent) {
            throw new Error('Artifact Provenance is not configured.')
          }
          const resolved =
            await dependencies.artifactVersions.resolveVersionContent(versionIdentity)
          return {
            absolutePath: resolved.path,
            name: resolved.filename,
            mimeType: resolved.contentType ?? reference.mimeType,
            allowSkillImportReference: false
          }
        }
        return {
          absolutePath: await dependencies.artifacts!.resolveManagedFilePath({
            path: reference.path
          }),
          name: reference.name,
          mimeType: reference.mimeType,
          allowSkillImportReference: false
        }
      }
    })
  }

  if (dependencies.grantedRoots) {
    adapters.push({
      source: 'linked-folder',
      resolve: async ({ sessionId }, reference) => {
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
              ? await readOnlyProjection!.materialize(sessionId, resolvedFile, fileInfo.size)
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
