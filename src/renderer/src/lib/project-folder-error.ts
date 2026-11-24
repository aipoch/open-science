import type { ProjectFolderValidationResult } from '../../../shared/projects'

export type ProjectFolderProblem = Pick<
  Extract<ProjectFolderValidationResult, { ok: false }>,
  'kind' | 'diagnostics'
>

export const projectFolderFailure = (error: unknown): ProjectFolderProblem | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const kind =
    error.code === 'project-folder-conflict'
      ? 'conflict'
      : error.code === 'project-folder-not-found'
        ? 'not-found'
        : error.code === 'project-folder-unavailable'
          ? 'unavailable'
          : undefined
  if (!kind) return undefined
  return {
    kind,
    diagnostics: 'message' in error && typeof error.message === 'string' ? error.message : ''
  }
}
