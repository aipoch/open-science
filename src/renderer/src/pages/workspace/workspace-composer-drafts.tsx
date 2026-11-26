import { createContext, useContext, useState, type ReactElement, type ReactNode } from 'react'

import type { ComposerDraft, ComposerSendSnapshot } from './composer-contract'

type RestoreFailedSend = (
  snapshot: ComposerSendSnapshot,
  preserveOnConflict?: boolean,
  boundDraftKey?: string,
  reportConflict?: boolean
) => boolean

type ComposerDraftOwner = {
  draftsRef: { current: Record<string, ComposerDraft> }
  versionsRef: { current: Record<string, number> }
  deletedDraftKeysRef: { current: Set<string> }
  clearDraftRef: { current?: (draftKey: string, expectedVersion?: number) => boolean }
  restoreFailedSendRef: { current?: RestoreFailedSend }
}

const createDraftOwner = (): ComposerDraftOwner => ({
  draftsRef: { current: {} as Record<string, ComposerDraft> },
  versionsRef: { current: {} as Record<string, number> },
  deletedDraftKeysRef: { current: new Set<string>() },
  clearDraftRef: {},
  restoreFailedSendRef: {}
})

const ComposerDraftsContext = createContext<ComposerDraftOwner | null>(null)

// Live owner survives route changes. Web refresh snapshots are saved by composer-draft-storage.
export const WorkspaceComposerDraftsProvider = ({
  children
}: {
  children?: ReactNode
}): ReactElement => {
  const [owner] = useState(createDraftOwner)
  return <ComposerDraftsContext.Provider value={owner}>{children}</ComposerDraftsContext.Provider>
}

// The context and its hook form one small owner module.
// eslint-disable-next-line react-refresh/only-export-components
export const useWorkspaceComposerDrafts = (): ComposerDraftOwner => {
  const owner = useContext(ComposerDraftsContext)
  const [localOwner] = useState(createDraftOwner)
  return owner ?? localOwner
}
