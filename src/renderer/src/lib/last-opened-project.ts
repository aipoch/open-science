// Durable last-opened project selection for the `Add specialist › Chat with agent` entry.
//
// Mirrors the theme preference's persistence approach: a renderer-local value in localStorage, which
// Chromium backs from the app's userData directory so it survives application restart. The chat entry
// always re-validates this id against the live project catalog before navigating (see
// resolveCustomizeProjectId), so a deleted/missing reference falls back to the newest-existing project
// instead of a dead link.

const STORAGE_KEY = 'open-science:last-opened-project'

// Reads the persisted last-opened project id, or undefined when none has been recorded.
export const getLastOpenedProjectId = (): string | undefined => {
  const value = window.localStorage.getItem(STORAGE_KEY)
  return value && value.length > 0 ? value : undefined
}

// Records a project id as the most recently opened so a later `Chat with agent` entry re-opens it.
export const recordLastOpenedProject = (projectId: string): void => {
  window.localStorage.setItem(STORAGE_KEY, projectId)
}

// A minimal project shape sufficient for routing: id plus the updatedAt ordering used by the fallback.
type RoutingProject = {
  id: string
  updatedAt: number
}

// Resolves which project the `Chat with agent` entry should open against the live catalog. Returns the
// valid last-opened project when it still exists, otherwise the newest-existing project, and undefined
// when there are no projects at all (the entry is disabled in that case).
export const resolveCustomizeProjectId = (projects: RoutingProject[]): string | undefined => {
  if (projects.length === 0) return undefined

  const lastOpened = getLastOpenedProjectId()
  if (lastOpened && projects.some((project) => project.id === lastOpened)) {
    return lastOpened
  }

  return [...projects].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id
}
