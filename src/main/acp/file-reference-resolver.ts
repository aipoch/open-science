import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { FileReference } from '../../shared/artifacts'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import { isPathWithin } from '../../shared/local-fs'
import type { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { UploadRepository } from '../uploads/repository'

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

export class FileReferenceResolver {
  private readonly adapters = new Map<FileReference['source'], FileReferenceAdapter>()

  constructor(adapters: FileReferenceAdapter[]) {
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
}

export const createManagedFileReferenceResolver = (dependencies: {
  uploads?: UploadRepository
  artifacts?: ArtifactRepository
  artifactVersions?: Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>>
  // Resolves a granted local root id to its absolute path (settings-backed). Absent ⇒
  // linked-folder references stay unavailable, matching the pre-grant behavior.
  grantedRoots?: {
    resolveRootPath: (rootId: string) => Promise<string | undefined>
  }
}): FileReferenceResolver => {
  const adapters: FileReferenceAdapter[] = []

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
      resolve: async (_context, reference) => {
        if (reference.source !== 'linked-folder') {
          throw new Error('Invalid linked-folder reference.')
        }
        const rootPath = await dependencies.grantedRoots!.resolveRootPath(reference.rootId)
        if (!rootPath) throw new Error(`Unknown granted folder root: ${reference.rootId}`)
        // The join is only lexical — the confinement proof is the realpath comparison below:
        // canonicalizing both sides catches '..' segments AND symlinks that point outside the
        // granted root, so neither can be used to escape it.
        const [resolvedRoot, resolvedFile] = await Promise.all([
          realpath(rootPath),
          realpath(join(rootPath, reference.relativePath))
        ])
        if (!isPathWithin(resolvedFile, resolvedRoot)) {
          throw new Error('Linked-folder reference escapes the granted folder.')
        }
        return {
          absolutePath: resolvedFile,
          name: reference.name,
          mimeType: reference.mimeType,
          allowSkillImportReference: false
        }
      }
    })
  }

  return new FileReferenceResolver(adapters)
}
