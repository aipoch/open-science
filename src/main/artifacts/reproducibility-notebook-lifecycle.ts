import type { ArtifactReproducibilityAttemptOwner } from './artifact-reproducibility-lifecycle'
import type { NotebookShutdownOptions, NotebookShutdownResult } from '../lifecycle-shutdown'

type NotebookLifecycle = {
  getActiveNotebookSessions(): { projectId: string; sessionId: string }[]
  dispose(): Promise<NotebookShutdownResult>
  shutdownAll(options?: NotebookShutdownOptions): Promise<NotebookShutdownResult>
}

// Reproduction runs use their own isolated kernels. Include them in the existing Notebook
// close/update/storage gates, while ordinary Notebook execution keeps its own owner.
export const withReproducibilityNotebookLifecycle = (
  notebook: NotebookLifecycle,
  getReproducibility: () => ArtifactReproducibilityAttemptOwner | undefined
): NotebookLifecycle => {
  const stop = async (
    method: 'dispose' | 'shutdownAll',
    options?: NotebookShutdownOptions
  ): Promise<NotebookShutdownResult> => {
    const [kernels, checks] = await Promise.allSettled([
      notebook[method](options),
      getReproducibility()?.[method]()
    ])
    return {
      reaped:
        kernels.status === 'fulfilled' && kernels.value.reaped && checks.status === 'fulfilled',
      ...(kernels.status === 'fulfilled' &&
      checks.status === 'fulfilled' &&
      kernels.value.legacyShellRecovery
        ? { legacyShellRecovery: kernels.value.legacyShellRecovery }
        : {})
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
    shutdownAll: (options) => stop('shutdownAll', options)
  }
}
