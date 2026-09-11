import { createContext, useContext, useState, type ReactNode, type ReactElement } from 'react'

import type { ComposerDraft } from './workspace-composer-upload-controller'

type ComposerDraftOwner = {
  draftsRef: { current: Record<string, ComposerDraft> }
  versionsRef: { current: Record<string, number> }
  deletedDraftKeysRef: { current: Set<string> }
}

const createDraftOwner = (): ComposerDraftOwner => ({
  draftsRef: { current: {} as Record<string, ComposerDraft> },
  versionsRef: { current: {} as Record<string, number> },
  deletedDraftKeysRef: { current: new Set<string>() }
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
