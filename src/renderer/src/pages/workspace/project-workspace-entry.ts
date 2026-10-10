import {
  readResearchProjectDestination,
  rememberResearchProjectDestination,
  resolveResearchProjectDestination
} from '@/lib/research-project-entry'
import { useNavigationStore } from '@/stores/navigation-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { useSessionStore } from '@/stores/session-store'
import { isResearchDemoCarrier, refreshResearchDemoCarriers } from '@/stores/research-demo-store'
import { openResearchWorkspace, researchSourceFromSession } from './workspace-discussion-navigation'

let pendingEntry: AbortController | undefined

// Intentional project entry only. Exact Session links and internal openProject continuations keep
// their existing routing; only projects containing imported research remember a local destination.
export const openProjectWorkspace = async (
  projectId: string,
  afterNavigate?: () => void
): Promise<boolean> => {
  pendingEntry?.abort()
  const controller = new AbortController()
  pendingEntry = controller
  const revision = useNavigationStore.getState().explicitNavigationRevision
  await refreshResearchDemoCarriers(projectId)
  if (
    controller.signal.aborted ||
    useNavigationStore.getState().explicitNavigationRevision !== revision
  )
    return false
  const sessions = useSessionStore
    .getState()
    .sessions.filter((session) => !isResearchDemoCarrier(session.projectId, session.id))
  const destination = resolveResearchProjectDestination(
    projectId,
    sessions,
    readResearchProjectDestination(projectId)
  )
  const navigation = useNavigationStore.getState()
  const current = (): boolean =>
    !controller.signal.aborted &&
    useNavigationStore.getState().explicitNavigationRevision ===
      navigation.explicitNavigationRevision
  if (!destination) return navigation.openProject(projectId, 'user', afterNavigate, current)
  if (destination.kind === 'session')
    return navigation.openSession(projectId, destination.sessionId, 'user', afterNavigate, () => {
      if (!current()) return false
      const session = useSessionStore
        .getState()
        .sessions.find(
          (candidate) => candidate.id === destination.sessionId && candidate.projectId === projectId
        )
      return Boolean(
        session &&
        (session.packageOrigin?.importId ?? session.importedResearch?.importId) ===
          destination.sourceImportId
      )
    })
  if (destination.kind === 'draft') {
    return navigation.openProject(
      projectId,
      'user',
      () => {
        useResearchWorkspaceStore.getState().leaveDraft(projectId)
        useSessionStore.getState().clearSelection()
        rememberResearchProjectDestination(
          projectId,
          destination,
          useSessionStore.getState().sessions
        )
        afterNavigate?.()
      },
      current
    )
  }
  const source = researchSourceFromSession(
    sessions.find(
      (session) => session.id === destination.sourceSessionId && session.projectId === projectId
    )
  )
  if (!source || source.sourceImportId !== destination.sourceImportId) return false
  return openResearchWorkspace(source, {
    signal: controller.signal,
    afterNavigate: () => afterNavigate?.()
  })
}
