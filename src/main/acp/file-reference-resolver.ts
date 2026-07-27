import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import type { FileReference } from '../../shared/artifacts'
import type { ArtifactRepository } from '../artifacts/repository'
import type { UploadRepository } from '../uploads/repository'

export type FileReferenceContext = {
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
}): FileReferenceResolver => {
  const adapters: FileReferenceAdapter[] = []

  if (dependencies.uploads) {
    adapters.push({
      source: 'upload',
      resolve: async ({ sessionId }, reference) => {
        if (reference.source !== 'upload') throw new Error('Invalid upload reference.')
        let absolutePath: string
        try {
          absolutePath = await dependencies.uploads!.resolveSessionUploadPath(sessionId, {
            path: reference.path
          })
        } catch {
          // A turn-scoped `@` selection may intentionally refer to a managed upload from an older
          // session in the same project. It still has to pass canonical managed-root validation.
          absolutePath = await dependencies.uploads!.resolveManagedUploadPath({
            path: reference.path
          })
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
      resolve: async (_context, reference) => {
        if (reference.source !== 'artifact') throw new Error('Invalid artifact reference.')
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

  return new FileReferenceResolver(adapters)
}
