import { useSessionStore } from '../../stores/session-store'
import type { useAcpRuntime } from './useAcpRuntime'

type WorkspaceSessionDeletionResult =
  | { status: 'deleted'; runtimeDetached: true }
  | { status: 'failed'; reason: 'runtime'; runtimeDetached: false }
  | { status: 'failed'; reason: 'persistence'; runtimeDetached: true }

type DeleteWorkspaceSessionOptions = { runtimeDetached?: boolean }
type WorkspaceDeletionRuntime = Pick<ReturnType<typeof useAcpRuntime>, 'deleteSession'>
type PersistSessionDeletion = (request: { projectId: string; sessionId: string }) => Promise<void>

type WorkspaceSessionDeletion = (
  sessionId: string,
  options?: DeleteWorkspaceSessionOptions
) => Promise<WorkspaceSessionDeletionResult>

// Deletes in three ordered ownership layers: agent runtime, durable JSON/DB coordinator, then
// renderer state. Failures stay deletion-scoped instead of mutating the Session run projection.
const deleteWorkspaceSession = async (
  runtime: WorkspaceDeletionRuntime,
  sessionId: string,
  persistDeletion: PersistSessionDeletion = window.api.sessions.deleteSession,
  options: DeleteWorkspaceSessionOptions = {}
): Promise<WorkspaceSessionDeletionResult> => {
  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId)
  if (!session?.projectId) {
    console.warn('Session deletion target is unavailable', { sessionId })
    return { status: 'failed', reason: 'runtime', runtimeDetached: false }
  }

  let runtimeDetached = options.runtimeDetached === true
  if (!runtimeDetached) {
    try {
      const snapshot = await runtime.deleteSession(sessionId)
      runtimeDetached = Boolean(snapshot && !snapshot.sessionIds.includes(sessionId))
    } catch (error) {
      console.warn('Session runtime deletion failed', error)
    }
    if (!runtimeDetached) {
      return { status: 'failed', reason: 'runtime', runtimeDetached: false }
    }
  }

  try {
    await persistDeletion({ projectId: session.projectId, sessionId })
  } catch (error) {
    console.warn('Session persistence deletion failed', error)
    return { status: 'failed', reason: 'persistence', runtimeDetached: true }
  }

  useSessionStore.getState().deleteSession(sessionId)
  return { status: 'deleted', runtimeDetached: true }
}

export { deleteWorkspaceSession }

export type {
  DeleteWorkspaceSessionOptions,
  WorkspaceDeletionRuntime,
  WorkspaceSessionDeletion,
  WorkspaceSessionDeletionResult
}
