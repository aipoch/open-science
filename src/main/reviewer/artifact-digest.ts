import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

import type { TurnScope } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { resolveArtifactPath } from './host-sdk'
import { resolveTurnScope } from './scope'

// Digest of an artifact's CURRENT on-disk bytes. Preferring a content hash means an external edit that
// preserves size and mtime is still detected; the size+mtime fallback keeps a signal when the bytes
// cannot be read in full, and a fully unreadable/missing artifact stays undefined (hashed as null,
// still distinct from any present digest).
const computeArtifactDigest = async (path: string): Promise<string | undefined> => {
  try {
    return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`
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
// only the turn's own artifacts are read for hashing.
export const resolveTurnScopeWithArtifactDigests = async (
  session: PersistedChatSession,
  turnMessageId: string,
  artifactStorageRoot: string
): Promise<TurnScope> => {
  const structural = resolveTurnScope(session, turnMessageId)
  const digests = new Map<string, string>()

  await Promise.all(
    structural.artifactVersionIds.map(async (id) => {
      let path: string
      try {
        path = resolveArtifactPath(artifactStorageRoot, session.projectId, id)
      } catch {
        return
      }

      const digest = await computeArtifactDigest(path)
      if (digest !== undefined) digests.set(id, digest)
    })
  )

  return resolveTurnScope(session, turnMessageId, digests)
}
