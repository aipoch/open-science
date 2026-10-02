import type {
  ReplayViewState,
  SaveSessionReplayProgressRequest,
  SaveSessionReplayProgressResult
} from '../../../../shared/session-replay'

// Each loaded source owns a writer. Disposing it prevents late replies from changing a newer
// source/retry's revision, surfacing stale errors, or dispatching another queued checkpoint.
export class SessionReplayProgressWriter {
  private latest?: ReplayViewState
  private saved?: string
  private pending?: ReplayViewState
  private saving = false
  private disposed = false
  private blocked = false
  constructor(
    private readonly identity: { projectId: string; sourceSessionId: string },
    private revision: number,
    private readonly save: (
      request: SaveSessionReplayProgressRequest
    ) => Promise<SaveSessionReplayProgressResult>,
    private readonly report: (result: 'saved' | 'conflict' | Error) => void
  ) {}

  enqueue = (state: ReplayViewState): void => {
    if (this.disposed) return
    this.latest = state
    if (this.blocked) return
    if (!this.saving && JSON.stringify(state) === this.saved) return
    this.pending = state
    if (!this.saving) void this.drain()
  }

  retry = (): void => {
    if (!this.saving && this.latest) {
      this.blocked = false
      this.enqueue(this.latest)
    }
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
    this.latest = undefined
  }

  private async drain(): Promise<void> {
    this.saving = true
    try {
      while (!this.disposed && this.pending) {
        const state = this.pending
        this.pending = undefined
        if (JSON.stringify(state) === this.saved) continue
        const result = await this.save({ ...this.identity, state, expectedRevision: this.revision })
        if (this.disposed) return
        if (result.status === 'conflict') {
          this.revision = result.snapshot?.revision ?? 0
          this.pending = undefined
          this.saved = undefined
          this.blocked = true
          this.report('conflict')
          return
        }
        this.revision = result.revision
        this.saved = JSON.stringify(state)
        this.report('saved')
      }
    } catch (error) {
      // A lost acknowledgement may have committed remotely; do not deduplicate against an
      // older confirmed position on the next explicit save. CAS still resolves that ambiguity.
      this.blocked = true
      this.saved = undefined
      this.pending = undefined
      if (!this.disposed) this.report(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.saving = false
    }
  }
}
