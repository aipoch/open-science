import { createContext } from 'react'

// Only original local transcripts opt into resolving catalog identities.
// Imported and standalone replay surfaces retain historical receipts by default.
export const LiteratureCandidateSessionContext = createContext<string | null>(null)
