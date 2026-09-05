import { useCallback, useMemo } from 'react'

import type { AcpSessionAgentTarget } from '../../../../shared/acp'
import { buildConfiguredModelCatalog } from '../../../../shared/configured-model-catalog'
import { resolveModelContextWindow } from '../../../../shared/provider-registry'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import { useSessionStore } from '../../stores/session-store'
import {
  selectFrameworkApiEndpoints,
  selectVisionRelayAvailable,
  useSettingsStore
} from '../../stores/settings-store'
import {
  resolveHistoryReplayTarget,
  resolveSessionHistoryReplayDescriptor,
  type HistoryReplayDescriptor
} from './history-preamble'
import {
  isConfigurationSelectable,
  resolveSessionAgentConfiguration,
  type SessionAgentConfigurationResolution
} from './session-agent-configuration'

type WorkspaceSessionRuntimeSelection = Readonly<{
  supportsImageInput: boolean
  supportsImageRelay: boolean
  agentFrameworkId: AcpSessionAgentTarget['frameworkId']
  agentBackendId?: string
  agentModel?: string
  agentTarget?: AcpSessionAgentTarget
  historyReplayDescriptor: HistoryReplayDescriptor
}>

type AdmitSendConfigurationInput = Readonly<{
  expectedFrameworkId?: AcpSessionAgentTarget['frameworkId']
  sessionId?: string
  agentConfiguration?: SessionAgentConfiguration
}>

const useWorkspaceRuntimeSelectionOwner = (): {
  visionRelayAvailable: boolean
  configuredModelCatalog: ReturnType<typeof buildConfiguredModelCatalog>
  resolveRuntimeSelection: (
    configuration: SessionAgentConfiguration | undefined
  ) => WorkspaceSessionRuntimeSelection
  resolveStoredSessionResolution: (
    sessionId: string | undefined
  ) => SessionAgentConfigurationResolution | undefined
  getSessionRuntimeSelection: (sessionId: string) => WorkspaceSessionRuntimeSelection
  getSessionAgentTarget: (sessionId: string) => AcpSessionAgentTarget | undefined
  getSessionSupportsImageInput: (sessionId: string) => boolean
  getSessionHistoryReplayDescriptor: (sessionId: string) => HistoryReplayDescriptor
  admitSendConfiguration: (
    input: AdmitSendConfigurationInput
  ) => SessionAgentConfiguration | undefined
} => {
  const activeProvider = useSettingsStore((state) =>
    state.providers.find((candidate) => candidate.id === state.activeProviderId)
  )
  const visionRelayAvailable = useSettingsStore(selectVisionRelayAvailable)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFramework = useSettingsStore((state) =>
    state.agentFrameworks.find((candidate) => candidate.id === state.agentFrameworkId)
  )
  const providers = useSettingsStore((state) => state.providers)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const reasoningEffort = useSettingsStore((state) => state.reasoningEffort)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const configuredModelCatalog = useMemo(
    () =>
      buildConfiguredModelCatalog({
        providers,
        includeAllClaudeSubscriptions: true,
        frameworkId: agentFrameworkId,
        frameworkEndpoints
      }),
    [agentFrameworkId, frameworkEndpoints, providers]
  )
  const resolveRuntimeSelection = useCallback(
    (configuration: SessionAgentConfiguration | undefined): WorkspaceSessionRuntimeSelection => {
      const provider = configuration
        ? providers.find((candidate) => candidate.id === configuration.providerId)
        : activeProvider
      const model = configuration?.model ?? provider?.model ?? provider?.models[0]
      const modelOption = configuredModelCatalog.find(
        (option) => option.providerId === provider?.id && option.model === (model ?? '')
      )
      return {
        supportsImageInput:
          modelOption?.supportsImageInput ?? provider?.supportsImageInput === true,
        supportsImageRelay: visionRelayAvailable,
        agentFrameworkId,
        agentBackendId: provider ? `${agentFrameworkId}:${provider.id}` : undefined,
        agentModel: model,
        agentTarget: configuration
          ? ({ frameworkId: agentFrameworkId, ...configuration } satisfies AcpSessionAgentTarget)
          : undefined,
        historyReplayDescriptor: {
          target: resolveHistoryReplayTarget(agentFrameworkId, provider, agentFramework),
          contextWindow: provider?.vendorId
            ? resolveModelContextWindow(provider.vendorId, model)
            : provider?.contextWindow
        } satisfies HistoryReplayDescriptor
      }
    },
    [
      activeProvider,
      agentFramework,
      agentFrameworkId,
      configuredModelCatalog,
      providers,
      visionRelayAvailable
    ]
  )
  const resolveStoredSessionResolution = useCallback(
    (sessionId: string | undefined) => {
      if (!sessionId) return undefined
      const session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!session) return undefined
      return resolveSessionAgentConfiguration({
        session,
        catalog: configuredModelCatalog,
        activeProviderId: activeProvider?.id,
        activeModel,
        activeReasoningEffort: reasoningEffort
      })
    },
    [activeModel, activeProvider, configuredModelCatalog, reasoningEffort]
  )
  const resolveStoredSessionConfiguration = useCallback(
    (sessionId: string | undefined): SessionAgentConfiguration | undefined =>
      resolveStoredSessionResolution(sessionId)?.configuration,
    [resolveStoredSessionResolution]
  )
  const getSessionRuntimeSelection = useCallback(
    (sessionId: string) => resolveRuntimeSelection(resolveStoredSessionConfiguration(sessionId)),
    [resolveRuntimeSelection, resolveStoredSessionConfiguration]
  )
  const getSessionAgentTarget = useCallback(
    (sessionId: string): AcpSessionAgentTarget | undefined => {
      const resolution = resolveStoredSessionResolution(sessionId)
      if (resolution?.status !== 'ready') return undefined
      return resolveRuntimeSelection(resolution.configuration).agentTarget
    },
    [resolveRuntimeSelection, resolveStoredSessionResolution]
  )
  const getSessionSupportsImageInput = useCallback(
    (sessionId: string): boolean => getSessionRuntimeSelection(sessionId).supportsImageInput,
    [getSessionRuntimeSelection]
  )
  const getSessionHistoryReplayDescriptor = useCallback(
    (sessionId: string): HistoryReplayDescriptor => {
      const session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (session?.agentConfiguration) {
        return resolveRuntimeSelection(session.agentConfiguration).historyReplayDescriptor
      }
      return session
        ? resolveSessionHistoryReplayDescriptor(session, providers, agentFrameworks)
        : { target: 'codex-bridge' }
    },
    [agentFrameworks, providers, resolveRuntimeSelection]
  )
  const admitSendConfiguration = useCallback(
    (input: AdmitSendConfigurationInput): SessionAgentConfiguration | undefined => {
      if (input.expectedFrameworkId && input.expectedFrameworkId !== agentFrameworkId)
        return undefined
      const storedResolution = input.agentConfiguration
        ? undefined
        : resolveStoredSessionResolution(input.sessionId)
      const agentConfiguration = input.agentConfiguration
        ? isConfigurationSelectable(input.agentConfiguration, configuredModelCatalog)
          ? input.agentConfiguration
          : undefined
        : storedResolution?.status === 'ready'
          ? storedResolution.configuration
          : undefined
      if (!agentConfiguration) return undefined
      if (storedResolution?.status === 'ready' && storedResolution.changed && input.sessionId) {
        useSessionStore.getState().setAgentConfiguration(input.sessionId, agentConfiguration)
      }
      return agentConfiguration
    },
    [agentFrameworkId, configuredModelCatalog, resolveStoredSessionResolution]
  )

  return {
    visionRelayAvailable,
    configuredModelCatalog,
    resolveRuntimeSelection,
    resolveStoredSessionResolution,
    getSessionRuntimeSelection,
    getSessionAgentTarget,
    getSessionSupportsImageInput,
    getSessionHistoryReplayDescriptor,
    admitSendConfiguration
  }
}

export { useWorkspaceRuntimeSelectionOwner }
export type { WorkspaceSessionRuntimeSelection }
