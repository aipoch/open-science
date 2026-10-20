import { createContext } from 'react'

// Imported and standalone replay surfaces remain historical. Writable forks opt in
// only for activities whose canonical prompt belongs to the local continuation.
export const LiteratureCandidateSessionContext = createContext<{
  sessionId: string
  liveActivityIds?: ReadonlySet<string>
} | null>(null)
