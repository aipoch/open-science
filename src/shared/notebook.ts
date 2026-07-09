import type { ArtifactFile } from './artifacts'

export const NOTEBOOKS_DIR = 'notebooks'
export const NOTEBOOK_RUN_FILE = 'run.json'

// Identifies whether a run was initiated by the agent or by the user terminal.
export type NotebookRunSource = 'agent' | 'user'

// Distinguishes regular notebook cells from terminal submissions in the same history.
export type NotebookRunInputKind = 'cell' | 'terminal'

// Mirrors the lifecycle of one persisted execution record in run.json.
export type NotebookRunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'interrupted'

// Classifies files that are created inside the notebook session workspace.
export type NotebookWorkingFileKind =
  'raw-data' | 'processed-data' | 'cache' | 'script' | 'intermediate' | 'other'

// Keeps raw streams separate while also preserving a display-ready plain text projection.
export type NotebookTextOutput = {
  stdout: string
  stderr: string
  traceback: string
  plain: string[]
}

// Represents structured execution output returned by the interpreter bridge.
export type NotebookOutput =
  | {
      type: 'stream'
      name: 'stdout' | 'stderr'
      text: string
    }
  | {
      type: 'error'
      name?: string
      message?: string
      traceback: string
    }
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'json'
      data: unknown
    }

export type NotebookWorkingFile = {
  path: string
  relativePath: string
  kind: NotebookWorkingFileKind
  size?: number
  mtimeMs?: number
  createdByRunId?: string
}

// Captures the interpreter metadata persisted alongside run history.
export type NotebookKernelMetadata = {
  language: 'python'
  pythonPath?: string
  kernelName: string
  runtimeRoot: string
  lastKnownStatus: 'idle' | 'starting' | 'running' | 'error' | 'shutdown'
}

// Stores one durable notebook execution, including code, output, and generated-file references.
export type NotebookRunRecord = {
  runId: string
  cellId: string
  source: NotebookRunSource
  inputKind?: NotebookRunInputKind
  script: string
  status: NotebookRunStatus
  startedAt: number
  endedAt?: number
  cwdBefore?: string
  cwdAfter?: string
  executionCount?: number
  text: NotebookTextOutput
  outputs: NotebookOutput[]
  artifacts: ArtifactFile[]
  workingFiles: NotebookWorkingFile[]
  truncated?: boolean
}

// The complete JSON document persisted at each notebook session's run.json path.
export type NotebookRunDocument = {
  version: 1
  projectName: string
  sessionId: string
  artifactSessionId?: string
  workspaceCwd: string
  notebookSessionRoot: string
  dataRoot: string
  kernel: NotebookKernelMetadata
  runs: NotebookRunRecord[]
  updatedAt: number
}

// Represents the editable in-memory cell state shown by the notebook preview.
export type NotebookCell = {
  id: string
  language: 'python'
  code: string
  status: 'idle' | 'receiving-code' | 'running' | 'completed' | 'failed'
  writeId?: string
  executionCount?: number
  latestRunId?: string
}

// Prevents the user terminal and the agent stream from editing the same cell concurrently.
export type NotebookWriteLock = {
  writeId: string
  cellId: string
  source: NotebookRunSource
  startedAt: number
}

// Renderer-facing snapshot of one shared notebook interpreter session.
export type NotebookSessionState = {
  id: string
  sessionId: string
  artifactSessionId?: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  pythonPath?: string
  kernelStatus: NotebookKernelMetadata['lastKnownStatus']
  runJsonPath: string
  cells: NotebookCell[]
  activeWrite?: NotebookWriteLock
  activeRunId?: string
  runs: NotebookRunRecord[]
  recentRuns: NotebookRunRecord[]
}

// Lightweight session handle used by events and preview tabs to reopen the notebook.
export type NotebookSessionReference = {
  sessionId: string
  projectName: string
  workspaceCwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  runJsonPath: string
}

export type NotebookAvailableEvent = NotebookSessionReference
export type NotebookChangedEvent = NotebookSessionReference

// Extends a run record with workspace roots so the agent can decide what to do next.
export type NotebookRunSummary = NotebookRunRecord & {
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  pythonPath?: string
  kernelName: string
}

// Common routing fields required by every notebook command.
export type NotebookSessionRequest = {
  projectName?: string
  sessionId: string
  workspaceCwd: string
}

// Starts a streamed code write into a notebook cell.
export type BeginNotebookCodeCellRequest = NotebookSessionRequest & {
  cellId?: string
  source?: NotebookRunSource
}

// Appends raw code text to an active write lock.
export type AppendNotebookCodeCellRequest = NotebookSessionRequest & {
  writeId: string
  cellId: string
  delta: string
}

// Releases the write lock after the agent has finished streaming code.
export type FinishNotebookCodeCellRequest = NotebookSessionRequest & {
  writeId: string
  cellId: string
}

// Runs an existing cell in the shared interpreter.
export type RunNotebookCellRequest = NotebookSessionRequest & {
  cellId: string
  timeoutMs?: number
  source?: NotebookRunSource
  inputKind?: NotebookRunInputKind
}

// Convenience request that writes a cell and runs it in one command.
export type ExecuteNotebookCodeRequest = NotebookSessionRequest & {
  code: string
  timeoutMs?: number
  cellId?: string
  source?: NotebookRunSource
  inputKind?: NotebookRunInputKind
}
