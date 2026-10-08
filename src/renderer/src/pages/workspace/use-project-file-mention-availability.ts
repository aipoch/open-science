import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'

export const isProjectFileMentionAvailable = (projectId: string): boolean => {
  const navigation = useNavigationStore.getState()
  const sessions = useSessionStore.getState()
  return Boolean(
    typeof window.api?.managedFileVersions?.inspect === 'function' &&
    navigation.view === 'workspace' &&
    navigation.activeProjectId === projectId &&
    (sessions.selectedSessionId === undefined ||
      sessions.sessions.find((item) => item.id === sessions.selectedSessionId)?.projectId ===
        projectId) &&
    navigation.artifactMentionAvailability?.projectId === projectId &&
    navigation.artifactMentionAvailability.canMention &&
    !navigation.pendingArtifactMention
  )
}

// The composer may own a new-conversation draft before a Session exists. An explicitly selected
// Session must still belong to this project; the composer owns editability and the mention cap.
export const useProjectFileMentionAvailability = (projectId: string): boolean => {
  const view = useNavigationStore((state) => state.view)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const availability = useNavigationStore((state) => state.artifactMentionAvailability)
  const pending = useNavigationStore((state) => state.pendingArtifactMention)
  const sessionMatchesProject = useSessionStore(
    (state) =>
      state.selectedSessionId === undefined ||
      state.sessions.find((item) => item.id === state.selectedSessionId)?.projectId === projectId
  )
  return (
    typeof window.api?.managedFileVersions?.inspect === 'function' &&
    view === 'workspace' &&
    activeProjectId === projectId &&
    sessionMatchesProject &&
    availability?.projectId === projectId &&
    availability.canMention &&
    !pending
  )
}
