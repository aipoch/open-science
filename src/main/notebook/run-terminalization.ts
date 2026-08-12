import type {
  NotebookEnvironmentManifest,
  NotebookOutput,
  NotebookRunEnvironmentCapture,
  NotebookRunRecord,
  NotebookRunStatus,
  NotebookWorkingFile
} from '../../shared/notebook'
import type { NotebookRunRepository } from './repository'
import type { NotebookLaneIdentity } from './lane-identity'

type NotebookRunIdentity = Readonly<{
  runId: string
  sequence: number
}>

type NotebookRunTerminalizationSession = Readonly<{
  projectName: string
  sessionId: string
  lane: NotebookLaneIdentity
}>

type NotebookRunTerminalResult = {
  status: NotebookRunStatus
  stdout: string
  stderr: string
  traceback: string
  cwdAfter?: string
  outputs: NotebookOutput[]
  workingFiles?: NotebookWorkingFile[]
  environmentManifest?: NotebookEnvironmentManifest
  environmentManifestChecksum?: string
  environmentCapture?: NotebookRunEnvironmentCapture
}

type TerminalizeNotebookRunRequest<Result extends NotebookRunTerminalResult> = {
  session: NotebookRunTerminalizationSession
  runningRun: NotebookRunRecord
  invoke: () => Promise<Result>
  postCommit?: (result: Result, run: NotebookRunRecord) => void
}

type NotebookRunTerminalizationOwnerOptions = {
  repository: Pick<NotebookRunRepository, 'appendRun' | 'updateRun'>
  notifyChanged: (session: NotebookRunTerminalizationSession) => void
  now?: () => number
}

const outputPlainText = (stdout: string, stderr: string): string[] =>
  [stdout, stderr].filter((text) => text.trim().length > 0)

class NotebookRunTerminalizationOwner {
  private sequence = 0
  private readonly now: () => number

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
    await this.options.repository.appendRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      lane,
      run: runningRun
    })
    this.options.notifyChanged(session)

    const result = await request.invoke()
    const environmentCapture: NotebookRunEnvironmentCapture =
      result.environmentCapture ??
      (runningRun.kernelKind === 'python' || runningRun.kernelKind === 'r'
        ? { state: 'unavailable', reason: 'environment-capture-failed' }
        : { state: 'unavailable', reason: 'environment-not-supported' })
    const terminalRun: NotebookRunRecord = {
      ...runningRun,
      status: result.status,
      endedAt: this.now(),
      cwdAfter: result.cwdAfter,
      text: {
        stdout: result.stdout,
        stderr: result.stderr,
        traceback: result.traceback,
        plain: outputPlainText(result.stdout, result.stderr)
      },
      // The normalized outputs already include any traceback; appending another error output would
      // make the preview render it twice.
      outputs: result.outputs,
      workingFiles: result.workingFiles ?? [],
      environmentCapture,
      ...(environmentCapture.state !== 'unavailable' && result.environmentManifest
        ? { environmentManifest: result.environmentManifest }
        : {}),
      ...(environmentCapture.state !== 'unavailable' && result.environmentManifestChecksum
        ? { environmentManifestChecksum: result.environmentManifestChecksum }
        : {})
    }
    const document = await this.options.repository.updateRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      lane,
      run: terminalRun
    })
    const run = document.runs.find((candidate) => candidate.runId === runningRun.runId)

    if (!run) {
      throw new Error(`Notebook run not found after update: ${runningRun.runId}`)
    }

    request.postCommit?.(result, run)
    this.options.notifyChanged(session)

    return { run, result }
  }
}

export { NotebookRunTerminalizationOwner }
