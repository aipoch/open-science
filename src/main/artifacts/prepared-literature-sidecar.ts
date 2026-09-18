import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'
import type { ArtifactWriteSource } from '../../shared/artifacts'
import {
  ARTIFACT_LITERATURE_SIDECAR_SUFFIX,
  artifactLiteratureSidecarSchema
} from '../../shared/artifact-literature'
import { resolveAllowedImportFilePath } from './storage-access'

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

const readPreparedLiteratureSidecar = async (
  source: ArtifactWriteSource,
  allowedImportRoots: string[],
  relativeBaseDirs: string[],
  options?: { signal?: AbortSignal; maxBytes?: number; onBytes?: (bytes: number) => void }
): Promise<ReturnType<typeof artifactLiteratureSidecarSchema.parse> | undefined> => {
  if (source.kind !== 'localPath' || !/\.(?:docx|zip)$/iu.test(source.path)) {
    return undefined
  }
  options?.signal?.throwIfAborted()
  const maxBytes = options?.maxBytes ?? LOCAL_RESOURCE_BUDGETS.requestBytes
  const sourcePath = await resolveAllowedImportFilePath(
    source.path,
    allowedImportRoots,
    relativeBaseDirs
  )
  const candidate = `${sourcePath}${ARTIFACT_LITERATURE_SIDECAR_SUFFIX}`
  try {
    const metadata = await stat(candidate)
    assertWithinResourceBudget('request', metadata.size, maxBytes)
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }
  const sidecarPath = await resolveAllowedImportFilePath(candidate, allowedImportRoots)
  const chunks: Buffer[] = []
  let bytes = 0
  // Recheck actual bytes, because the sidecar can grow after stat. Aborting destroys the stream.
  for await (const chunk of createReadStream(sidecarPath, { signal: options?.signal })) {
    options?.signal?.throwIfAborted()
    const buffer = chunk as Buffer
    bytes += buffer.byteLength
    assertWithinResourceBudget('request', bytes, maxBytes)
    options?.onBytes?.(buffer.byteLength)
    chunks.push(buffer)
  }
  options?.signal?.throwIfAborted()
  return artifactLiteratureSidecarSchema.parse(
    JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown
  )
}

export { readPreparedLiteratureSidecar }
