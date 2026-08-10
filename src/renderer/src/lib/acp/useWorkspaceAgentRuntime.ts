import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
  type ReactElement
} from 'react'

import {
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpContextUsage,
  type AcpPermissionGrant,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpRuntimeEvent
} from '../../../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import { resolveModelContextWindow } from '../../../../shared/provider-registry'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useAcpRuntime } from './useAcpRuntime'
import {
  resolveHistoryReplayTarget,
  resolveSessionHistoryReplayDescriptor,
  type HistoryReplayDescriptor
} from './history-preamble'
import {
  createWorkspaceRuntimeEventProcessor,
  drainWorkspaceRuntimeEventsForPersistence,
  markRunningSessionsDisconnectedOnDrop,
  processVisibleWorkspaceRuntimeEvents,
  processWorkspaceRuntimeEvents,
  subscribeWorkspacePermissionLifecycle,
  syncWorkspaceContextUsage,
  syncWorkspaceElicitationState,
  syncWorkspaceInteractionState,
  syncWorkspacePermissionState
} from './workspace-runtime-event-owner'
import { getResumeFailureMessage } from './workspace-runtime-prompt-preparation-owner'
import {
  resendEditedWorkspaceMessage,
  sendWorkspaceMessage,
  type ResendEditedMessageInput,
  type SendWorkspaceMessageIntent,
  type SendWorkspaceMessageResult
} from './workspace-runtime-command-owner'
import { createWorkspaceRuntimeSessionLifecycleOwner } from './workspace-runtime-session-lifecycle-owner'

type SendPreparationStateChange = (sessionId: string, inFlight: boolean) => void
type PermissionResponseAttempt = {
  accepted: boolean
  rearmed: boolean
  settled: boolean
  authorityRemoved: boolean
  restored: boolean
  sessionId?: string
  promise: Promise<void>
}
type ObservedPermissionLifecycleEvents = { sessionId?: string; eventIds: Set<string> }
type RetiredPermissionResponse = ObservedPermissionLifecycleEvents & { promise: Promise<void> }
type PermissionLifecycleEvent = AcpRuntimeEvent & { permissionRequestId: string }
type PermissionResponseAttemptOwner = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => readonly string[]
  getPromise: (requestId: string) => Promise<void> | undefined
  begin: (requestId: string) => PermissionResponseAttempt
  accept: (requestId: string, attempt: PermissionResponseAttempt) => void
  fail: (requestId: string, attempt: PermissionResponseAttempt) => void
  shouldApplyLifecycle: (event: PermissionLifecycleEvent) => boolean
  observeLifecycle: (event: PermissionLifecycleEvent) => void
  cleanSessions: (sessions: ChatSession[]) => void
  cleanLive: (requests: AcpPermissionRequest[]) => void
}

const createPermissionResponseAttemptOwner = (): PermissionResponseAttemptOwner => {
  const attempts = new Map<string, PermissionResponseAttempt>()
  const observedLifecycleEvents = new Map<string, ObservedPermissionLifecycleEvents>()
  const retiredResponses = new Map<string, RetiredPermissionResponse>()
  const listeners = new Set<() => void>()
  let hiddenRequestIds: readonly string[] = []

  const publish = (): void => {
    hiddenRequestIds = [...new Set([...attempts.keys(), ...retiredResponses.keys()])]
    for (const listener of listeners) listener()
  }
  const release = (requestId: string, attempt?: PermissionResponseAttempt): void => {
    if (attempt && attempts.get(requestId) !== attempt) return
    const activeChanged = attempts.delete(requestId)
    const retiredChanged = retiredResponses.delete(requestId)
    if (activeChanged || retiredChanged) publish()
  }
  const retire = (requestId: string, attempt?: PermissionResponseAttempt): void => {
    if (attempt && attempts.get(requestId) !== attempt) return
    const observed = observedLifecycleEvents.get(requestId)
    const retired = retiredResponses.get(requestId)
    const sessionId = attempt?.sessionId ?? observed?.sessionId ?? retired?.sessionId
    attempts.delete(requestId)
    observedLifecycleEvents.delete(requestId)
    retiredResponses.set(requestId, {
      sessionId,
      eventIds: new Set([...(retired?.eventIds ?? []), ...(observed?.eventIds ?? [])]),
      promise: attempt?.promise ?? retired?.promise ?? Promise.resolve()
    })
    publish()
  }

  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: (): readonly string[] => hiddenRequestIds,
    getPromise: (requestId: string): Promise<void> | undefined =>
      attempts.get(requestId)?.promise ?? retiredResponses.get(requestId)?.promise,
    begin: (requestId: string): PermissionResponseAttempt => {
      const attempt: PermissionResponseAttempt = {
        accepted: false,
        rearmed: false,
        settled: false,
        authorityRemoved: false,
        restored: false,
        promise: Promise.resolve()
      }
      attempts.set(requestId, attempt)
      publish()
      return attempt
    },
    accept: (requestId: string, attempt: PermissionResponseAttempt): void => {
      attempt.accepted = true
      if (attempt.rearmed) release(requestId, attempt)
      else if (attempt.settled || attempt.authorityRemoved) retire(requestId, attempt)
    },
    fail: (requestId: string, attempt: PermissionResponseAttempt): void => {
      if (attempt.settled || attempt.authorityRemoved) retire(requestId, attempt)
      else if (!attempt.accepted) release(requestId, attempt)
    },
    shouldApplyLifecycle: (event: PermissionLifecycleEvent): boolean =>
      event.title !== ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE ||
      !(
        observedLifecycleEvents.get(event.permissionRequestId)?.eventIds.has(event.id) ||
        retiredResponses.get(event.permissionRequestId)?.eventIds.has(event.id)
      ),
    observeLifecycle: (event: PermissionLifecycleEvent): void => {
      const attempt = attempts.get(event.permissionRequestId)
      const settled =
        event.title === ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE ||
        event.title === ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE ||
        event.title === ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE
      if (event.title === ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE) {
        const retired = retiredResponses.get(event.permissionRequestId)
        if (retired?.eventIds.has(event.id)) return
        const observed = observedLifecycleEvents.get(event.permissionRequestId) ?? {
          sessionId: event.sessionId,
          eventIds: new Set(retired?.eventIds)
        }
        if (observed.eventIds.has(event.id)) return
        observed.eventIds.add(event.id)
        observedLifecycleEvents.set(event.permissionRequestId, observed)
        if (retired) release(event.permissionRequestId)
        if (attempt) {
          attempt.rearmed = true
          if (attempt.accepted) release(event.permissionRequestId, attempt)
        }
      } else if (settled) {
        if (attempt) {
          attempt.settled = true
          if (attempt.accepted) retire(event.permissionRequestId, attempt)
        } else {
          const observed = observedLifecycleEvents.get(event.permissionRequestId)
          observedLifecycleEvents.set(event.permissionRequestId, {
            sessionId: event.sessionId ?? observed?.sessionId,
            eventIds: new Set([
              ...(retiredResponses.get(event.permissionRequestId)?.eventIds ?? []),
              ...(observed?.eventIds ?? [])
            ])
          })
          retire(event.permissionRequestId)
        }
      }
    },
    cleanSessions: (sessions: ChatSession[]): void => {
      const sessionsById = new Map(sessions.map((session) => [session.id, session]))
      for (const [requestId, attempt] of attempts) {
        if (!attempt.sessionId) continue
        const session = sessionsById.get(attempt.sessionId)
        if (session) {
          const currentRequestId = session.runtimeContext?.permission?.request.requestId
          if (currentRequestId === requestId || !attempt.restored) continue
          attempt.authorityRemoved = true
          if (attempt.accepted) retire(requestId, attempt)
          continue
        }
        observedLifecycleEvents.delete(requestId)
        release(requestId, attempt)
      }
      for (const [requestId, observed] of observedLifecycleEvents) {
        if (!observed.sessionId) continue
        const session = sessionsById.get(observed.sessionId)
        if (session) {
          const currentRequestId = session.runtimeContext?.permission?.request.requestId
          if (currentRequestId === requestId) continue
          retire(requestId)
          continue
        }
        observedLifecycleEvents.delete(requestId)
      }
      for (const [requestId, retired] of retiredResponses) {
        if (retired.sessionId && !sessionsById.has(retired.sessionId)) {
          retiredResponses.delete(requestId)
          publish()
        }
      }
    },
    cleanLive: (requests: AcpPermissionRequest[]): void => {
      const liveRequestIds = new Set(requests.map((request) => request.requestId))
      for (const [requestId, attempt] of attempts) {
        if (attempt.accepted && !attempt.restored && !liveRequestIds.has(requestId)) {
          observedLifecycleEvents.delete(requestId)
          release(requestId, attempt)
        }
      }
    }
  }
}
type WorkspacePermissionProfileRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'setPermissionProfile'
>

const EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS: string[] = []
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const pendingWorkspacePermissions = (
  sessions: ChatSession[],
  liveRequests: AcpPermissionRequest[]
): AcpPermissionRequest[] => {
  const liveRequestIds = new Set(liveRequests.map((request) => request.requestId))
  const restoredRequests: AcpPermissionRequest[] = []
  for (const session of sessions) {
    const permission = session.runtimeContext?.permission
    const request = permission?.request
    if (
      (session.status === 'waiting-permission' || session.status === 'error') &&
      permission?.state === 'pending' &&
      request?.sessionId === session.id &&
      !liveRequestIds.has(request.requestId)
    ) {
      restoredRequests.push(request)
    }
  }
  return restoredRequests.length > 0 ? [...liveRequests, ...restoredRequests] : liveRequests
}

const setWorkspacePermissionProfile = async (
  runtime: WorkspacePermissionProfileRuntime,
  sessionId: string,
  profile: PermissionProfileId
): Promise<boolean> => {
  let persistedProfile = profile
  if (runtime.state.sessionIds.includes(sessionId)) {
    const snapshot = await runtime.setPermissionProfile(sessionId, profile)
    const committedProfile = snapshot?.permissionProfiles[sessionId]?.selectedProfile
    if (!committedProfile) return false
    persistedProfile = committedProfile
  }
  useSessionStore.getState().setPermissionProfile(sessionId, persistedProfile)
  return true
}

type WorkspaceAgentRuntime = {
  actionError: string | null
  isConnecting: boolean
  pendingPermissions: AcpPermissionRequest[]
  permissionProfiles: Record<string, SessionPermissionProfileState>
  permissionGrants: Record<string, AcpPermissionGrant[]>
  contextUsageBySession: Record<string, AcpContextUsage>
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  nativeContextCompactionSessionIds: string[]
  compactContext: (sessionId: string) => Promise<boolean>
  sendMessage: (
    input: SendWorkspaceMessageIntent
  ) => Promise<SendWorkspaceMessageResult | undefined>
  resendEditedMessage: (
    sessionId: string,
    messageId: string,
    input: ResendEditedMessageInput
  ) => Promise<boolean>
  cancelRun: (sessionId: string) => Promise<void>
  resumeInterruptedSession: (sessionId: string) => Promise<void>
  deleteRuntimeSession: (sessionId: string) => Promise<boolean>
  respondToPermission: (requestId: string, optionId?: string) => Promise<void>
  setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => Promise<boolean>
  revokePermissionGrant: (sessionId: string, categoryKey: string) => Promise<void>
}

const WorkspaceAgentRuntimeContext = createContext<WorkspaceAgentRuntime | null>(null)

const useOwnedWorkspaceAgentRuntime = (): WorkspaceAgentRuntime => {
  const runtime = useAcpRuntime()
  const restoredPermissionProjectionKey = useSessionStore((state) =>
    JSON.stringify(
      state.sessions.map((session) => {
        const permission = session.runtimeContext?.permission
        return [
          session.id,
          permission?.state === 'pending'
            ? [session.runtimeContext?.revision, permission.request.requestId, session.status]
            : null
        ]
      })
    )
  )
  const restoredPermissionSessions = useMemo(() => {
    // The primitive projection key intentionally controls when this store snapshot is refreshed.
    void restoredPermissionProjectionKey
    return useSessionStore.getState().sessions
  }, [restoredPermissionProjectionKey])
  const activeProvider = useSettingsStore((state) =>
    state.providers.find((candidate) => candidate.id === state.activeProviderId)
  )
  const supportsImageInput = activeProvider?.supportsImageInput ?? false
  const activeModel = useSettingsStore((state) => state.activeModel)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFramework = useSettingsStore((state) =>
    state.agentFrameworks.find((candidate) => candidate.id === state.agentFrameworkId)
  )
  const providers = useSettingsStore((state) => state.providers)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const agentBackendId = activeProviderId ? `${agentFrameworkId}:${activeProviderId}` : undefined
  const historyReplayDescriptor = useMemo<HistoryReplayDescriptor>(
    () => ({
      target: resolveHistoryReplayTarget(agentFrameworkId, activeProvider, agentFramework),
      contextWindow: activeProvider?.vendorId
        ? resolveModelContextWindow(
            activeProvider.vendorId,
            activeModel ?? activeProvider.model ?? activeProvider.models[0]
          )
        : activeProvider?.contextWindow
    }),
    [activeModel, activeProvider, agentFramework, agentFrameworkId]
  )
  const getSessionHistoryReplayDescriptor = useCallback(
    (sessionId: string): HistoryReplayDescriptor => {
      const session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      return session
        ? resolveSessionHistoryReplayDescriptor(session, providers, agentFrameworks)
        : { target: 'codex-bridge' }
    },
    [agentFrameworks, providers]
  )
  const [lifecycleOwner] = useState(createWorkspaceRuntimeSessionLifecycleOwner)
  const pendingPermissions = useMemo(
    () => pendingWorkspacePermissions(restoredPermissionSessions, runtime.state.pendingPermissions),
    [restoredPermissionSessions, runtime.state.pendingPermissions]
  )
  const [permissionResponseAttemptOwner] = useState(createPermissionResponseAttemptOwner)
  const hiddenPermissionRequestIds = useSyncExternalStore(
    permissionResponseAttemptOwner.subscribe,
    permissionResponseAttemptOwner.getSnapshot,
    permissionResponseAttemptOwner.getSnapshot
  )
  const visiblePendingPermissions = useMemo(
    () =>
      pendingPermissions.filter(
        (request) => !hiddenPermissionRequestIds.includes(request.requestId)
      ),
    [hiddenPermissionRequestIds, pendingPermissions]
  )
  const [sendPreparationInFlightSessionIds, setSendPreparationInFlightSessionIds] = useState<
    string[]
  >([])
  const handleSendPreparationStateChange = useCallback<SendPreparationStateChange>(
    (sessionId, inFlight) => {
      setSendPreparationInFlightSessionIds((current) => {
        const containsSession = current.includes(sessionId)
        if (inFlight === containsSession) return current
        return inFlight ? [...current, sessionId] : current.filter((id) => id !== sessionId)
      })
    },
    []
  )
  const drainRuntimeEvents = drainWorkspaceRuntimeEventsForPersistence
  const previousStatusRef = useRef(runtime.state.status)
  const previousSessionStatusesRef = useRef(runtime.state.sessionConnectionStatuses)
  const previousDurablePermissionSessionIdsRef = useRef<ReadonlySet<string>>(new Set())
  const durablePermissionSessionIdsKey = JSON.stringify(
    Array.from(
      new Set([
        ...runtime.state.pendingPermissions
          .filter((request) => request.durable)
          .map((request) => request.sessionId),
        ...restoredPermissionSessions
          .filter(
            (session) =>
              (session.status === 'waiting-permission' || session.status === 'error') &&
              session.runtimeContext?.permission?.state === 'pending'
          )
          .map((session) => session.id)
      ])
    ).sort()
  )
  const durablePermissionSessionIds = useMemo<ReadonlySet<string>>(
    () => new Set(JSON.parse(durablePermissionSessionIdsKey) as string[]),
    [durablePermissionSessionIdsKey]
  )

  // Recover overflow before the event projection can surface its raw error or clear the neutral lock.
  useEffect(() => {
    lifecycleOwner.processRuntimeEvents(runtime, runtime.state.events, {
      supportsImageInput,
      getHistoryReplayDescriptor: getSessionHistoryReplayDescriptor
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runtime is read fresh; fire on new events.
  }, [runtime.state.events, getSessionHistoryReplayDescriptor, supportsImageInput])

  const agentPromptInFlightSessionIds =
    runtime.state.agentPromptInFlightSessionIds ?? EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS

  useEffect(
    () =>
      subscribeWorkspacePermissionLifecycle({
        shouldApply: permissionResponseAttemptOwner.shouldApplyLifecycle,
        onApplied: permissionResponseAttemptOwner.observeLifecycle
      }),
    [permissionResponseAttemptOwner]
  )

  useEffect(() => {
    permissionResponseAttemptOwner.cleanSessions(restoredPermissionSessions)
  }, [permissionResponseAttemptOwner, restoredPermissionSessions])

  useEffect(() => {
    permissionResponseAttemptOwner.cleanLive(runtime.state.pendingPermissions)
  }, [permissionResponseAttemptOwner, runtime.state.pendingPermissions])

  useEffect(() => {
    void processWorkspaceRuntimeEvents(runtime.state)
  }, [agentPromptInFlightSessionIds, runtime.state])

  useEffect(() => {
    syncWorkspacePermissionState(pendingPermissions)
    syncWorkspaceElicitationState(runtime.state.pendingElicitations ?? [])
  }, [pendingPermissions, runtime.state.pendingElicitations])

  useEffect(() => {
    syncWorkspaceContextUsage(runtime.state.sessionIds, runtime.state.contextUsageBySession)
  }, [runtime.state.sessionIds, runtime.state.contextUsageBySession])

  useEffect(() => {
    const previousStatus = previousStatusRef.current
    const previousSessionStatuses = previousSessionStatusesRef.current
    const previousDurablePermissionSessionIds = previousDurablePermissionSessionIdsRef.current
    previousStatusRef.current = runtime.state.status
    previousSessionStatusesRef.current = runtime.state.sessionConnectionStatuses
    previousDurablePermissionSessionIdsRef.current = durablePermissionSessionIds
    markRunningSessionsDisconnectedOnDrop(
      previousStatus,
      runtime.state.status,
      previousSessionStatuses,
      runtime.state.sessionConnectionStatuses,
      new Set([...previousDurablePermissionSessionIds, ...durablePermissionSessionIds])
    )
  }, [durablePermissionSessionIds, runtime.state.status, runtime.state.sessionConnectionStatuses])

  const sendMessage = useCallback(
    (input: SendWorkspaceMessageIntent): Promise<SendWorkspaceMessageResult | undefined> => {
      lifecycleOwner.recordPromptPlanAuthority(input)
      return sendWorkspaceMessage(
        runtime,
        {
          ...input,
          supportsImageInput,
          agentFrameworkId,
          agentBackendId,
          agentModel: activeModel,
          historyReplayDescriptor
        },
        {
          onSendPreparationStateChange: handleSendPreparationStateChange,
          drainRuntimeEvents
        }
      )
    },
    [
      lifecycleOwner,
      runtime,
      supportsImageInput,
      agentFrameworkId,
      agentBackendId,
      activeModel,
      historyReplayDescriptor,
      handleSendPreparationStateChange,
      drainRuntimeEvents
    ]
  )

  const resendEditedMessage = useCallback(
    (sessionId: string, messageId: string, input: ResendEditedMessageInput): Promise<boolean> =>
      resendEditedWorkspaceMessage(
        runtime,
        { sessionId, messageId, ...input },
        {
          supportsImageInput,
          agentFrameworkId,
          agentBackendId,
          agentModel: activeModel,
          historyReplayDescriptor,
          onSendPreparationStateChange: handleSendPreparationStateChange,
          drainRuntimeEvents
        }
      ),
    [
      runtime,
      supportsImageInput,
      agentFrameworkId,
      agentBackendId,
      activeModel,
      historyReplayDescriptor,
      handleSendPreparationStateChange,
      drainRuntimeEvents
    ]
  )

  const compactContext = useCallback(
    (sessionId: string): Promise<boolean> => lifecycleOwner.compact(runtime, sessionId),
    [lifecycleOwner, runtime]
  )
  const resumeInterruptedSession = useCallback(
    (sessionId: string): Promise<void> =>
      lifecycleOwner.resume(runtime, sessionId, drainRuntimeEvents, {
        historyReplayDescriptor: getSessionHistoryReplayDescriptor(sessionId),
        supportsImageInput
      }),
    [
      lifecycleOwner,
      runtime,
      drainRuntimeEvents,
      getSessionHistoryReplayDescriptor,
      supportsImageInput
    ]
  )
  const cancelRun = useCallback(
    (sessionId: string): Promise<void> => lifecycleOwner.cancel(runtime, sessionId),
    [lifecycleOwner, runtime]
  )
  const deleteRuntimeSession = useCallback(
    (sessionId: string): Promise<boolean> => lifecycleOwner.delete(runtime, sessionId),
    [lifecycleOwner, runtime]
  )
  const respondToPermission = useCallback(
    (requestId: string, optionId?: string): Promise<void> => {
      const existing = permissionResponseAttemptOwner.getPromise(requestId)
      if (existing) return existing

      const attempt = permissionResponseAttemptOwner.begin(requestId)
      const response = (async (): Promise<void> => {
        const request = pendingPermissions.find((item) => item.requestId === requestId)
        const isRestoredRequest = Boolean(
          request &&
          !runtime.state.pendingPermissions.some((item) => item.requestId === request.requestId)
        )
        attempt.restored = isRestoredRequest
        attempt.sessionId = request?.sessionId
        try {
          let restored: AcpPermissionResponse['restored']
          if (request && isRestoredRequest) {
            let session = useSessionStore
              .getState()
              .sessions.find((candidate) => candidate.id === request.sessionId)
            if (!session) throw new Error(`Session not found: ${request.sessionId}`)
            if (!runtime.state.sessionIds.includes(request.sessionId)) {
              const cwd = session.cwd || runtime.state.cwd
              if (!cwd) throw new Error('Choose a workspace folder before resuming this Session.')
              const resumed = await runtime.resumeSession(
                session.id,
                cwd,
                session.projectId,
                session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
                session.agentFrameworkId,
                session.agentBackendId,
                session.specialistId,
                session.providerSessionId,
                session.providerContinuityToken
              )
              useSessionStore.getState().markResumed(
                session.id,
                resumed
                  ? {
                      agentFrameworkId: resumed.frameworkId,
                      agentBackendId: resumed.backendId,
                      providerSessionId: resumed.providerSessionId,
                      providerContinuityToken: resumed.providerContinuityToken
                    }
                  : undefined
              )
              // markResumed clears generic interrupted state to idle. Re-arm this main-owned wait
              // until the restored decision is accepted so a retryable response failure cannot make
              // the card disappear from the renderer projection.
              useSessionStore.getState().setPermissionPending(session.id)
              session = useSessionStore
                .getState()
                .sessions.find((candidate) => candidate.id === request.sessionId)
              if (!session) throw new Error(`Session not found: ${request.sessionId}`)
            }
            restored = {
              sessionId: session.id,
              projectId: session.projectId
            }
          }
          await runtime.respondToPermission(requestId, optionId, restored)
          permissionResponseAttemptOwner.accept(requestId, attempt)
          if (attempt.rearmed || attempt.settled) return
          const currentSession = request
            ? useSessionStore
                .getState()
                .sessions.find((session) => session.id === request.sessionId)
            : undefined
          const currentPermission = currentSession?.runtimeContext?.permission
          if (
            request &&
            restored &&
            currentPermission?.state === 'pending' &&
            currentPermission.request.requestId === requestId
          ) {
            useSessionStore.getState().clearPermissionPending(request.sessionId, {
              authority: 'continuing',
              requestId
            })
          }
        } catch (error) {
          if (request && isRestoredRequest) {
            // The main-owned authority is still valid. Keep the card actionable; useAcpRuntime retains
            // the transient action error separately for the active Session to display.
            const permission = useSessionStore
              .getState()
              .sessions.find((session) => session.id === request.sessionId)
              ?.runtimeContext?.permission
            if (permission?.state === 'pending') {
              useSessionStore.getState().setPermissionPending(request.sessionId)
            }
          } else if (request) {
            useSessionStore.getState().failRun(request.sessionId, getErrorMessage(error))
          }
        }
      })()
      const tracked = response.finally(() => {
        // A permission request id is one-shot authority. Keep successful responses coalesced for
        // stale renders, releasing it only when Main explicitly re-arms the durable request.
        permissionResponseAttemptOwner.fail(requestId, attempt)
      })
      attempt.promise = tracked
      return tracked
    },
    [pendingPermissions, permissionResponseAttemptOwner, runtime]
  )
  const setPermissionProfile = useCallback(
    (sessionId: string, profile: PermissionProfileId): Promise<boolean> =>
      setWorkspacePermissionProfile(runtime, sessionId, profile),
    [runtime]
  )
  const revokePermissionGrant = useCallback(
    async (sessionId: string, categoryKey: string): Promise<void> => {
      const snapshot = await runtime.revokePermissionGrant(sessionId, categoryKey)
      if (!snapshot) useSessionStore.getState().failRun(sessionId, 'Permission revoke failed')
    },
    [runtime]
  )

  return {
    actionError: runtime.actionError,
    isConnecting: runtime.isConnecting,
    pendingPermissions: visiblePendingPermissions,
    permissionProfiles: runtime.state.permissionProfiles,
    permissionGrants: runtime.state.permissionGrants,
    contextUsageBySession: runtime.state.contextUsageBySession,
    promptInFlightSessionIds: runtime.state.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds,
    nativeContextCompactionSessionIds: runtime.state.nativeContextCompactionSessionIds ?? [],
    compactContext,
    sendMessage,
    resendEditedMessage,
    cancelRun,
    resumeInterruptedSession,
    deleteRuntimeSession,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  }
}

const WorkspaceAgentRuntimeProvider = ({ children }: PropsWithChildren): ReactElement =>
  createElement(
    WorkspaceAgentRuntimeContext.Provider,
    { value: useOwnedWorkspaceAgentRuntime() },
    children
  )

const useWorkspaceAgentRuntime = (): WorkspaceAgentRuntime => {
  const runtime = useContext(WorkspaceAgentRuntimeContext)
  if (!runtime) {
    throw new Error('useWorkspaceAgentRuntime must be used within WorkspaceAgentRuntimeProvider.')
  }
  return runtime
}

export {
  WorkspaceAgentRuntimeProvider,
  createWorkspaceRuntimeEventProcessor,
  drainWorkspaceRuntimeEventsForPersistence,
  getResumeFailureMessage,
  markRunningSessionsDisconnectedOnDrop,
  processVisibleWorkspaceRuntimeEvents,
  setWorkspacePermissionProfile,
  pendingWorkspacePermissions,
  syncWorkspaceContextUsage,
  syncWorkspaceInteractionState,
  useWorkspaceAgentRuntime
}
export type { WorkspaceAgentRuntime }
