import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement
} from 'react'

import type {
  AcpContextUsage,
  AcpPermissionGrant,
  AcpPermissionRequest
} from '../../../../shared/acp'
import {
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import { resolveModelContextWindow } from '../../../../shared/provider-registry'
import { useSessionStore } from '../../stores/session-store'
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
  syncWorkspaceContextUsage,
  syncWorkspacePermissionState
} from './workspace-runtime-event-owner'
import { getResumeFailureMessage } from './workspace-runtime-prompt-preparation-owner'
import {
  resendEditedWorkspaceMessage,
  sendWorkspaceMessage,
  type ResendEditedMessageInput,
  type SendWorkspaceMessageInput,
  type SendWorkspaceMessageResult
} from './workspace-runtime-command-owner'
import { createWorkspaceRuntimeSessionLifecycleOwner } from './workspace-runtime-session-lifecycle-owner'

type SendPreparationStateChange = (sessionId: string, inFlight: boolean) => void
type WorkspacePermissionProfileRuntime = Pick<
  ReturnType<typeof useAcpRuntime>,
  'state' | 'setPermissionProfile'
>

const EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS: string[] = []
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
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  nativeContextCompactionSessionIds: string[]
  compactContext: (sessionId: string) => Promise<boolean>
  sendMessage: (input: SendWorkspaceMessageInput) => Promise<SendWorkspaceMessageResult | undefined>
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

  useEffect(() => {
    void processWorkspaceRuntimeEvents(runtime.state.events, agentPromptInFlightSessionIds)
  }, [agentPromptInFlightSessionIds, runtime.state.events])

  useEffect(() => {
    syncWorkspacePermissionState(runtime.state.pendingPermissions)
  }, [runtime.state.pendingPermissions])

  useEffect(() => {
    syncWorkspaceContextUsage(runtime.state.sessionIds, runtime.state.contextUsageBySession)
  }, [runtime.state.sessionIds, runtime.state.contextUsageBySession])

  useEffect(() => {
    const previousStatus = previousStatusRef.current
    const previousSessionStatuses = previousSessionStatusesRef.current
    previousStatusRef.current = runtime.state.status
    previousSessionStatusesRef.current = runtime.state.sessionConnectionStatuses
    markRunningSessionsDisconnectedOnDrop(
      previousStatus,
      runtime.state.status,
      previousSessionStatuses,
      runtime.state.sessionConnectionStatuses
    )
  }, [runtime.state.status, runtime.state.sessionConnectionStatuses])

  const sendMessage = useCallback(
    (input: SendWorkspaceMessageInput): Promise<SendWorkspaceMessageResult | undefined> => {
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
    async (requestId: string, optionId?: string): Promise<void> => {
      const request = runtime.state.pendingPermissions.find((item) => item.requestId === requestId)
      try {
        await runtime.respondToPermission(requestId, optionId)
      } catch (error) {
        if (request) useSessionStore.getState().failRun(request.sessionId, getErrorMessage(error))
      }
    },
    [runtime]
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
    pendingPermissions: runtime.state.pendingPermissions,
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
  syncWorkspaceContextUsage,
  useWorkspaceAgentRuntime
}
