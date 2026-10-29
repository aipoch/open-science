import {
  getDesktopRuntimeEpoch,
  registerDesktopRecoveryReader,
  useDesktopRuntimeRecoveryStore
} from '../../stores/desktop-runtime-recovery-store'
import type {
  AcpContinueInterruptedTurnRequest,
  AcpCreateSessionResponse,
  AcpSessionAgentTarget,
  ElicitationResponse,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpRuntimeEvent,
  AcpRuntimeState,
  AcpSetPermissionProfileRequest,
  AcpStateCommandResponse,
  AcpStateSnapshot,
  AcpStateUpdate
} from '../../../../shared/acp'
import { DesktopRuntimeDisconnectedError } from '../../../../shared/desktop-runtime-recovery'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  acceptAcpRuntimeSnapshotRevision,
  getAcpRuntimeSnapshotScope
} from './runtime-snapshot-revision-owner'
import {
  createRuntimeEventSubscriptionOwner,
  type RuntimeEventListener
} from './runtime-event-subscription-owner'

// Provides a stable renderer fallback before the first main-process snapshot arrives.
const emptyAcpState: AcpStateSnapshot = {
  status: 'idle',
  cwd: '',
  sessionIds: [],
  events: [],
  pendingPermissions: [],
  pendingElicitations: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  agentPromptInFlightSessionIds: [],
  promptInFlightSessionIds: []
}

type StateCommandAction = () => Promise<AcpStateCommandResponse | AcpStateSnapshot>
type ValueAction<Value> = () => Promise<Value>
type PendingSetter = Dispatch<SetStateAction<boolean>>

// Normalizes thrown values from IPC calls into UI-safe text.
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

const awaitCurrentEpoch = async <Value>(epoch: number, work: Promise<Value>): Promise<Value> => {
  const assertCurrent = (): void => {
    if (epoch !== getDesktopRuntimeEpoch()) throw new DesktopRuntimeDisconnectedError()
  }
  try {
    const value = await work
    assertCurrent()
    return value
  } catch (error) {
    assertCurrent()
    throw error
  }
}

// Centralizes renderer access to the main-process runtime IPC surface.
const useAcpRuntime = (): {
  state: AcpStateSnapshot
  reconcileSnapshot: (snapshot: AcpStateSnapshot) => void
  subscribeRuntimeEvents?: (listener: RuntimeEventListener) => () => void
  currentRuntimeEvents: () => readonly AcpRuntimeEvent[]
  actionError: string | null
  isConnecting: boolean
  isDisconnecting: boolean
  connect: (cwd?: string) => Promise<AcpRuntimeState | undefined>
  disconnect: () => Promise<AcpRuntimeState | undefined>
  createSession: (
    cwd?: string,
    projectId?: string,
    permissionProfile?: PermissionProfileId,
    specialistId?: string,
    agentTarget?: AcpSessionAgentTarget,
    memoryEnabled?: boolean,
    literatureContext?: true,
    setupSessionToken?: string
  ) => Promise<AcpCreateSessionResponse>
  resumeSession: (
    sessionId: AcpResumeSessionRequest['sessionId'],
    cwd: AcpResumeSessionRequest['cwd'],
    projectId?: string,
    permissionProfile?: PermissionProfileId,
    previousFrameworkId?: AcpResumeSessionRequest['previousFrameworkId'],
    previousBackendId?: AcpResumeSessionRequest['previousBackendId'],
    specialistId?: AcpResumeSessionRequest['specialistId'],
    providerSessionId?: AcpResumeSessionRequest['providerSessionId'],
    providerContinuityToken?: AcpResumeSessionRequest['providerContinuityToken'],
    specialistBindingPending?: AcpResumeSessionRequest['specialistBindingPending'],
    agentTarget?: AcpSessionAgentTarget,
    memoryEnabled?: boolean
  ) => Promise<AcpCreateSessionResponse>
  continueInterruptedTurn: (request: AcpContinueInterruptedTurnRequest) => Promise<AcpRuntimeState>
  resetSessionContext: (
    sessionId: AcpResumeSessionRequest['sessionId'],
    cwd: AcpResumeSessionRequest['cwd'],
    projectId?: string,
    permissionProfile?: PermissionProfileId,
    memoryEnabled?: boolean
  ) => Promise<AcpCreateSessionResponse>
  compactSession: (
    sessionId: string,
    reason?: 'manual' | 'overflow-recovery'
  ) => Promise<AcpRuntimeState | undefined>
  deleteSession: (sessionId: string) => Promise<AcpRuntimeState | undefined>
  cancel: (sessionId: string) => Promise<AcpRuntimeState | undefined>
  steerFollowUp: (request: AcpSteerFollowUpRequest) => Promise<AcpSteerFollowUpResult>
  sendPrompt: (
    sessionId: string,
    text: string,
    attachments?: AcpPromptRequest['attachments'],
    forcedSkillIds?: string[],
    referencedArtifacts?: AcpPromptRequest['referencedArtifacts'],
    historyPreamble?: AcpPromptRequest['historyPreamble'],
    historyAttachments?: AcpPromptRequest['historyAttachments'],
    historyImages?: AcpPromptRequest['historyImages'],
    resumeFallback?: AcpPromptRequest['resumeFallback'],
    provenanceContext?: AcpPromptRequest['provenanceContext'],
    contextReset?: AcpPromptRequest['contextReset'],
    turnIntent?: AcpPromptRequest['turnIntent'],
    memoryEnabled?: boolean,
    referencedSessions?: AcpPromptRequest['referencedSessions'],
    currentImages?: AcpPromptRequest['currentImages'],
    parts?: AcpPromptRequest['parts']
  ) => Promise<AcpRuntimeState>
  respondToPermission: (
    requestId: string,
    optionId?: string,
    restored?: AcpPermissionResponse['restored']
  ) => Promise<AcpRuntimeState>
  respondToElicitation: (response: ElicitationResponse) => Promise<AcpRuntimeState>
  setPermissionProfile: (
    sessionId: string,
    profile: PermissionProfileId
  ) => Promise<AcpRuntimeState | undefined>
  revokePermissionGrant: (
    sessionId: string,
    categoryKey: string
  ) => Promise<AcpRuntimeState | undefined>
} => {
  const [state, setState] = useState<AcpStateSnapshot>(emptyAcpState)
  const stateRef = useRef(state)
  const serviceScopeRef = useRef(getAcpRuntimeSnapshotScope())
  const [actionError, setActionError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const actionGenerationRef = useRef(0)
  const pendingActionCountsRef = useRef(new Map<PendingSetter, number>())
  const [runtimeEventOwner] = useState(createRuntimeEventSubscriptionOwner)
  const eventSnapshotInitializedRef = useRef(false)
  const onRuntimeEvent = (window.api.acp as Partial<Pick<typeof window.api.acp, 'onEvent'>>).onEvent
  const subscribeRuntimeEvents = onRuntimeEvent ? runtimeEventOwner.subscribe : undefined

  const prepareServiceSnapshot = useCallback((): void => {
    const scope = getAcpRuntimeSnapshotScope()
    if (serviceScopeRef.current === scope) return
    serviceScopeRef.current = scope
    runtimeEventOwner.reset()
    eventSnapshotInitializedRef.current = false
  }, [runtimeEventOwner])

  const normalizeCommandState = useCallback(
    (response: AcpStateCommandResponse | AcpStateSnapshot): AcpStateUpdate => {
      if ('result' in response) return { ...response.result, revision: response.revision }
      return response
    },
    []
  )

  const applyStateUpdate = useCallback(
    (update: AcpStateUpdate): void => {
      prepareServiceSnapshot()
      if (!acceptAcpRuntimeSnapshotRevision(update)) return
      if (update.events) {
        eventSnapshotInitializedRef.current = true
        runtimeEventOwner.observeSnapshot(update.events, update as AcpStateSnapshot)
        stateRef.current = update as AcpStateSnapshot
        setState(stateRef.current)
        return
      }
      // Preserve the explicit synchronization window loaded at startup. It remains the fallback for
      // an older Main without acp:event; current incremental consumers read the event owner instead.
      const snapshot = { ...update, events: stateRef.current.events }
      if (!acceptAcpRuntimeSnapshotRevision(snapshot)) return
      stateRef.current = snapshot
      setState(snapshot)
    },
    [prepareServiceSnapshot, runtimeEventOwner]
  )

  const applySnapshot = useCallback(
    (snapshot: AcpStateSnapshot): void => {
      prepareServiceSnapshot()
      if (!acceptAcpRuntimeSnapshotRevision(snapshot)) return
      eventSnapshotInitializedRef.current = true
      runtimeEventOwner.observeSnapshot(snapshot.events, snapshot)
      stateRef.current = snapshot
      setState(snapshot)
    },
    [prepareServiceSnapshot, runtimeEventOwner]
  )

  const applyInitialSnapshot = useCallback(
    (snapshot: AcpStateSnapshot): void => {
      prepareServiceSnapshot()
      if (!eventSnapshotInitializedRef.current) {
        // Event initialization is an independent barrier. A newer state-only broadcast may already
        // own the state watermark, but the initial full snapshot must still release queued events.
        eventSnapshotInitializedRef.current = true
        runtimeEventOwner.observeInitialSnapshot(snapshot.events, snapshot)
      }
      if (!acceptAcpRuntimeSnapshotRevision(snapshot)) return
      stateRef.current = snapshot
      setState(snapshot)
    },
    [prepareServiceSnapshot, runtimeEventOwner]
  )

  useEffect(
    () =>
      registerDesktopRecoveryReader(async () => {
        const epoch = getDesktopRuntimeEpoch()
        const snapshot = await awaitCurrentEpoch(epoch, window.api.acp.getState())
        applySnapshot(snapshot)
      }),
    [applySnapshot]
  )

  // Loads the initial snapshot and keeps state fresh through runtime broadcasts.
  useEffect(() => {
    let isMounted = true
    let hasPushedSnapshot = false

    // Avoids setting React state after the component using the hook unmounts.
    const applyMountedState = (state: AcpStateUpdate): void => {
      if (isMounted) applyStateUpdate(state)
    }

    // Pulls current runtime state before any broadcast has arrived.
    const loadInitialState = async (): Promise<void> => {
      const epoch = getDesktopRuntimeEpoch()
      try {
        const snapshot = await awaitCurrentEpoch(epoch, window.api.acp.getState())
        // Older Main versions do not publish revisions. In that compatibility case, a pushed
        // snapshot received after subscription is the only safe authority over the initial pull.
        if (!hasPushedSnapshot || snapshot.revision !== undefined) {
          if (isMounted) applyInitialSnapshot(snapshot)
        }
      } catch (error) {
        if (isMounted && epoch === getDesktopRuntimeEpoch()) {
          runtimeEventOwner.observeInitialSnapshot([])
          setActionError(getErrorMessage(error))
        }
      }
    }

    const removeStateListener = window.api.acp.onState((state) => {
      hasPushedSnapshot = true
      applyMountedState(state)
    })
    const removeEventListener = onRuntimeEvent?.((events: readonly AcpRuntimeEvent[]) => {
      if (!isMounted) return
      prepareServiceSnapshot()
      runtimeEventOwner.observeEvents(events)
    })

    void loadInitialState()

    return () => {
      isMounted = false
      removeStateListener()
      removeEventListener?.()
    }
  }, [
    applyInitialSnapshot,
    applyStateUpdate,
    onRuntimeEvent,
    prepareServiceSnapshot,
    runtimeEventOwner
  ])

  useEffect(
    () =>
      useDesktopRuntimeRecoveryStore.subscribe((next, previous) => {
        if (next.epoch === previous.epoch) return
        actionGenerationRef.current += 1
        pendingActionCountsRef.current.clear()
        setIsConnecting(false)
        setIsDisconnecting(false)
        setActionError(null)
      }),
    []
  )

  const beginAction = useCallback((setPending?: PendingSetter): number => {
    const generation = ++actionGenerationRef.current
    setActionError(null)
    if (setPending) {
      const count = (pendingActionCountsRef.current.get(setPending) ?? 0) + 1
      pendingActionCountsRef.current.set(setPending, count)
      if (count === 1) setPending(true)
    }
    return generation
  }, [])

  const finishPendingAction = useCallback((setPending?: PendingSetter): void => {
    if (!setPending) return
    const remaining = (pendingActionCountsRef.current.get(setPending) ?? 1) - 1
    if (remaining > 0) pendingActionCountsRef.current.set(setPending, remaining)
    else {
      pendingActionCountsRef.current.delete(setPending)
      setPending(false)
    }
  }, [])

  // Runs an IPC action that returns a lightweight runtime-state command response. The legacy
  // snapshot branch keeps a new renderer usable during a rolling development reload.
  const runSnapshotAction = useCallback(
    async (
      setPending: PendingSetter | undefined,
      action: StateCommandAction
    ): Promise<AcpRuntimeState | undefined> => {
      const epoch = getDesktopRuntimeEpoch()
      const generation = beginAction(setPending)

      try {
        const response = await awaitCurrentEpoch(epoch, action())
        const state = normalizeCommandState(response)
        applyStateUpdate(state)
        return state
      } catch (error) {
        if (epoch === getDesktopRuntimeEpoch() && generation === actionGenerationRef.current)
          setActionError(getErrorMessage(error))
        return undefined
      } finally {
        if (epoch === getDesktopRuntimeEpoch()) finishPendingAction(setPending)
      }
    },
    [applyStateUpdate, beginAction, finishPendingAction, normalizeCommandState]
  )

  // Runs an IPC action that returns a non-snapshot value such as a new session id.
  // Unlike runSnapshotAction, failures are rethrown so callers can react to the specific
  // error (e.g. a resumed session whose workspace folder no longer exists) instead of
  // only seeing a generic "it failed" signal.
  const runValueAction = useCallback(
    async <Value>(
      setPending: PendingSetter | undefined,
      action: ValueAction<Value>,
      recordActionError = true
    ): Promise<Value> => {
      const epoch = getDesktopRuntimeEpoch()
      const generation = beginAction(setPending)

      try {
        const value = await awaitCurrentEpoch(epoch, action())
        return value
      } catch (error) {
        if (
          recordActionError &&
          epoch === getDesktopRuntimeEpoch() &&
          generation === actionGenerationRef.current
        )
          setActionError(getErrorMessage(error))
        throw error
      } finally {
        if (epoch === getDesktopRuntimeEpoch()) finishPendingAction(setPending)
      }
    },
    [beginAction, finishPendingAction]
  )

  // Prompt and native-compaction helper: rethrows errors (like runValueAction) but does NOT
  // record actionError on failure, avoiding stale-state reads in .catch() handlers. Also performs
  // the state-sync side-effect that runSnapshotAction provides, since callers use `void sendPrompt(...)`.
  const runPromptAction = useCallback(
    async (action: StateCommandAction): Promise<AcpRuntimeState> => {
      // Clear on entry so the helper is self-consistent with the other action helpers and does
      // not rely on WorkspacePage's active-session visibility gate to hide a stale actionError.
      const epoch = getDesktopRuntimeEpoch()
      beginAction()
      const response = await awaitCurrentEpoch(epoch, action())
      const state = normalizeCommandState(response)
      // Apply state-sync side-effect before returning, matching runSnapshotAction's contract.
      // Without this, callers that do `void runtime.sendPrompt(...)` would discard the snapshot
      // and the UI would show stale state until the next async IPC event fires.
      applyStateUpdate(state)
      return state
    },
    [applyStateUpdate, beginAction, normalizeCommandState]
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
    (
      cwd?: string,
      projectId?: string,
      permissionProfile?: PermissionProfileId,
      specialistId?: string,
      agentTarget?: AcpSessionAgentTarget,
      memoryEnabled = true,
      literatureContext?: true,
      setupSessionToken?: string
    ) =>
      runValueAction(setIsConnecting, () =>
        window.api.acp.createSession({
          cwd,
          projectId,
          permissionProfile,
          memoryEnabled,
          specialistId,
          ...(literatureContext ? { literatureContext } : {}),
          ...(setupSessionToken ? { setupSessionToken } : {}),
          ...(agentTarget ? { agentTarget } : {})
        })
      ),
    [runValueAction]
  )

  // Reattaches an agent-side session that was restored from local persisted state.
  const resumeSession = useCallback(
    (
      sessionId: AcpResumeSessionRequest['sessionId'],
      cwd: AcpResumeSessionRequest['cwd'],
      projectId?: string,
      permissionProfile?: PermissionProfileId,
      previousFrameworkId?: AcpResumeSessionRequest['previousFrameworkId'],
      previousBackendId?: AcpResumeSessionRequest['previousBackendId'],
      specialistId?: AcpResumeSessionRequest['specialistId'],
      providerSessionId?: AcpResumeSessionRequest['providerSessionId'],
      providerContinuityToken?: AcpResumeSessionRequest['providerContinuityToken'],
      specialistBindingPending?: AcpResumeSessionRequest['specialistBindingPending'],
      agentTarget?: AcpSessionAgentTarget,
      memoryEnabled = true
    ) =>
      runValueAction(
        setIsConnecting,
        () =>
          window.api.acp.resumeSession({
            sessionId,
            cwd,
            projectId,
            permissionProfile,
            memoryEnabled,
            previousFrameworkId,
            previousBackendId,
            specialistId,
            providerSessionId,
            providerContinuityToken,
            specialistBindingPending,
            ...(agentTarget ? { agentTarget } : {})
          }),
        // The caller owns this Session's error surface; a global error leaks into new chats.
        false
      ),
    [runValueAction]
  )

  const continueInterruptedTurn = useCallback(
    (request: AcpContinueInterruptedTurnRequest) =>
      runPromptAction(() => window.api.acp.continueInterruptedTurn(request)),
    [runPromptAction]
  )

  // Drops the agent-side context for a session whose accumulated history outgrew the request limit,
  // adopting a fresh agent session so the next prompt can replay a bounded text transcript.
  const resetSessionContext = useCallback(
    (
      sessionId: AcpResumeSessionRequest['sessionId'],
      cwd: AcpResumeSessionRequest['cwd'],
      projectId?: string,
      permissionProfile?: PermissionProfileId,
      memoryEnabled = true
    ) =>
      runValueAction(setIsConnecting, () =>
        window.api.acp.resetSessionContext({
          sessionId,
          cwd,
          projectId,
          permissionProfile,
          memoryEnabled
        })
      ),
    [runValueAction]
  )

  // Asks the active agent framework to compact its own session context.
  const compactSession = useCallback(
    (sessionId: string, reason?: 'manual' | 'overflow-recovery') =>
      runPromptAction(() =>
        window.api.acp.compactSession({ sessionId, ...(reason ? { reason } : {}) })
      ),
    [runPromptAction]
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

  const steerFollowUp = useCallback(
    (request: AcpSteerFollowUpRequest) => window.api.acp.steerFollowUp(request),
    []
  )

  // Sends a prompt turn plus any finalized upload references to one runtime session.
  const sendPrompt = useCallback(
    (
      sessionId: AcpPromptRequest['sessionId'],
      text: AcpPromptRequest['text'],
      attachments?: AcpPromptRequest['attachments'],
      forcedSkillIds?: string[],
      referencedArtifacts?: AcpPromptRequest['referencedArtifacts'],
      historyPreamble?: AcpPromptRequest['historyPreamble'],
      historyAttachments?: AcpPromptRequest['historyAttachments'],
      historyImages?: AcpPromptRequest['historyImages'],
      resumeFallback?: AcpPromptRequest['resumeFallback'],
      provenanceContext?: AcpPromptRequest['provenanceContext'],
      contextReset?: AcpPromptRequest['contextReset'],
      turnIntent?: AcpPromptRequest['turnIntent'],
      memoryEnabled = true,
      referencedSessions?: AcpPromptRequest['referencedSessions'],
      currentImages?: AcpPromptRequest['currentImages'],
      parts?: AcpPromptRequest['parts']
    ) =>
      runPromptAction(() =>
        window.api.acp.sendPrompt({
          sessionId,
          text,
          memoryEnabled,
          attachments,
          // Omit the field entirely when no skills were picked so the request stays minimal.
          ...(forcedSkillIds && forcedSkillIds.length > 0 ? { forcedSkillIds } : {}),
          // Same minimal-request rule for `@`-mentioned artifacts.
          ...(referencedArtifacts && referencedArtifacts.length > 0 ? { referencedArtifacts } : {}),
          ...(referencedSessions && referencedSessions.length > 0 ? { referencedSessions } : {}),
          // Only present right after a context reset, when a transcript is replayed for continuity.
          ...(historyPreamble ? { historyPreamble } : {}),
          ...(historyAttachments && historyAttachments.length > 0 ? { historyAttachments } : {}),
          ...(historyImages && historyImages.length > 0 ? { historyImages } : {}),
          ...(currentImages && currentImages.length > 0 ? { currentImages } : {}),
          ...(parts && parts.length > 0 ? { parts } : {}),
          ...(resumeFallback ? { resumeFallback } : {}),
          ...(provenanceContext ? { provenanceContext } : {}),
          ...(contextReset ? { contextReset: true } : {}),
          ...(turnIntent ? { turnIntent } : {})
        })
      ),
    [runPromptAction]
  )

  // Converts a UI permission click into the response shape expected by IPC.
  const respondToPermission = useCallback(
    async (
      requestId: string,
      optionId?: string,
      restored?: AcpPermissionResponse['restored']
    ): Promise<AcpRuntimeState> => {
      const response: AcpPermissionResponse = {
        requestId,
        optionId,
        cancelled: !optionId,
        ...(restored ? { restored } : {})
      }
      const epoch = getDesktopRuntimeEpoch()
      const generation = beginAction()
      try {
        const result = await awaitCurrentEpoch(epoch, window.api.acp.respondToPermission(response))
        const state = normalizeCommandState(result)
        applyStateUpdate(state)
        return state
      } catch (error) {
        if (epoch === getDesktopRuntimeEpoch() && generation === actionGenerationRef.current)
          setActionError(getErrorMessage(error))
        throw error
      }
    },
    [applyStateUpdate, beginAction, normalizeCommandState]
  )

  const respondToElicitation = useCallback(
    async (response: ElicitationResponse): Promise<AcpRuntimeState> => {
      const epoch = getDesktopRuntimeEpoch()
      const generation = beginAction()
      try {
        const result = await awaitCurrentEpoch(epoch, window.api.acp.respondToElicitation(response))
        const state = normalizeCommandState(result)
        applyStateUpdate(state)
        return state
      } catch (error) {
        if (epoch === getDesktopRuntimeEpoch() && generation === actionGenerationRef.current)
          setActionError(getErrorMessage(error))
        throw error
      }
    },
    [applyStateUpdate, beginAction, normalizeCommandState]
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
    reconcileSnapshot: applySnapshot,
    subscribeRuntimeEvents,
    currentRuntimeEvents: runtimeEventOwner.currentEvents,
    actionError,
    isConnecting,
    isDisconnecting,
    connect,
    disconnect,
    createSession,
    resumeSession,
    continueInterruptedTurn,
    resetSessionContext,
    compactSession,
    deleteSession,
    cancel,
    steerFollowUp,
    sendPrompt,
    respondToPermission,
    respondToElicitation,
    setPermissionProfile,
    revokePermissionGrant
  }
}

export { useAcpRuntime }
