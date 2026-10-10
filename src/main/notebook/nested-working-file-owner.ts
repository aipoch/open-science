import type { NotebookRunRecord, NotebookWorkingFile } from '../../shared/notebook'

/** Main-only evidence from the observer that froze this exact file generation. */
export type FrozenNestedWorkingFile = Readonly<{
  activityId: string
  evidenceChecksum: string
  file: Readonly<NotebookWorkingFile>
  physicalPath: string
  dev: number
  ino: number
  ctimeMs: number
}>

export type NestedWorkingFileReader = Readonly<{
  read(): readonly FrozenNestedWorkingFile[]
}>

type Scope = Readonly<{
  projectId: string
  sessionId: string
  parentControlInvocationId: string
  rootExecutionId?: string
}>

const provenanceKeys = [
  'rootFrameId',
  'agentFrameId',
  'messageBranchId',
  'runtimeSegmentId',
  'promptMessageId'
] as const
const fileKeys = [
  'path',
  'relativePath',
  'kind',
  'size',
  'mtimeMs',
  'generationId',
  'checksum'
] as const
const key = (scope: Scope): string =>
  JSON.stringify([scope.projectId, scope.sessionId, scope.parentControlInvocationId])

/**
 * A control invocation may reference a committed managed child, never infer one from history.
 * Entries disappear when that control execution settles; neither IPC nor persisted DTOs can
 * create this relationship. The observer still rechecks the final file before using a reference.
 */
export class NestedWorkingFileOwner {
  private readonly active = new Map<
    string,
    { scope: Scope; run: NotebookRunRecord; files: FrozenNestedWorkingFile[] }
  >()

  open(scope: Scope, run: NotebookRunRecord): NestedWorkingFileReader & { close(): void } {
    const identity = key(scope)
    if (this.active.has(identity)) throw new Error('Nested file observation is already active.')
    const entry = {
      scope: { ...scope },
      run: structuredClone(run),
      files: [] as FrozenNestedWorkingFile[]
    }
    this.active.set(identity, entry)
    return Object.freeze({
      read: () => (this.active.get(identity) === entry ? entry.files.slice() : []),
      close: () => {
        if (this.active.get(identity) === entry) this.active.delete(identity)
        entry.files.length = 0
      }
    })
  }

  /** Call only after the child's terminal Run and file-evidence reference have committed. */
  record(scope: Scope, child: NotebookRunRecord, frozen: readonly FrozenNestedWorkingFile[]): void {
    const entry = this.active.get(key(scope))
    if (
      !entry ||
      !scope.rootExecutionId ||
      entry.scope.rootExecutionId !== scope.rootExecutionId ||
      entry.run.runId !== scope.parentControlInvocationId ||
      entry.run.kernelKind !== 'repl' ||
      child.kernelKind !== 'bash' ||
      child.status === 'queued' ||
      child.status === 'running' ||
      child.runId === entry.run.runId ||
      provenanceKeys.some((field) => child[field] !== entry.run[field]) ||
      !child.fileEvidence?.checksum ||
      child.fileEvidence.activityId !== child.runId ||
      child.fileEvidence.activityKind !== 'notebook-run'
    )
      return
    for (const candidate of frozen) {
      if (
        candidate.activityId !== child.runId ||
        candidate.evidenceChecksum !== child.fileEvidence.checksum ||
        !candidate.file.generationId ||
        !candidate.file.checksum
      )
        continue
      const matches = child.workingFiles.filter(
        (file) =>
          file.createdByRunId === child.runId &&
          fileKeys.every((field) => file[field] === candidate.file[field])
      )
      if (matches.length !== 1) continue
      if (
        entry.files.some(
          (file) => file.activityId === child.runId && file.file.path === candidate.file.path
        )
      )
        continue
      entry.files.push(
        Object.freeze({
          ...candidate,
          file: Object.freeze({ ...matches[0] })
        })
      )
    }
  }
}
