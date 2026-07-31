import type { PermissionGrantScope } from '../../shared/permission-grants'

type PermissionScopeLivenessDependencies = {
  projectExists: (projectId: string) => Promise<boolean>
  persistedSessionExists: (projectId: string, sessionId: string) => Promise<boolean>
  liveSessionExists: (projectId: string, sessionId: string) => boolean
}

const isPermissionGrantScopeLive = async (
  scope: PermissionGrantScope,
  dependencies: PermissionScopeLivenessDependencies
): Promise<boolean> => {
  if (scope.kind === 'global') return true
  if (!(await dependencies.projectExists(scope.projectId))) return false
  if (scope.kind === 'project') return true
  if (await dependencies.persistedSessionExists(scope.projectId, scope.sessionId)) return true
  return dependencies.liveSessionExists(scope.projectId, scope.sessionId)
}

export { isPermissionGrantScopeLive }
