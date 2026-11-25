export { TaskRunTracingError } from '../../shared/task-api'

type TaskControlPorts = {
  findSessionAfterCatalogHydration?(sessionId: string): Promise<{ projectId: string } | undefined>
  findArtifactSessions?(
    artifactId: string
  ): Promise<Array<{ projectId: string; sessionId: string }>>
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
}

export type { TaskControlPorts }
