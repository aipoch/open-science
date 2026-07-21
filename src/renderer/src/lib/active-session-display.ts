import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import type { ActiveSessionInfo } from '../../../shared/storage'

export type ActiveSessionDisplay = {
  // The owning project's human name (never its id).
  project: string
  title: string
  // Present when the session resolves to a project, so callers can navigate into it.
  projectId?: string
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// main only knows a session's id + its stored project *id*; the human project name and title live in
// the renderer stores. Resolves both here so every "running session" surface (close/quit confirm,
// storage migration) shows names, not ids. Falls back progressively so a row is never blank:
// project name -> cwd basename -> the project id main sent.
export const resolveActiveSessionDisplay = (info: ActiveSessionInfo): ActiveSessionDisplay => {
  const session = useSessionStore.getState().sessions.find((entry) => entry.id === info.sessionId)
  const projectId = session?.projectId ?? info.projectId
  const projectName = projectId
    ? useProjectStore.getState().projects.find((project) => project.id === projectId)?.name
    : undefined
  const cwdName = session?.cwd ? basename(session.cwd) : undefined
  return {
    project: projectName ?? cwdName ?? info.projectId,
    title: session?.title?.trim() || info.title?.trim() || info.sessionId,
    projectId
  }
}
