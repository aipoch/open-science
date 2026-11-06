import type { ResourceRecordingState } from '../../shared/resource-recording'
import { resourceActivity, type ResourceActivity } from './activity'

type Recording = { close(clean: boolean): Promise<void>; settled(): Promise<void> }

// One explicit recording per backend lifetime at a time. Nothing is persisted or polled.
export class ResourceRecording {
  private recording: Recording | undefined
  private phase: ResourceRecordingState
  private transition: Promise<unknown> = Promise.resolve()
  private disposed = false
  private failed = false
  private unsubscribe: () => void

  constructor(
    private readonly create: (() => Promise<Recording>) | undefined,
    private readonly changed: (state: ResourceRecordingState) => void,
    private readonly activity: ResourceActivity = resourceActivity
  ) {
    this.phase = create ? 'off' : 'unsupported'
    this.unsubscribe = activity.subscribe(() => {
      if (this.phase === 'recording') this.publish()
    })
  }

  getState(): ResourceRecordingState {
    if (this.phase !== 'recording') return this.phase
    return this.activity.state.suspended
      ? 'suspended'
      : this.activity.state.sampling
        ? 'recording'
        : 'idle'
  }

  private publish(): void {
    try {
      this.changed(this.getState())
    } catch {
      /* A disconnected UI cannot affect recording. */
    }
  }

  fail(): void {
    this.failed = true
    void this.stop(false).catch(() => undefined)
  }

  private enqueue(action: () => Promise<void>): Promise<ResourceRecordingState> {
    const next = this.transition.then(action)
    this.transition = next.catch(() => undefined)
    return next.then(() => this.getState())
  }

  start(): Promise<ResourceRecordingState> {
    return this.enqueue(async () => {
      if (this.disposed || !this.create || this.recording || this.phase === 'stopping') return
      this.phase = 'starting'
      this.failed = false
      this.publish()
      try {
        this.recording = await this.create()
        this.phase = 'recording'
      } catch {
        this.phase = 'failed'
      }
      this.publish()
    })
  }

  stop(clean = true): Promise<ResourceRecordingState> {
    return this.enqueue(async () => {
      const recording = this.recording
      if (!recording) return
      this.recording = undefined
      this.phase = 'stopping'
      this.publish()
      try {
        await recording.close(clean)
      } catch {
        this.failed = true
      } finally {
        // Do not allow start/stop clicks to accumulate outstanding native queries. Shutdown
        // still obeys its existing deadline instead of waiting for an uninterruptible OS read.
        void recording
          .settled()
          .catch(() => undefined)
          .then(() => {
            this.phase = this.failed ? 'failed' : 'off'
            this.publish()
          })
      }
    })
  }

  async close(clean: boolean): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    await this.stop(clean)
  }
}

let installed: ResourceRecording | undefined
export const installResourceRecording = (owner: ResourceRecording | undefined): void => {
  installed = owner
}
export const resourceRecording = {
  getState: (): ResourceRecordingState => installed?.getState() ?? 'unsupported',
  start: (): Promise<ResourceRecordingState> =>
    installed?.start() ?? Promise.resolve('unsupported'),
  stop: (): Promise<ResourceRecordingState> => installed?.stop() ?? Promise.resolve('unsupported')
}
