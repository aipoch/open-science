import type { ProjectFolderChange } from '../../../../shared/project-folder-changes'

// This is display-only parsing. Main re-resolves the saved change by scoped ID before every action.
export const readProjectFolderChange = (input: unknown): ProjectFolderChange | undefined => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const change = (input as Record<string, unknown>).projectFolderChange
  if (!change || typeof change !== 'object' || Array.isArray(change)) return undefined
  const value = change as Record<string, unknown>
  if (
    !['id', 'projectId', 'sessionId', 'runId', 'relativePath'].every(
      (field) => typeof value[field] === 'string' && value[field].length > 0
    ) ||
    !['create', 'replace', 'delete'].includes(String(value.operation)) ||
    !['prepared', 'rejected', 'applied', 'reverted'].includes(String(value.state)) ||
    typeof value.requiresConfirmation !== 'boolean'
  )
    return undefined
  return value as ProjectFolderChange
}
