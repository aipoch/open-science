import type { ArtifactReproducibilityAttemptOwner } from './artifact-reproducibility-lifecycle'

type NotebookLifecycle = {
  getActiveNotebookSessions(): { projectId: string; sessionId: string }[]
  dispose(): Promise<{ reaped: boolean }>
  shutdownAll(): Promise<{ reaped: boolean }>
}

// Reproduction runs use their own isolated kernels. Include them in the existing Notebook
// close/update/storage gates, while ordinary Notebook execution keeps its own owner.
export const withReproducibilityNotebookLifecycle = (
  notebook: NotebookLifecycle,
  getReproducibility: () => ArtifactReproducibilityAttemptOwner | undefined
): NotebookLifecycle => {
  const stop = async (method: 'dispose' | 'shutdownAll'): Promise<{ reaped: boolean }> => {
    const [kernels, checks] = await Promise.allSettled([
      notebook[method](),
      getReproducibility()?.[method]()
    ])
    return {
      reaped:
        kernels.status === 'fulfilled' && kernels.value.reaped && checks.status === 'fulfilled'
    }
  }
  return {
    getActiveNotebookSessions: () => [
      ...new Map(
        [
          ...notebook.getActiveNotebookSessions(),
          ...(getReproducibility()?.getActiveSessions() ?? [])
        ].map((session) => [JSON.stringify([session.projectId, session.sessionId]), session])
      ).values()
    ],
    dispose: () => stop('dispose'),
    shutdownAll: () => stop('shutdownAll')
  }
}
