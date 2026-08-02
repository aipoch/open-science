import { createContext, useContext } from 'react'

const WorkspaceMessageEditStateContext = createContext(false)

const useWorkspaceMessageEditState = (): boolean => useContext(WorkspaceMessageEditStateContext)

export { WorkspaceMessageEditStateContext, useWorkspaceMessageEditState }
