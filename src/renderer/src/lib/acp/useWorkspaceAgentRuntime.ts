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
  type AcpAgentRuntimeUpdate,
  type AcpContextUsage,
  type AcpPermissionGrant,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpSaveAsSkillRequest
} from '../../../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import { resolveModelContextWindow } from '../../../../shared/provider-registry'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { selectVisionRelayAvailable, useSettingsStore } from '../../stores/settings-store'
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
  refreshDelegatedWorkSessions,
  subscribeWorkspacePermissionLifecycle,
  syncWorkspaceContextUsage,
  syncWorkspaceElicitationState,
  syncWorkspaceInteractionState,
  syncWorkspacePermissionState,
  useWorkspaceRuntimeEventDrain,
  useWorkspaceRuntimeEventIngest
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
import { useSubagentRuntimePresentation } from './workspace-subagent-runtime-presentation'
import {
  createPermissionResponseAttemptOwner,
  pendingWorkspacePermissions
} from './workspace-permission-response-attempt-owner'
import { useWorkspaceRuntimeSaveAsSkillOwner } from './workspace-runtime-save-as-skill-owner'
type SendPreparationStateChange = (sessionId: string, inFlight: boolean) => void
type WorkspacePermissionProfileRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'setPermissionProfile'
>
type SubagentRuntimeListener = (update: AcpAgentRuntimeUpdate) => void
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
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
  delegatedWorkUnavailableBySession: Record<string, string>
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  saveAsSkillInFlightSessionIds: string[]
  nativeContextCompactionSessionIds: string[]
  subscribeToSubagentRuntimeUpdates: (listener: SubagentRuntimeListener) => () => void
  compactContext: (sessionId: string) => Promise<boolean>
  ensureSessionReady: (sessionId: string) => Promise<void>
  saveAsSkill: (
    request: Omit<AcpSaveAsSkillRequest, 'historyReplay' | 'promptMessageId'>
  ) => Promise<void>
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
  respondToPermission: (requestId: string, optionId?: string) => Promise<void>
  setPermissionProfile: (sessionId: string, profile: PermissionProfileId) => Promise<boolean>
  revokePermissionGrant: (sessionId: string, categoryKey: string) => Promise<void>
}
const WorkspaceAgentRuntimeContext = createContext<WorkspaceAgentRuntime | null>(null)
const RuntimeProvider = WorkspaceAgentRuntimeContext.Provider
const useOwnedWorkspaceAgentRuntime = (): WorkspaceAgentRuntime => {
  const runtime = useAcpRuntime()
  const subagentRuntimeUpdateListeners = useRef(new Set<SubagentRuntimeListener>())
  const subscribeToSubagentRuntimeUpdates = useCallback(
    (listener: SubagentRuntimeListener): (() => void) => {
      subagentRuntimeUpdateListeners.current.add(listener)
      return () => subagentRuntimeUpdateListeners.current.delete(listener)
    },
    []
  )
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
    void restoredPermissionProjectionKey
    return useSessionStore.getState().sessions
  }, [restoredPermissionProjectionKey])
  const activeProvider = useSettingsStore((state) =>
    state.providers.find((candidate) => candidate.id === state.activeProviderId)
  )
  const visionRelayAvailable = useSettingsStore(selectVisionRelayAvailable)
  const supportsNativeImageInput = activeProvider?.supportsImageInput === true
  const supportsHistoryImageInput = supportsNativeImageInput || visionRelayAvailable
  const activeModel = useSettingsStore((state) => state.activeModel)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFramework = useSettingsStore((state) =>
    state.agentFrameworks.find((candidate) => candidate.id === state.agentFrameworkId)
  )
  const providers = useSettingsStore((state) => state.providers)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
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
  const resolveRuntimeSelection = useCallback(
    (configuration: SessionAgentConfiguration | undefined) => {
      const provider = configuration
        ? providers.find((candidate) => candidate.id === configuration.providerId)
        : activeProvider
      const model = configuration?.model ?? provider?.model ?? provider?.models[0]
      return {
        supportsImageInput: provider?.supportsImageInput === true,
        agentFrameworkId,
        agentBackendId: provider ? `${agentFrameworkId}:${provider.id}` : undefined,
        agentModel: model,
        historyReplayDescriptor: {
          target: resolveHistoryReplayTarget(agentFrameworkId, provider, agentFramework),
          contextWindow: provider?.vendorId
            ? resolveModelContextWindow(provider.vendorId, model)
            : provider?.contextWindow
        } satisfies HistoryReplayDescriptor
      }
    },
    [activeProvider, agentFramework, agentFrameworkId, providers]
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
  const liveRuntimeEvents = useWorkspaceRuntimeEventIngest(
    runtime,
    lifecycleOwner.processRuntimeEvents,
    supportsHistoryImageInput,
    getSessionHistoryReplayDescriptor
  )
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
  const drainRuntimeEvents = useWorkspaceRuntimeEventDrain(runtime.reconcileSnapshot)
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
  useEffect(() => {
    const subscribe = window.api?.acp?.onAgentRuntimeUpdate
    if (!subscribe) return
    return subscribe((update) => {
      for (const listener of subagentRuntimeUpdateListeners.current) listener(update)
    })
  }, [])

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
    if (liveRuntimeEvents) return
    lifecycleOwner.processRuntimeEvents(runtime, runtime.state.events, {
      supportsImageInput: supportsHistoryImageInput,
      getHistoryReplayDescriptor: getSessionHistoryReplayDescriptor
    })
    void processWorkspaceRuntimeEvents(runtime.state)
  }, [
    getSessionHistoryReplayDescriptor,
    lifecycleOwner,
    liveRuntimeEvents,
    runtime,
    runtime.state,
    supportsHistoryImageInput
  ])

  useEffect(() => {
    syncWorkspaceElicitationState(runtime.state.pendingElicitations ?? [])
    syncWorkspacePermissionState(pendingPermissions)
  }, [pendingPermissions, runtime.state.pendingElicitations])

  useEffect(() => {
    syncWorkspaceContextUsage(runtime.state.sessionIds, runtime.state.contextUsageBySession)
  }, [runtime.state.sessionIds, runtime.state.contextUsageBySession])

  const delegatedWorkSessionKey = runtime.state.sessionIds.join('\u0000')
  useEffect(() => {
    if (runtime.state.delegatedWorkRevision === undefined) return
    let cancelled = false
    void refreshDelegatedWorkSessions(
      delegatedWorkSessionKey.split('\u0000').filter(Boolean),
      () => cancelled
    ).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [delegatedWorkSessionKey, runtime.state.delegatedWorkRevision])

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
      const selected = resolveRuntimeSelection(input.agentConfiguration)
      return sendWorkspaceMessage(
        runtime,
        {
          ...input,
          supportsImageInput: selected.supportsImageInput,
          supportsImageRelay: visionRelayAvailable,
          agentFrameworkId: selected.agentFrameworkId,
          agentBackendId: selected.agentBackendId,
          agentModel: selected.agentModel,
          historyReplayDescriptor: selected.historyReplayDescriptor
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
      visionRelayAvailable,
      resolveRuntimeSelection,
      handleSendPreparationStateChange,
      drainRuntimeEvents
    ]
  )

  const resendEditedMessage = useCallback(
    (sessionId: string, messageId: string, input: ResendEditedMessageInput): Promise<boolean> => {
      const configuration = useSessionStore
        .getState()
        .sessions.find((session) => session.id === sessionId)?.agentConfiguration
      const selected = resolveRuntimeSelection(configuration)
      return resendEditedWorkspaceMessage(
        runtime,
        { sessionId, messageId, ...input },
        {
          supportsImageInput: selected.supportsImageInput,
          supportsImageRelay: visionRelayAvailable,
          agentFrameworkId: selected.agentFrameworkId,
          agentBackendId: selected.agentBackendId,
          agentModel: selected.agentModel,
          agentConfiguration: configuration,
          historyReplayDescriptor: selected.historyReplayDescriptor,
          onSendPreparationStateChange: handleSendPreparationStateChange,
          drainRuntimeEvents
        }
      )
    },
    [
      runtime,
      visionRelayAvailable,
      resolveRuntimeSelection,
      handleSendPreparationStateChange,
      drainRuntimeEvents
    ]
  )

  const compactContext = useCallback(
    (sessionId: string): Promise<boolean> => lifecycleOwner.compact(runtime, sessionId),
    [lifecycleOwner, runtime]
  )
  const ensureSessionReady = useCallback(
    (sessionId: string): Promise<void> => lifecycleOwner.ensureReady(runtime, sessionId),
    [lifecycleOwner, runtime]
  )
  const { saveAsSkillInFlightSessionIds, saveAsSkill } = useWorkspaceRuntimeSaveAsSkillOwner({
    runtime,
    historyReplayDescriptor,
    drainRuntimeEvents
  })
  const resumeInterruptedSession = useCallback(
    (sessionId: string): Promise<void> =>
      lifecycleOwner.resume(runtime, sessionId, drainRuntimeEvents, {
        historyReplayDescriptor: getSessionHistoryReplayDescriptor(sessionId),
        supportsImageInput: supportsHistoryImageInput
      }),
    [
      lifecycleOwner,
      runtime,
      drainRuntimeEvents,
      getSessionHistoryReplayDescriptor,
      supportsHistoryImageInput
    ]
  )
  const cancelRun = useCallback(
    (sessionId: string): Promise<void> => lifecycleOwner.cancel(runtime, sessionId),
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
                session.providerContinuityToken,
                session.specialistBindingPending
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
              // Keep the main-owned wait until the restored decision succeeds so a retryable
              // response failure cannot hide the permission card after markResumed clears it.
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
    delegatedWorkUnavailableBySession: runtime.state.delegatedWorkUnavailableBySession ?? {},
    promptInFlightSessionIds: runtime.state.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds,
    saveAsSkillInFlightSessionIds,
    nativeContextCompactionSessionIds: runtime.state.nativeContextCompactionSessionIds ?? [],
    subscribeToSubagentRuntimeUpdates,
    compactContext,
    ensureSessionReady,
    saveAsSkill,
    sendMessage,
    resendEditedMessage,
    cancelRun,
    resumeInterruptedSession,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  }
}

const WorkspaceAgentRuntimeProvider = ({ children }: PropsWithChildren): ReactElement =>
  createElement(RuntimeProvider, { value: useOwnedWorkspaceAgentRuntime() }, children)

const useWorkspaceAgentRuntime = (): WorkspaceAgentRuntime => {
  const runtime = useContext(WorkspaceAgentRuntimeContext)
  if (!runtime) {
    throw new Error('useWorkspaceAgentRuntime must be used within WorkspaceAgentRuntimeProvider.')
  }
  return runtime
}

const useWorkspaceSubagentRuntimeSession = (
  session: ChatSession,
  detail: Parameters<typeof useSubagentRuntimePresentation>[2]
): ChatSession => {
  const runtime = useWorkspaceAgentRuntime()
  return useSubagentRuntimePresentation(runtime.subscribeToSubagentRuntimeUpdates, session, detail)
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
  useWorkspaceSubagentRuntimeSession,
  useWorkspaceAgentRuntime
}
export type { WorkspaceAgentRuntime }
