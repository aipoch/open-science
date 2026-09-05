import type { AcpCreateSessionResponse } from '../../../../shared/acp'
import { DEFAULT_PERMISSION_PROFILE } from '../../../../shared/permission-profiles'
import { isSessionSizeLimitError } from '../../../../shared/session-persistence'
import { toPersistedSession, useSessionStore, type ChatSession } from '../../stores/session-store'
import { saveSessionInOrder } from '../session-persistence/session-persistence'
import type { useAcpRuntime } from './useAcpRuntime'
import { acquireWorkspacePromptPreparation } from './workspace-prompt-preparation-lock'

type WorkspaceMemoryRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'resetSessionContext'
>

const workspaceSession = (sessionId: string): ChatSession | undefined =>
  useSessionStore.getState().sessions.find((session) => session.id === sessionId)

const replaceWorkspaceProviderIdentity = (
  sessionId: string,
  replacement: AcpCreateSessionResponse
): void => {
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            agentFrameworkId: replacement.frameworkId ?? session.agentFrameworkId,
            agentBackendId: replacement.backendId ?? session.agentBackendId,
            providerSessionId: replacement.providerSessionId,
            providerContinuityToken: replacement.providerContinuityToken,
            updatedAt: Date.now()
          }
        : session
    )
  }))
}

const persistWorkspaceSession = async (sessionId: string): Promise<void> => {
  const session = workspaceSession(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  await saveSessionInOrder(toPersistedSession(session))
}

const reconfigureWorkspaceMemory = async (
  runtime: WorkspaceMemoryRuntime,
  sessionId: string,
  enabled: boolean,
  persistSession: (sessionId: string) => Promise<void> = persistWorkspaceSession,
  onPreparationStateChange?: (sessionId: string, inFlight: boolean) => void,
  onSessionSizeLimit?: (sessionId: string) => void
): Promise<void> => {
  const releasePreparation = acquireWorkspacePromptPreparation(sessionId, onPreparationStateChange)
  if (!releasePreparation) {
    throw new Error('Another Agent context update is already in progress.')
  }

  try {
    const session = workspaceSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const previousEnabled = session.memoryEnabled !== false
    if (previousEnabled === enabled) return

    useSessionStore.getState().setMemoryEnabled(sessionId, enabled)
    let contextReset = false
    try {
      await persistSession(sessionId)
      if (!runtime.state.sessionIds.includes(sessionId)) return

      const cwd = session.cwd || runtime.state.cwd
      if (!cwd) throw new Error('Choose a workspace folder before updating this Session.')
      const replacement = await runtime.resetSessionContext(
        sessionId,
        cwd,
        session.projectId,
        session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        enabled
      )
      contextReset = true
      replaceWorkspaceProviderIdentity(sessionId, replacement)
      useSessionStore.getState().openContextResetRuntimeSegment(sessionId)
      await persistSession(sessionId)
    } catch (error) {
      if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(sessionId)
      if (!contextReset) {
        useSessionStore.getState().setMemoryEnabled(sessionId, previousEnabled)
        await persistSession(sessionId).catch(() => undefined)
      }
      throw error
    }
  } finally {
    releasePreparation()
  }
}

export { reconfigureWorkspaceMemory, replaceWorkspaceProviderIdentity }
