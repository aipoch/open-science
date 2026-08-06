// Shared project types crossing the main <-> renderer IPC boundary.
//
// The SQLite/Prisma layer owns Project rows (see src/main/projects). Timestamps are normalized to
// epoch milliseconds at the repository boundary so the renderer treats them like session timestamps.

export type Project = {
  id: string
  name: string
  description: string
  isExample: boolean
  // An absent timestamp keeps the Project on active surfaces. Archive is reversible and does not
  // affect the Project's research activity ordering.
  archivedAt?: number
  createdAt: number
  updatedAt: number
}

export type CreateProjectRequest = {
  name: string
  description?: string
}

export type UpdateProjectRequest = {
  id: string
  name?: string
  description?: string
}

export type DeleteProjectRequest = {
  id: string
}

export type UpdateProjectArchiveRequest = {
  id: string
  archived: boolean
  // The last authoritative archive value prevents a stale renderer from restoring or archiving a
  // Project after another window has already changed it.
  expectedArchivedAt: number | null
}
