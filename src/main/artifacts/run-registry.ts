type ArtifactRunClaim = {
  claimId: string
  projectName: string
  artifactSessionId: string
  sessionId: string
  runId: string
  finalizedMessageId?: string
}

type RegisterArtifactRunClaimRequest = {
  projectName: string
  artifactSessionId: string
  sessionId: string
  runId: string
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
      ...request
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

  // Run ids of claims registered but not yet finalized — files that have been emitted to the renderer
  // and are awaiting its finalize call. The orphan scan must exclude these (a normal file mid-handoff,
  // not an orphan) in addition to prompt-in-flight runs, since a run leaves the runtime's active set at
  // stop, before the renderer finalizes. In-memory only, so a crash clears them and they resurface.
  getUnfinalizedRunIds(): string[] {
    const runIds: string[] = []
    for (const claim of this.claims.values()) {
      if (!claim.finalizedMessageId) runIds.push(claim.runId)
    }
    return runIds
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
