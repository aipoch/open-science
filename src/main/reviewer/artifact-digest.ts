import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

import type { TurnScope } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ArtifactVersionContentResolver } from './host-sdk'
import { resolveArtifactPath } from './host-sdk'
import { resolveTurnScope } from './scope'

// At most this many artifacts are hashed at once. Scientific artifacts can be large, so an unbounded
// fan-out could hold many whole files in flight and exhaust the Electron main process.
const DIGEST_CONCURRENCY = 4

// Digest of an artifact's CURRENT on-disk bytes. Streams the file through the hash rather than reading
// it whole, so a large artifact never lands in memory in one piece. Preferring a content hash means an
// external edit that preserves size and mtime is still detected; the size+mtime fallback keeps a signal
// when the bytes cannot be streamed, and a fully unreadable/missing artifact stays undefined (hashed as
// null, still distinct from any present digest).
const computeArtifactDigest = async (path: string): Promise<string | undefined> => {
  try {
    const hash = createHash('sha256')
    await pipeline(createReadStream(path), hash)
    return `sha256:${hash.digest('hex')}`
  } catch {
    try {
      const fileStat = await stat(path)
      return `size-mtime:${fileStat.size}:${fileStat.mtimeMs}`
    } catch {
      return undefined
    }
  }
}

// Resolves the turn scope with every referenced artifact pinned to a digest of its current bytes, so a
// stored review — and any finding locator anchored to a block that produced an artifact — goes stale
// when that artifact is edited outside the app. The structural pass is cheap (no filesystem access);
// only the turn's own artifacts are read, streamed, and hashed in bounded-concurrency batches.
export const resolveTurnScopeWithArtifactDigests = async (
  session: PersistedChatSession,
  turnMessageId: string,
  artifactStorageRoot: string,
  resolveArtifactVersion?: ArtifactVersionContentResolver
): Promise<TurnScope> => {
  const structural = resolveTurnScope(session, turnMessageId)
  const digests = new Map<string, string>()
  const ids = structural.artifactVersionIds

  for (let start = 0; start < ids.length; start += DIGEST_CONCURRENCY) {
    await Promise.all(
      ids.slice(start, start + DIGEST_CONCURRENCY).map(async (id) => {
        let resolved: Awaited<ReturnType<ArtifactVersionContentResolver>> | undefined
        let resolutionError: unknown
        try {
          resolved = resolveArtifactVersion
            ? await resolveArtifactVersion({ projectId: session.projectId, versionId: id })
            : undefined
        } catch (error) {
          resolutionError = error
        }

        const path =
          resolved?.path ?? resolveArtifactPath(artifactStorageRoot, session.projectId, id)
        const digest = await computeArtifactDigest(path)
        if (digest === undefined) {
          if (resolutionError) throw resolutionError
          throw new Error(`Artifact content is unavailable while freezing Review scope: ${id}`)
        }
        if (resolved?.checksum && digest !== `sha256:${resolved.checksum}`) {
          throw new Error(`Artifact Version checksum changed while freezing Review scope: ${id}`)
        }
        digests.set(id, digest)
      })
    )
  }

  return resolveTurnScope(session, turnMessageId, digests)
}
