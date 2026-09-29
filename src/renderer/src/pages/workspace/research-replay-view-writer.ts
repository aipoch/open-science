import type {
  ReplayViewState,
  SaveResearchReplayViewRequest,
  SaveResearchReplayViewResult
} from '../../../../shared/research-workspace'

// Each loaded source owns a writer. Disposing it prevents late replies from changing a newer
// source/retry's revision, surfacing stale errors, or dispatching another queued checkpoint.
export class ResearchReplayViewWriter {
  private pending?: ReplayViewState
  private saving = false
  private disposed = false
  constructor(
    private readonly identity: { projectId: string; sourceSessionId: string },
    private revision: number,
    private readonly save: (
      request: SaveResearchReplayViewRequest
    ) => Promise<SaveResearchReplayViewResult>,
    private readonly report: (result: 'saved' | 'conflict' | Error) => void
  ) {}

  enqueue = (state: ReplayViewState): void => {
    if (this.disposed) return
    this.pending = state
    if (!this.saving) void this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
  }

  private async drain(): Promise<void> {
    this.saving = true
    try {
      while (!this.disposed && this.pending) {
        const state = this.pending
        this.pending = undefined
        const result = await this.save({ ...this.identity, state, expectedRevision: this.revision })
        if (this.disposed) return
        if (result.status === 'conflict') {
          this.revision = result.snapshot?.revision ?? 0
          this.pending = undefined
          this.report('conflict')
          return
        }
        this.revision = result.revision
        this.report('saved')
      }
    } catch (error) {
      this.pending = undefined
      if (!this.disposed) this.report(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.saving = false
    }
  }
}
