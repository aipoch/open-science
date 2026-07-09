// Shared project types crossing the main <-> renderer IPC boundary.
//
// The SQLite/Prisma layer owns Project rows (see src/main/projects). Timestamps are normalized to
// epoch milliseconds at the repository boundary so the renderer treats them like session timestamps.

export type Project = {
  id: string
  name: string
  description: string
  isExample: boolean
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
