import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { useSessionStore, type ChatSession } from '@/stores/session-store'

type StringListUpdater = (update: (current: string[]) => string[]) => void

type WorkspaceComputeHostAccessInput = Readonly<{
  activeSession: ChatSession | undefined
  newConversationEnabledComputeHosts: string[]
  newConversationSelectedComputeHosts: string[]
  setNewConversationEnabledComputeHosts: StringListUpdater
  setNewConversationSelectedComputeHosts: StringListUpdater
  setError(error: string | null): void
}>

const createWorkspaceComputeHostAccessController = ({
  activeSession,
  newConversationEnabledComputeHosts,
  newConversationSelectedComputeHosts,
  setNewConversationEnabledComputeHosts,
  setNewConversationSelectedComputeHosts,
  setError
}: WorkspaceComputeHostAccessInput): Readonly<{
  enabledProviderIds: string[]
  selectedProviderIds: string[]
  setHostEnabled(providerId: string, enabled: boolean): void
  setHostSelected(providerId: string, selected: boolean): void
}> => {
  const applyAuthority = (source: ChatSession, operation: Promise<PersistedChatSession>): void => {
    setError(null)
    void operation
      .then((session) => {
        useSessionStore.getState().applyDurableSessionProjection({
          source,
          session,
          mode: 'compute-host-access-authority'
        })
      })
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error))
      })
  }

  const setHostEnabled = (providerId: string, enabled: boolean): void => {
    if (activeSession) {
      applyAuthority(
        activeSession,
        window.api.compute.hostEnabledSet(activeSession.id, providerId, enabled)
      )
      return
    }
    setNewConversationEnabledComputeHosts((current) =>
      enabled
        ? current.includes(providerId)
          ? current
          : [...current, providerId]
        : current.filter((candidate) => candidate !== providerId)
    )
    if (!enabled) {
      setNewConversationSelectedComputeHosts((current) =>
        current.filter((candidate) => candidate !== providerId)
      )
    }
  }

  const setHostSelected = (providerId: string, selected: boolean): void => {
    if (activeSession) {
      applyAuthority(
        activeSession,
        window.api.compute.hostSelectedSet(activeSession.id, providerId, selected)
      )
      return
    }
    if (selected) {
      setNewConversationEnabledComputeHosts((current) =>
        current.includes(providerId) ? current : [...current, providerId]
      )
    }
    setNewConversationSelectedComputeHosts((current) =>
      selected
        ? current.includes(providerId)
          ? current
          : [...current, providerId]
        : current.filter((candidate) => candidate !== providerId)
    )
  }

  return {
    enabledProviderIds: activeSession
      ? (activeSession.enabledComputeHosts ?? [])
      : newConversationEnabledComputeHosts,
    selectedProviderIds: activeSession
      ? (activeSession.selectedComputeHosts ?? activeSession.enabledComputeHosts ?? [])
      : newConversationSelectedComputeHosts,
    setHostEnabled,
    setHostSelected
  }
}

export { createWorkspaceComputeHostAccessController }
