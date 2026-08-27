import { readFile } from 'node:fs/promises'

import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import type { ArtifactVersionContentResolver } from '../reviewer/host-sdk'
import { sha256 } from './provenance-canonical'
import { resolveStorageKey } from './provenance-storage'

type ArtifactContentStatusRequest = {
  storageRoot: string
  projectId: string
  sessionId: string
  fileId: string
  versionId: string
  contentStorageKey: string
  checksum: string
  resolveVersion?: ArtifactVersionContentResolver
}

const errorChainHasCode = (error: unknown, code: string): boolean => {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && error.code === code) return true
  return 'cause' in error && errorChainHasCode(error.cause, code)
}

const unavailableReason = (
  error: unknown
):
  | Extract<ArtifactVersionProvenance['contentStatus'], { state: 'unavailable' }>['reason']
  | undefined => {
  if (errorChainHasCode(error, 'ENOENT')) return 'missing'
  if (
    errorChainHasCode(error, 'INTEGRITY_FAILED') ||
    errorChainHasCode(error, 'CONTENT_INTEGRITY_FAILED')
  ) {
    return 'checksum-mismatch'
  }
  return undefined
}

export const resolveArtifactContentStatus = async (
  request: ArtifactContentStatusRequest
): Promise<ArtifactVersionProvenance['contentStatus']> => {
  if (!request.resolveVersion) {
    // Repository-only fixtures have no application authority composition. Production always
    // supplies resolveVersion and therefore cannot enter this persistence test path.
    const path = resolveStorageKey(request.storageRoot, request.contentStorageKey)
    return readFile(path)
      .then((content) =>
        sha256(content) === request.checksum
          ? ({ state: 'available' } as const)
          : ({ state: 'unavailable', reason: 'checksum-mismatch' } as const)
      )
      .catch((error: unknown) => {
        if (errorChainHasCode(error, 'ENOENT')) {
          return { state: 'unavailable', reason: 'missing' } as const
        }
        throw error
      })
  }

  let lease: Awaited<ReturnType<ArtifactVersionContentResolver>> | undefined
  try {
    lease = await request.resolveVersion({
      projectId: request.projectId,
      sessionId: request.sessionId,
      fileId: request.fileId,
      versionId: request.versionId
    })
    await lease.verifyUnchanged()
    return { state: 'available' }
  } catch (error) {
    const reason = unavailableReason(error)
    if (reason) return { state: 'unavailable', reason }
    throw error
  } finally {
    await lease?.close().catch(() => undefined)
  }
}
