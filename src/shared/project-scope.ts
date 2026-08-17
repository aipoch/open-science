// Canonical Project routing uses the immutable Project id. Historical aliases are decoded only at
// their persistence or process boundary and never enter current application contracts.
export type ProjectIdScope = Readonly<{ projectId: string }>

export type OptionalProjectIdScope = Readonly<{
  projectId?: string
}>

export const resolveProjectId = (scope: OptionalProjectIdScope, fallback?: string): string => {
  const projectId = scope.projectId ?? fallback
  if (!projectId) throw new Error('A projectId is required.')
  return projectId
}
