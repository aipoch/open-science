import type {
  NotebookEnvironmentManifest,
  NotebookOutput,
  NotebookRunEnvironmentCapture,
  NotebookRunRecord,
  NotebookRunStatus,
  NotebookWorkingFile
} from '../../shared/notebook'
import type { NotebookRunRepository } from './repository'
import { notebookLaneKey, type NotebookLaneIdentity } from './lane-identity'
import { limitNotebookTerminalContent } from './content-limits'

type NotebookRunIdentity = Readonly<{
  runId: string
  sequence: number
}>

type NotebookRunTerminalizationSession = Readonly<{
  projectId: string
  sessionId: string
  lane: NotebookLaneIdentity
}>

type NotebookRunTerminalResult = {
  status: Exclude<NotebookRunStatus, 'queued' | 'running'>
  stdout: string
  stderr: string
  traceback: string
  cwdAfter?: string
  outputs: NotebookOutput[]
  truncated?: boolean
  workingFiles?: NotebookWorkingFile[]
  environmentManifest?: NotebookEnvironmentManifest
  environmentManifestChecksum?: string
  environmentCapture?: NotebookRunEnvironmentCapture
  kernelDispatched?: boolean
}

type TerminalizeNotebookRunRequest<Result extends NotebookRunTerminalResult> = {
  session: NotebookRunTerminalizationSession
  runningRun: NotebookRunRecord
  invoke: () => Promise<Result>
  settleLive?: (result: NotebookRunTerminalResult) => void
}

type NotebookRunTerminalizationOwnerOptions = {
  repository: Pick<NotebookRunRepository, 'appendRun' | 'updateRun'>
  notifyChanged: (session: NotebookRunTerminalizationSession) => void
  now?: () => number
}

const outputPlainText = (stdout: string, stderr: string): string[] =>
  [stdout, stderr].filter((text) => text.trim().length > 0)

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

class NotebookRunTerminalizationOwner {
  private sequence = 0
  private readonly now: () => number
  private readonly pendingTerminalRuns = new Map<
    string,
    Readonly<{
      session: NotebookRunTerminalizationSession
      run: NotebookRunRecord
    }>
  >()
  private readonly terminalRecoveryByLane = new Map<string, Promise<void>>()

  constructor(private readonly options: NotebookRunTerminalizationOwnerOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  allocateRunIdentity(): NotebookRunIdentity {
    this.sequence += 1
    return {
      runId: `notebook-run-${this.now()}-${this.sequence}`,
      sequence: this.sequence
    }
  }

  async run<Result extends NotebookRunTerminalResult>(
    request: TerminalizeNotebookRunRequest<Result>
  ): Promise<{ run: NotebookRunRecord; result: Result }> {
    const { session, runningRun } = request
    const lane = session.lane
    let liveResult: NotebookRunTerminalResult | undefined
    try {
      await this.reconcilePending(session)
      await this.options.repository.appendRun({
        projectId: session.projectId,
        sessionId: session.sessionId,
        lane,
        run: runningRun
      })
      this.options.notifyChanged(session)

      let result: Result
      try {
        result = await request.invoke()
      } catch (error) {
        liveResult = {
          status: 'interrupted',
          stdout: '',
          stderr: errorMessage(error),
          traceback: '',
          cwdAfter: runningRun.cwdBefore,
          outputs: []
        }
        await this.commitOrRememberTerminalRun(
          session,
          this.buildTerminalRun(runningRun, liveResult, 'execution-error')
        )
        throw error
      }
      liveResult = result
      const terminalRun = this.buildTerminalRun(runningRun, result)
      const run = await this.commitOrRememberTerminalRun(session, terminalRun)

      return { run, result }
    } catch (error) {
      liveResult ??= {
        status: 'interrupted',
        stdout: '',
        stderr: errorMessage(error),
        traceback: '',
        cwdAfter: runningRun.cwdBefore,
        outputs: []
      }
      throw error
    } finally {
      try {
        if (liveResult) request.settleLive?.(liveResult)
      } finally {
        if (liveResult) this.options.notifyChanged(session)
      }
    }
  }

  // A transient final-write failure must not require an app restart to repair. The Notebook state
  // poll and the next execution both re-enter here; each caller joins one bounded retry per lane.
  async reconcilePending(session: NotebookRunTerminalizationSession): Promise<void> {
    const laneKey = notebookLaneKey(session.lane)
    const pending = Array.from(this.pendingTerminalRuns.entries()).filter(
      ([, candidate]) => notebookLaneKey(candidate.session.lane) === laneKey
    )
    if (pending.length === 0) return

    const activeRecovery = this.terminalRecoveryByLane.get(laneKey)
    if (activeRecovery) return activeRecovery

    const recovery = (async () => {
      for (const [pendingKey, candidate] of pending) {
        await this.commitTerminalRun(candidate.session, candidate.run)
        if (this.pendingTerminalRuns.get(pendingKey) === candidate) {
          this.pendingTerminalRuns.delete(pendingKey)
        }
        this.options.notifyChanged(candidate.session)
      }
    })().finally(() => {
      if (this.terminalRecoveryByLane.get(laneKey) === recovery) {
        this.terminalRecoveryByLane.delete(laneKey)
      }
    })
    this.terminalRecoveryByLane.set(laneKey, recovery)
    return recovery
  }

  private buildTerminalRun(
    runningRun: NotebookRunRecord,
    result: NotebookRunTerminalResult,
    interruptionReason?: NotebookRunRecord['interruptionReason']
  ): NotebookRunRecord {
    const limitedResult = limitNotebookTerminalContent(result)
    const environmentCapture: NotebookRunEnvironmentCapture =
      limitedResult.environmentCapture ??
      (runningRun.kernelKind === 'python' || runningRun.kernelKind === 'r'
        ? { state: 'unavailable', reason: 'environment-capture-failed' }
        : { state: 'unavailable', reason: 'environment-not-supported' })
    const terminalRun: NotebookRunRecord = {
      ...runningRun,
      status: limitedResult.status,
      endedAt: this.now(),
      cwdAfter: limitedResult.cwdAfter,
      text: {
        stdout: limitedResult.stdout,
        stderr: limitedResult.stderr,
        traceback: limitedResult.traceback,
        plain: outputPlainText(limitedResult.stdout, limitedResult.stderr)
      },
      // The normalized outputs already include any traceback; appending another error output would
      // make the preview render it twice.
      outputs: limitedResult.outputs,
      workingFiles: limitedResult.workingFiles ?? [],
      ...(limitedResult.truncated ? { truncated: true } : {}),
      environmentCapture,
      ...(limitedResult.kernelDispatched !== undefined
        ? { kernelDispatched: limitedResult.kernelDispatched }
        : {}),
      ...(interruptionReason ? { interruptionReason } : {}),
      ...(environmentCapture.state !== 'unavailable' && limitedResult.environmentManifest
        ? { environmentManifest: limitedResult.environmentManifest }
        : {}),
      ...(environmentCapture.state !== 'unavailable' && limitedResult.environmentManifestChecksum
        ? { environmentManifestChecksum: limitedResult.environmentManifestChecksum }
        : {})
    }
    return terminalRun
  }

  private async commitTerminalRun(
    session: NotebookRunTerminalizationSession,
    terminalRun: NotebookRunRecord
  ): Promise<NotebookRunRecord> {
    const document = await this.options.repository.updateRun({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      run: terminalRun
    })
    const run = document.runs.find((candidate) => candidate.runId === terminalRun.runId)

    if (!run) {
      throw new Error(`Notebook run not found after update: ${terminalRun.runId}`)
    }

    return run
  }

  private async commitOrRememberTerminalRun(
    session: NotebookRunTerminalizationSession,
    terminalRun: NotebookRunRecord
  ): Promise<NotebookRunRecord> {
    try {
      return await this.commitTerminalRun(session, terminalRun)
    } catch (error) {
      this.pendingTerminalRuns.set(`${notebookLaneKey(session.lane)}:${terminalRun.runId}`, {
        session,
        run: terminalRun
      })
      throw error
    }
  }
}

export { NotebookRunTerminalizationOwner }
