type ArtifactRunClaim = {
  claimId: string
  projectId: string
  artifactSessionId: string
  sessionId: string
  runId: string
  artifactVersionIds?: string[]
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
  finalizedMessageId?: string
  registeredAt: number
  finalizedAt?: number
}

type RegisterArtifactRunClaimRequest = {
  projectId: string
  artifactSessionId: string
  sessionId: string
  runId: string
  artifactVersionIds?: string[]
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
}

// Keeps short-lived artifact run ownership in memory until the renderer finalizes a message.
class ArtifactRunRegistry {
  private static readonly finalizedClaimTtlMs = 5 * 60 * 1_000
  private static readonly unfinalizedClaimTtlMs = 60 * 60 * 1_000
  private sequence = 0
  private readonly claims = new Map<string, ArtifactRunClaim>()

  private pruneExpired(now: number): void {
    for (const [claimId, claim] of this.claims) {
      const expiresAt =
        claim.finalizedAt !== undefined
          ? claim.finalizedAt + ArtifactRunRegistry.finalizedClaimTtlMs
          : claim.registeredAt + ArtifactRunRegistry.unfinalizedClaimTtlMs
      if (now >= expiresAt) this.claims.delete(claimId)
    }
  }

  // Registers one generated run and returns an opaque claim id for renderer finalization.
  register(request: RegisterArtifactRunClaimRequest): string {
    const now = Date.now()
    this.pruneExpired(now)
    this.sequence += 1
    const claimId = `artifact-claim-${now}-${this.sequence}`

    this.claims.set(claimId, {
      claimId,
      ...request,
      registeredAt: now,
      artifactVersionIds: request.artifactVersionIds ? [...request.artifactVersionIds] : undefined
    })

    return claimId
  }

  // Resolves an opaque claim id back to the runtime-owned project/session/run tuple.
  resolve(claimId: string): ArtifactRunClaim {
    this.pruneExpired(Date.now())
    const claim = this.claims.get(claimId)

    if (!claim) {
      throw new Error(`Artifact run claim not found: ${claimId}`)
    }

    return claim
  }

  // Records the message that consumed a claim so finalize retries remain idempotent.
  markFinalized(claimId: string, messageId: string): void {
    const now = Date.now()
    this.pruneExpired(now)
    const claim = this.resolve(claimId)

    if (claim.finalizedMessageId && claim.finalizedMessageId !== messageId) {
      throw new Error(
        `Artifact run claim already finalized for message: ${claim.finalizedMessageId}`
      )
    }

    this.claims.set(claimId, {
      ...claim,
      finalizedMessageId: messageId,
      finalizedAt: claim.finalizedAt ?? now
    })
  }
}

export { ArtifactRunRegistry }
export type { ArtifactRunClaim, RegisterArtifactRunClaimRequest }
