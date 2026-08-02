import type { ReactNode } from 'react'

import { WorkspaceMessageEditStateContext } from './workspace-message-edit-state-context'

type WorkspaceMessageEditStateProviderProps = {
  canEditMessage: boolean
  children: ReactNode
}

// Editing availability changes with reviewer lifecycle, but only sent user messages need that signal.
// Keeping it in a narrow context lets those controls update without invalidating the transcript parent.
const WorkspaceMessageEditStateProvider = ({
  canEditMessage,
  children
}: WorkspaceMessageEditStateProviderProps): React.JSX.Element => (
  <WorkspaceMessageEditStateContext.Provider value={canEditMessage}>
    {children}
  </WorkspaceMessageEditStateContext.Provider>
)

export { WorkspaceMessageEditStateProvider }
