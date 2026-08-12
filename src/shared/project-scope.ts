// Canonical Project routing uses the immutable Project id. `projectName` is accepted only because
// older Artifact/Notebook transports used that field name while carrying the id as its value.
export type ProjectIdScope =
  | Readonly<{ projectId: string; projectName?: string }>
  | Readonly<{ projectId?: undefined; projectName: string }>

export type OptionalProjectIdScope = Readonly<{
  projectId?: string
  projectName?: string
}>

export const resolveProjectId = (scope: OptionalProjectIdScope, fallback?: string): string => {
  if (
    scope.projectId !== undefined &&
    scope.projectName !== undefined &&
    scope.projectId !== scope.projectName
  ) {
    throw new Error('Conflicting projectId and legacy projectName values.')
  }

  const projectId = scope.projectId ?? scope.projectName ?? fallback
  if (!projectId) throw new Error('A projectId is required.')
  return projectId
}
