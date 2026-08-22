import { useCallback, useEffect, useMemo, useState } from 'react'

import { buildConfiguredModelCatalog } from '../../../../shared/configured-model-catalog'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import {
  isConfigurationSelectable,
  resolveSelectableConfiguration,
  resolveSessionAgentConfiguration
} from '@/lib/acp/session-agent-configuration'
import {
  selectFrameworkApiEndpoints,
  selectVisionRelayAvailable,
  useSettingsStore
} from '@/stores/settings-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'

const useWorkspaceSessionAgentConfiguration = (
  activeSession: ChatSession | undefined
): {
  activeAgentConfiguration: SessionAgentConfiguration | undefined
  agentConfigurationUnavailable: boolean
  supportsImageInput: boolean
  changeAgentConfiguration: (configuration: SessionAgentConfiguration) => void
  resetNewConversationConfiguration: () => void
} => {
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const activeReasoningEffort = useSettingsStore((state) => state.reasoningEffort)
  const providers = useSettingsStore((state) => state.providers)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const visionRelayAvailable = useSettingsStore(selectVisionRelayAvailable)
  const setAgentConfiguration = useSessionStore((state) => state.setAgentConfiguration)
  const [newConversationAgentConfiguration, setNewConversationAgentConfiguration] =
    useState<SessionAgentConfiguration>()
  const includeAllClaudeSubscriptions = activeSession !== undefined
  const configuredModelCatalog = useMemo(
    () =>
      buildConfiguredModelCatalog({
        providers,
        activeProviderId,
        claudeSubscriptionProviderId,
        includeAllClaudeSubscriptions,
        frameworkId: agentFrameworkId,
        frameworkEndpoints
      }),
    [
      activeProviderId,
      agentFrameworkId,
      claudeSubscriptionProviderId,
      frameworkEndpoints,
      includeAllClaudeSubscriptions,
      providers
    ]
  )
  const defaultAgentConfiguration = useMemo<SessionAgentConfiguration | undefined>(
    () =>
      resolveSelectableConfiguration(
        configuredModelCatalog,
        activeProviderId,
        activeModel,
        activeReasoningEffort
      ),
    [activeModel, activeProviderId, activeReasoningEffort, configuredModelCatalog]
  )
  const sessionAgentConfiguration = useMemo(
    () =>
      activeSession
        ? resolveSessionAgentConfiguration({
            session: activeSession,
            catalog: configuredModelCatalog,
            activeProviderId,
            activeModel,
            activeReasoningEffort
          })
        : undefined,
    [activeModel, activeProviderId, activeReasoningEffort, activeSession, configuredModelCatalog]
  )
  useEffect(() => {
    if (
      !activeSession ||
      sessionAgentConfiguration?.status !== 'ready' ||
      !sessionAgentConfiguration.changed
    ) {
      return
    }
    setAgentConfiguration(activeSession.id, sessionAgentConfiguration.configuration)
  }, [activeSession, sessionAgentConfiguration, setAgentConfiguration])
  const activeAgentConfiguration = activeSession
    ? sessionAgentConfiguration?.configuration
    : (newConversationAgentConfiguration ?? defaultAgentConfiguration)
  const agentConfigurationUnavailable = activeSession
    ? sessionAgentConfiguration?.status === 'unavailable'
    : !isConfigurationSelectable(activeAgentConfiguration, configuredModelCatalog)
  const activeModelOption = configuredModelCatalog.find(
    (option) =>
      option.providerId === activeAgentConfiguration?.providerId &&
      (activeAgentConfiguration?.model === undefined
        ? option.selectable
        : option.model === activeAgentConfiguration.model)
  )
  const supportsImageInput = activeModelOption?.supportsImageInput === true || visionRelayAvailable
  const changeAgentConfiguration = useCallback(
    (configuration: SessionAgentConfiguration): void => {
      if (activeSession) {
        setAgentConfiguration(activeSession.id, configuration)
        return
      }
      setNewConversationAgentConfiguration(configuration)
    },
    [activeSession, setAgentConfiguration]
  )
  const resetNewConversationConfiguration = useCallback((): void => {
    setNewConversationAgentConfiguration(undefined)
  }, [])

  return {
    activeAgentConfiguration,
    agentConfigurationUnavailable,
    supportsImageInput,
    changeAgentConfiguration,
    resetNewConversationConfiguration
  }
}

export { useWorkspaceSessionAgentConfiguration }
