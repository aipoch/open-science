import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'

export const isProjectFileMentionAvailable = (projectId: string): boolean => {
  const navigation = useNavigationStore.getState()
  const sessions = useSessionStore.getState()
  return Boolean(
    typeof window.api?.managedFileVersions?.inspect === 'function' &&
    navigation.view === 'workspace' &&
    navigation.activeProjectId === projectId &&
    sessions.sessions.find((item) => item.id === sessions.selectedSessionId)?.projectId ===
      projectId &&
    navigation.artifactMentionAvailability?.projectId === projectId &&
    navigation.artifactMentionAvailability.canMention &&
    !navigation.pendingArtifactMention
  )
}

// Mirrors the Global Search mention gate: the composer must be mounted in the workspace for the
// same project, with an active session in that project, and the draft below its mention cap.
export const useProjectFileMentionAvailability = (projectId: string): boolean => {
  const view = useNavigationStore((state) => state.view)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const availability = useNavigationStore((state) => state.artifactMentionAvailability)
  const pending = useNavigationStore((state) => state.pendingArtifactMention)
  const sessionProjectId = useSessionStore(
    (state) => state.sessions.find((item) => item.id === state.selectedSessionId)?.projectId
  )
  return (
    typeof window.api?.managedFileVersions?.inspect === 'function' &&
    view === 'workspace' &&
    activeProjectId === projectId &&
    sessionProjectId === projectId &&
    availability?.projectId === projectId &&
    availability.canMention &&
    !pending
  )
}
