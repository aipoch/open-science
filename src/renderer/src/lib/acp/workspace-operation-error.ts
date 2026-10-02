import { create } from 'zustand'

// Operation failures belong to the initiating surface, never to the durable Session projection.
// Keep the Session identity so an asynchronous rejection cannot appear in another conversation.
const useWorkspaceOperationErrors = create<{
  errors: Record<string, string>
}>(() => ({ errors: {} }))

const reportWorkspaceOperationError = (sessionId: string, error: string): void => {
  useWorkspaceOperationErrors.setState(({ errors }) => ({
    errors: { ...errors, [sessionId]: error }
  }))
}

const clearWorkspaceOperationError = (sessionId: string): void => {
  useWorkspaceOperationErrors.setState(({ errors }) => {
    if (!Object.hasOwn(errors, sessionId)) return { errors }
    const next = { ...errors }
    delete next[sessionId]
    return { errors: next }
  })
}

export { useWorkspaceOperationErrors, reportWorkspaceOperationError, clearWorkspaceOperationError }
