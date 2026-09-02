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
  private sequence = 0
  private readonly claims = new Map<string, ArtifactRunClaim>()

  // Registers one generated run and returns an opaque claim id for renderer finalization.
  register(request: RegisterArtifactRunClaimRequest): string {
    this.sequence += 1
    const claimId = `artifact-claim-${Date.now()}-${this.sequence}`

    this.claims.set(claimId, {
      claimId,
      ...request,
      artifactVersionIds: request.artifactVersionIds ? [...request.artifactVersionIds] : undefined
    })

    return claimId
  }

  // Resolves an opaque claim id back to the runtime-owned project/session/run tuple.
  resolve(claimId: string): ArtifactRunClaim {
    const claim = this.claims.get(claimId)

    if (!claim) {
      throw new Error(`Artifact run claim not found: ${claimId}`)
    }

    return claim
  }

  // Records the message that consumed a claim so finalize retries remain idempotent.
  markFinalized(claimId: string, messageId: string): void {
    const claim = this.resolve(claimId)

    if (claim.finalizedMessageId && claim.finalizedMessageId !== messageId) {
      throw new Error(
        `Artifact run claim already finalized for message: ${claim.finalizedMessageId}`
      )
    }

    this.claims.set(claimId, {
      ...claim,
      finalizedMessageId: messageId
    })
  }
}

export { ArtifactRunRegistry }
export type { ArtifactRunClaim, RegisterArtifactRunClaimRequest }
