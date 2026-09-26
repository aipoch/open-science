import { createContext, useContext } from 'react'
import type { LiteratureReference } from '../../../../../shared/session-persistence'

type LibraryReferenceActions = {
  projectId: string
  currentSessionId?: string
  canAddToCurrent: boolean
  add: (references: readonly LiteratureReference[], sessionId: string | null) => void
}

// Preview surfaces request an insertion; Workspace and its composer remain the only draft writers.
export const LibraryReferenceActionsContext = createContext<LibraryReferenceActions | undefined>(
  undefined
)

export const useLibraryReferenceActions = (): LibraryReferenceActions | undefined =>
  useContext(LibraryReferenceActionsContext)
