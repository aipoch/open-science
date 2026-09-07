import type { BackgroundResultSourceRef } from '../../shared/background-result-delivery'
import type { NotebookRunRecord } from '../../shared/notebook'

const notebookRunSourceRef = (
  session: Readonly<{ projectId: string; sessionId: string }>,
  run: Pick<NotebookRunRecord, 'runId' | 'agentFrameId'>
): BackgroundResultSourceRef => ({
  sourceKind: 'local-run',
  sourceId: run.runId,
  projectId: session.projectId,
  sessionId: session.sessionId,
  ...(run.agentFrameId ? { agentFrameId: run.agentFrameId } : {})
})

type NotebookRunResultDeliveryAdapterDeps = Readonly<{
  listWaiting(): Promise<readonly BackgroundResultSourceRef[]>
  enqueue(source: BackgroundResultSourceRef): Promise<unknown>
}>

type WaitingLocalRunRequest = Readonly<{
  projectId: string
  sessionId: string
  runId: string
  agentFrameId?: string
}>

class NotebookRunResultDeliveryAdapter {
  constructor(private readonly deps: NotebookRunResultDeliveryAdapterDeps) {}

  async recoverWaiting(
    loadRun: (request: WaitingLocalRunRequest) => Promise<NotebookRunRecord | undefined>
  ): Promise<void> {
    const waiting = (await this.deps.listWaiting()).filter(
      ({ sourceKind }) => sourceKind === 'local-run'
    )
    await Promise.all(
      waiting.map(async (source) => {
        const run = await loadRun({
          projectId: source.projectId,
          sessionId: source.sessionId,
          runId: source.sourceId,
          ...(source.agentFrameId ? { agentFrameId: source.agentFrameId } : {})
        })
        if (
          run?.executionMode === 'background' &&
          run.status !== 'queued' &&
          run.status !== 'running'
        ) {
          await this.deps.enqueue(source)
        }
      })
    )
  }
}

export { NotebookRunResultDeliveryAdapter, notebookRunSourceRef }
export type { NotebookRunResultDeliveryAdapterDeps, WaitingLocalRunRequest }
