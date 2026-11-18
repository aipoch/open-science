import type { RuntimeSessionChanges } from '../../shared/runtime-session-projection'
import type { PersistedChatSession } from '../../shared/session-persistence'

// Only Main's pure runtime projection opts into this contract. Compatibility callers may mutate
// their input and continue to receive an isolated clone and full graph reconciliation.
export type RuntimeSessionMutationOptions = {
  readonly immutableCanonicalTranscript?: true
  // Evaluated after this mutation has produced its candidate. The owner binds the hint to the
  // exact projected transcript; unsupported batches return undefined and use the full save path.
  readonly getChanges?: (candidate: PersistedChatSession) => RuntimeSessionChanges | undefined
  // Called after the authoritative Session replacement commits and before derived writes.
  readonly onJsonCommitted?: () => void
}
