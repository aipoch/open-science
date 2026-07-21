import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import type { ActiveSessionInfo } from '../../../shared/storage'

export type ActiveSessionDisplay = {
  // The owning project's human name (never its id).
  project: string
  title: string
  // The resolved project id (may be empty for a project-less session; callers guard before nav).
  projectId: string
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// Caps a label so one long project name or title can't blow out a fixed-size row/list; callers keep
// the full text available on hover.
const MAX_LABEL_CHARS = 28
export const truncateLabel = (text: string): string =>
  text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : text

// main only knows a session's id + its stored project *id*; the human project name and title live in
// the renderer stores. Resolves both here so every "running session" surface (close/quit confirm,
// storage migration) shows names, not ids. Falls back progressively so a row is never blank:
// project name -> cwd basename -> the project id main sent.
//
// Known limitation (cosmetic): this reads a non-reactive store snapshot, so a modal already on screen
// does NOT re-render when stores hydrate — a resolved value is fixed for that modal's lifetime and only
// refreshes the next time the modal opens (or after a renderer reload/re-hydration). If a running
// session isn't in THIS renderer's stores (started from another Web UI client, or the pre-hydration
// window after a reload), the title falls back to the raw session id, and the project name falls back
// to its id too when that project also isn't in this renderer's project store. Such a cross-renderer
// session is not navigable either — clicking it switches project and cancels the close, but
// selectSession no-ops on an id this renderer doesn't know.
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
