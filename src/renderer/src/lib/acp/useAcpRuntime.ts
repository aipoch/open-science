import type {
  AcpCreateSessionResponse,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../../../shared/acp'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'

// Provides a stable renderer fallback before the first main-process snapshot arrives.
const emptyAcpState: AcpStateSnapshot = {
  status: 'idle',
  cwd: '',
  sessionIds: [],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
}

type SnapshotAction = () => Promise<AcpStateSnapshot>
type ValueAction<Value> = () => Promise<Value>
type PendingSetter = Dispatch<SetStateAction<boolean>>

// Normalizes thrown values from IPC calls into UI-safe text.
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

// Centralizes renderer access to the main-process runtime IPC surface.
const useAcpRuntime = (): {
  state: AcpStateSnapshot
  actionError: string | null
  isConnecting: boolean
  isDisconnecting: boolean
  connect: (cwd?: string) => Promise<AcpStateSnapshot | undefined>
  disconnect: () => Promise<AcpStateSnapshot | undefined>
  createSession: (
    cwd?: string,
    projectName?: string,
    permissionProfile?: PermissionProfileId
  ) => Promise<AcpCreateSessionResponse>
  resumeSession: (
    sessionId: AcpResumeSessionRequest['sessionId'],
    cwd: AcpResumeSessionRequest['cwd'],
    projectName?: string,
    permissionProfile?: PermissionProfileId
  ) => Promise<AcpCreateSessionResponse>
  resetSessionContext: (
    sessionId: AcpResumeSessionRequest['sessionId'],
    cwd: AcpResumeSessionRequest['cwd'],
    projectName?: string,
    permissionProfile?: PermissionProfileId
  ) => Promise<AcpCreateSessionResponse>
  deleteSession: (sessionId: string) => Promise<AcpStateSnapshot | undefined>
  cancel: (sessionId: string) => Promise<AcpStateSnapshot | undefined>
  sendPrompt: (
    sessionId: string,
    text: string,
    attachments?: AcpPromptRequest['attachments'],
    forcedSkillIds?: string[],
    referencedArtifacts?: AcpPromptRequest['referencedArtifacts'],
    historyPreamble?: AcpPromptRequest['historyPreamble']
  ) => Promise<AcpStateSnapshot | undefined>
  respondToPermission: (
    requestId: string,
    optionId?: string
  ) => Promise<AcpStateSnapshot | undefined>
  setPermissionProfile: (
    sessionId: string,
    profile: PermissionProfileId
  ) => Promise<AcpStateSnapshot | undefined>
  revokePermissionGrant: (
    sessionId: string,
    categoryKey: string
  ) => Promise<AcpStateSnapshot | undefined>
} => {
  const [state, setState] = useState<AcpStateSnapshot>(emptyAcpState)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  // Loads the initial snapshot and keeps state fresh through runtime broadcasts.
  useEffect(() => {
    let isMounted = true

    // Avoids setting React state after the component using the hook unmounts.
    const applySnapshot = (snapshot: AcpStateSnapshot): void => {
      if (isMounted) {
        setState(snapshot)
      }
    }

    // Pulls current runtime state before any broadcast has arrived.
    const loadInitialState = async (): Promise<void> => {
      try {
        applySnapshot(await window.api.acp.getState())
      } catch (error) {
        if (isMounted) {
          setActionError(getErrorMessage(error))
        }
      }
    }

    const removeStateListener = window.api.acp.onState(applySnapshot)

    void loadInitialState()

    return () => {
      isMounted = false
      removeStateListener()
    }
  }, [])

  // Runs an IPC action that returns a full runtime snapshot.
  const runSnapshotAction = useCallback(
    async (
      setPending: PendingSetter | undefined,
      action: SnapshotAction
    ): Promise<AcpStateSnapshot | undefined> => {
      setActionError(null)
      setPending?.(true)

      try {
        const snapshot = await action()
        setState(snapshot)
        return snapshot
      } catch (error) {
        setActionError(getErrorMessage(error))
        return undefined
      } finally {
        setPending?.(false)
      }
    },
    []
  )

  // Runs an IPC action that returns a non-snapshot value such as a new session id.
  // Unlike runSnapshotAction, failures are rethrown so callers can react to the specific
  // error (e.g. a resumed session whose workspace folder no longer exists) instead of
  // only seeing a generic "it failed" signal.
  const runValueAction = useCallback(
    async <Value>(
      setPending: PendingSetter | undefined,
      action: ValueAction<Value>
    ): Promise<Value> => {
      setActionError(null)
      setPending?.(true)

      try {
        return await action()
      } catch (error) {
        setActionError(getErrorMessage(error))
        throw error
      } finally {
        setPending?.(false)
      }
    },
    []
  )

  // Keep all renderer ACP IPC calls in one hook so the future conversation UI can reuse it.
  // Opens or reopens the runtime connection for a workspace directory.
  const connect = useCallback(
    (cwd?: string) => runSnapshotAction(setIsConnecting, () => window.api.acp.connect({ cwd })),
    [runSnapshotAction]
  )

  // Disconnects the agent process and clears runtime-side sessions.
  const disconnect = useCallback(
    () => runSnapshotAction(setIsDisconnecting, () => window.api.acp.disconnect()),
    [runSnapshotAction]
  )

  // Creates a protocol session and returns the runtime-provided id.
  const createSession = useCallback(
    (cwd?: string, projectName?: string, permissionProfile?: PermissionProfileId) =>
      runValueAction(setIsConnecting, () =>
        window.api.acp.createSession({ cwd, projectName, permissionProfile })
      ),
    [runValueAction]
  )

  // Reattaches an agent-side session that was restored from local persisted state.
  const resumeSession = useCallback(
    (
      sessionId: AcpResumeSessionRequest['sessionId'],
      cwd: AcpResumeSessionRequest['cwd'],
      projectName?: string,
      permissionProfile?: PermissionProfileId
    ) =>
      runValueAction(setIsConnecting, () =>
        window.api.acp.resumeSession({ sessionId, cwd, projectName, permissionProfile })
      ),
    [runValueAction]
  )

  // Drops the agent-side context for a session whose accumulated history outgrew the request limit,
  // adopting a fresh agent session so the next prompt can replay a bounded text transcript.
  const resetSessionContext = useCallback(
    (
      sessionId: AcpResumeSessionRequest['sessionId'],
      cwd: AcpResumeSessionRequest['cwd'],
      projectName?: string,
      permissionProfile?: PermissionProfileId
    ) =>
      runValueAction(setIsConnecting, () =>
        window.api.acp.resetSessionContext({ sessionId, cwd, projectName, permissionProfile })
      ),
    [runValueAction]
  )

  // Deletes a runtime session and returns the updated snapshot if it succeeds.
  const deleteSession = useCallback(
    (sessionId: string) =>
      runSnapshotAction(undefined, () => window.api.acp.deleteSession({ sessionId })),
    [runSnapshotAction]
  )

  // Requests cancellation for one session without assuming the stop has arrived.
  const cancel = useCallback(
    (sessionId: string) => runSnapshotAction(undefined, () => window.api.acp.cancel({ sessionId })),
    [runSnapshotAction]
  )

  // Sends a prompt turn plus any finalized upload references to one runtime session.
  const sendPrompt = useCallback(
    (
      sessionId: AcpPromptRequest['sessionId'],
      text: AcpPromptRequest['text'],
      attachments?: AcpPromptRequest['attachments'],
      forcedSkillIds?: string[],
      referencedArtifacts?: AcpPromptRequest['referencedArtifacts'],
      historyPreamble?: AcpPromptRequest['historyPreamble']
    ) =>
      runSnapshotAction(undefined, () =>
        window.api.acp.sendPrompt({
          sessionId,
          text,
          attachments,
          // Omit the field entirely when no skills were picked so the request stays minimal.
          ...(forcedSkillIds && forcedSkillIds.length > 0 ? { forcedSkillIds } : {}),
          // Same minimal-request rule for `@`-mentioned artifacts.
          ...(referencedArtifacts && referencedArtifacts.length > 0 ? { referencedArtifacts } : {}),
          // Only present right after a context reset, when a transcript is replayed for continuity.
          ...(historyPreamble ? { historyPreamble } : {})
        })
      ),
    [runSnapshotAction]
  )

  // Converts a UI permission click into the response shape expected by IPC.
  const respondToPermission = useCallback(
    (requestId: string, optionId?: string) => {
      const response: AcpPermissionResponse = {
        requestId,
        optionId,
        cancelled: !optionId
      }

      return runSnapshotAction(undefined, () => window.api.acp.respondToPermission(response))
    },
    [runSnapshotAction]
  )

  const setPermissionProfile = useCallback(
    (sessionId: string, profile: PermissionProfileId) => {
      const request: AcpSetPermissionProfileRequest = { sessionId, profile }

      return runSnapshotAction(undefined, () => window.api.acp.setPermissionProfile(request))
    },
    [runSnapshotAction]
  )

  // Drops one always-allow grant for a session and applies the returned snapshot.
  const revokePermissionGrant = useCallback(
    (sessionId: string, categoryKey: string) => {
      const request: AcpRevokePermissionGrantRequest = { sessionId, categoryKey }

      return runSnapshotAction(undefined, () => window.api.acp.revokePermissionGrant(request))
    },
    [runSnapshotAction]
  )

  return {
    state,
    actionError,
    isConnecting,
    isDisconnecting,
    connect,
    disconnect,
    createSession,
    resumeSession,
    resetSessionContext,
    deleteSession,
    cancel,
    sendPrompt,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  }
}

export { useAcpRuntime }
