import type { ArtifactFile } from './artifacts'
import type { NotebookRuntimeBindings } from './notebook-runtime'

export const NOTEBOOKS_DIR = 'notebooks'
export const NOTEBOOK_RUN_FILE = 'run.json'

// Identifies whether a run was initiated by the agent or by the user terminal.
export type NotebookRunSource = 'agent' | 'user'

// Distinguishes regular notebook cells from terminal submissions in the same history.
export type NotebookRunInputKind = 'cell' | 'terminal'

// Mirrors the lifecycle of one persisted execution record in run.json. 'interrupted' = the process
// died (crash / force-quit) while the run was in flight — reconciled from a stale 'running' on the
// next startup. 'cancelled' = the run was deliberately aborted (e.g. a force-stop disable).
export type NotebookRunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'interrupted' | 'cancelled'

export type NotebookRunProvenanceContext = {
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
}

// Languages a notebook kernel can run in this phase; each runs as a persistent exec-loop process
// (no ipykernel/IRkernel involved).
export type NotebookLanguage = 'python' | 'r'

// Identifies which kernel produced a run: python/r are analysis cells, repl/bash are
// control-plane/shell.
export type NotebookKernelKind = 'python' | 'r' | 'repl' | 'bash'

export type NotebookEnvironmentPackage = {
  name: string
  version?: string
  versionStatus: 'known' | 'unavailable'
  ecosystem: 'python' | 'r' | 'native' | 'unknown'
  evidenceSources: Array<
    | 'python-importlib-metadata'
    | 'python-kernel-modules'
    | 'r-installed-packages'
    | 'r-session-info'
  >
  loadedState?: 'attached' | 'loaded' | 'installed-only' | 'unknown'
  libraryRank?: number
  libraryScope?: 'environment' | 'user' | 'system' | 'unknown'
  builtForRuntime?: string
  priority?: 'base' | 'recommended' | 'other'
}

export type NotebookPackageInstaller =
  | 'conda'
  | 'pip'
  | 'uv'
  | 'poetry'
  | 'r-install-packages'
  | 'renv'
  | 'pak'
  | 'biocmanager'
  | 'unknown'

export type NotebookPackageInstallerAttempt = {
  groupOrdinal: number
  installer: NotebookPackageInstaller
  packages: string[]
  status: 'succeeded' | 'failed' | 'skipped'
  mutationRisk: 'none' | 'possible' | 'confirmed' | 'unknown'
  reason?:
    | 'package-not-found'
    | 'solver-failed'
    | 'installer-unavailable'
    | 'permission'
    | 'network'
    | 'authentication'
    | 'tls-policy'
    | 'validation'
    | 'cancelled'
    | 'process-unconfirmed'
    | 'recovery-blocked'
    | 'unknown'
}

export type NotebookInventoryRefreshAttempt = {
  attempt: number
  trigger: 'terminal' | 'recovery'
  timestamp: string
  result: 'published' | 'unchanged' | 'failed'
  error?: string
}

export type NotebookEnvironmentPackageChange = {
  name: string
  ecosystem: NotebookEnvironmentPackage['ecosystem']
  relationship: 'requested' | 'dependency' | 'unattributed'
  change: 'installed' | 'updated' | 'removed' | 'unchanged' | 'observed'
  beforeVersion?: string
  afterVersion?: string
  libraryRank?: number
  libraryScope?: NotebookEnvironmentPackage['libraryScope']
}

export type NotebookEnvironmentOperation = {
  operationId: string
  timestamp: string
  operation: 'create' | 'install' | 'uninstall' | 'update'
  packages: string[]
  result: 'success' | 'failure'
  attempts: NotebookPackageInstallerAttempt[]
  fallbackUsed: boolean
  inventoryRefresh: 'published' | 'unchanged' | 'failed'
  inventoryRefreshAttempts: NotebookInventoryRefreshAttempt[]
  packageChanges?: NotebookEnvironmentPackageChange[]
}

export type NotebookEnvironmentManifest = {
  schemaVersion: 1
  captureKind: 'completed-run'
  capturedAt: string
  installedInventory: {
    capturedAt: string
    source: 'full-scan' | 'cache-reused'
    validation: 'full-scan' | 'best-effort'
  }
  kernelKind: NotebookLanguage
  environmentName: string
  runtimeSource: 'managed' | 'external'
  runtimeVersion?: string
  platform: string
  architecture: string
  inventorySources: Array<'kernel-native' | 'interpreter-native' | 'operation-log'>
  packages: NotebookEnvironmentPackage[]
  operationLog?: NotebookEnvironmentOperation[]
  complete: boolean
  captureStatus: 'complete' | 'partial'
  warnings?: string[]
}

export type NotebookRunEnvironmentCapture =
  | {
      state: 'available' | 'partial'
      manifestChecksum: string
      warnings?: string[]
    }
  | {
      state: 'unavailable'
      reason:
        | 'environment-not-supported'
        | 'environment-capture-failed'
        | 'environment-manifest-publication-failed'
        | 'legacy-environment-reference-unavailable'
    }

export type NotebookLiveEnvironmentOverlay = {
  runtimeVersion?: string
  packages: NotebookEnvironmentPackage[]
  warnings?: string[]
}

export type NotebookInputAssociation = 'turn-attached' | 'resolver-accessed'

// Path-independent immutable input identity captured from the trusted main-process registry. The
// storage key is persisted only in run.json/evidence; summaries returned to agents and renderers omit
// it and resolve previews through main-process IPC.
export type NotebookRunInputFile = {
  inputFileVersionId: string
  sourceKind: 'upload-version' | 'artifact-version'
  sourceFileId: string
  sourceVersionNumber?: number
  sourceCreatedAt?: string
  sourceProjectId: string
  sourceSessionId: string
  filename: string
  contentType?: string
  sizeBytes: number
  checksum: string
  storageKey: string
  association: NotebookInputAssociation
}

export type NotebookInputFileSummary = Omit<NotebookRunInputFile, 'storageKey'>

export type NotebookInputPreviewIdentity = {
  projectId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  inputFileVersionId: string
}

const NOTEBOOK_INPUT_PREVIEW_PREFIX = 'notebook-input:'

export const createNotebookInputPreviewKey = (identity: NotebookInputPreviewIdentity): string =>
  `${NOTEBOOK_INPUT_PREVIEW_PREFIX}${encodeURIComponent(
    JSON.stringify([identity.projectId, identity.sourceKind, identity.inputFileVersionId])
  )}`

export const parseNotebookInputPreviewKey = (key: string): NotebookInputPreviewIdentity => {
  if (!key.startsWith(NOTEBOOK_INPUT_PREVIEW_PREFIX)) {
    throw new Error('Invalid Notebook input preview key.')
  }
  const parsed = JSON.parse(
    decodeURIComponent(key.slice(NOTEBOOK_INPUT_PREVIEW_PREFIX.length))
  ) as unknown
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed.some((value) => typeof value !== 'string') ||
    (parsed[1] !== 'upload-version' && parsed[1] !== 'artifact-version')
  ) {
    throw new Error('Invalid Notebook input preview key.')
  }
  return {
    projectId: parsed[0] as string,
    sourceKind: parsed[1],
    inputFileVersionId: parsed[2] as string
  }
}

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
      // 1-based source line of the failing statement, when the kernel can attribute one (R).
      line?: number
    }
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'json'
      data: unknown
    }
  | {
      // A mime→payload bundle for rich results (e.g. plots, scalar values). Text mimes are verbatim;
      // image/png is base64.
      type: 'display'
      data: Record<string, string>
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
// 'idle' is the resting state between runs; 'running' is written around a live cell/control run;
// 'restarting' covers the window of a restart() in progress; 'terminated' marks a proc dropped for
// being idle or lost to a crash/hard-timeout (see NotebookKernelExecutor). 'shutdown' remains the
// explicit user/app-initiated teardown. 'starting' and 'error' are reserved: proc spawn is transient
// and internal to the executor, and a kernel-level failure currently surfaces as a run-level 'failed'
// status rather than a distinct kernel state.
export type NotebookKernelMetadata = {
  language: 'python'
  pythonPath?: string
  kernelName: string
  runtimeRoot: string
  lastKnownStatus:
    'idle' | 'starting' | 'running' | 'error' | 'shutdown' | 'restarting' | 'terminated'
}

// Stores one durable notebook execution, including code, output, and generated-file references.
export type NotebookRunRecord = {
  runId: string
  cellId: string
  source: NotebookRunSource
  inputKind?: NotebookRunInputKind
  // The kernel that produced this run; python/r are analysis cells, repl/bash are
  // control-plane/shell.
  kernelKind: NotebookKernelKind
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
  // New native runs persist the exact registered input Versions. Optional keeps legacy run.json
  // documents readable; repository normalization supplies an empty array for old records.
  inputFiles?: NotebookRunInputFile[]
  truncated?: boolean
  // Named env that produced this run (python/r only; omitted for repl/bash).
  environment?: string
  // Immutable completed-run environment evidence. The cache that helped build it is never referenced.
  environmentCapture?: NotebookRunEnvironmentCapture
  environmentManifest?: NotebookEnvironmentManifest
  environmentManifestChecksum?: string
  // Trusted turn/Branch attribution injected by the main-process RPC bridge. Legacy and user-run
  // records may omit it; a supplied Artifact producer must match all five fields.
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  runtimeSegmentId?: string
  promptMessageId?: string
  // Why a run ended non-normally. Set to 'app-terminated' when a stale 'running' run is reconciled to
  // 'interrupted' on the next startup (the process died mid-run). Absent for normal completions.
  interruptionReason?: 'app-terminated'
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
  // v4 persisted per-language session runtime bindings (wire shape), so a session's bound runtime — and
  // why it may be unavailable — survives an app restart. Reloaded + revalidated on the next session
  // load (a bound runtime that is no longer enabled/detected becomes unavailable, never a silent
  // fallback). Absent for sessions that never bound a runtime.
  runtimeBindings?: NotebookRuntimeBindings
}

// Represents the editable in-memory cell state shown by the notebook preview.
export type NotebookCell = {
  id: string
  language: NotebookLanguage
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

// Live per-environment kernel status surfaced in state() for the multi-env preview (design D6). One
// entry per (kind, env) process the session has spawned, keyed by the executor's ProcessKey
// (`${kind}:${env}` for python/r, `repl` for the control kernel). The coarse `kernelStatus` on the
// session state stays the DEFAULT env's status for backward compat; this array is the per-env view.
// In-memory only for now — persisting it into run.json is a separate later task (T8).
export type NotebookEnvironmentStatus = {
  processKey: string
  kind: 'python' | 'r' | 'repl'
  // Resolved env name for python/r; omitted for the env-agnostic repl kernel.
  environment?: string
  status: NotebookKernelMetadata['lastKnownStatus']
  // Set after an R install/uninstall: the live R session won't see the change until it restarts, so
  // the preview surfaces a restart prompt. Only R sets this (Python picks up new packages on import).
  restartRecommended?: boolean
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
  // Live per-(kind, env) kernel status view (design D6); empty until the session spawns a kernel.
  environments: NotebookEnvironmentStatus[]
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
export type NotebookRunSummary = Omit<NotebookRunRecord, 'inputFiles'> & {
  inputFiles: NotebookInputFileSummary[]
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
  provenanceContext?: NotebookRunProvenanceContext
  // Injected only by the authenticated local RPC bridge after resolving the active turn registry.
  // Renderer IPC strips this field before calling the runtime service.
  registeredInputFiles?: NotebookRunInputFile[]
}

// Resolves the data kernel ('python' or 'r') that owns a given tab. For python/r tabs the
// answer is the tab itself; for repl/bash tabs it is the most recent data kernel that was
// active when the control run executed. Returns undefined when no data run has ever occurred.
export const resolveDataKernelForTab = (
  runs: NotebookRunRecord[],
  tab: NotebookKernelKind
): 'python' | 'r' | undefined => {
  if (tab === 'python' || tab === 'r') return tab
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    if (run && (run.kernelKind === 'python' || run.kernelKind === 'r')) return run.kernelKind
  }
  return undefined
}

export type ExportNotebookResult =
  | { saved: false }
  | {
      saved: true
      filePath: string
    }

// Targets the data kernel for an export. The renderer passes the active tab's kernel so the
// resulting .ipynb uses the matching kernelspec and never falls back to "dominant" — that earlier
// silent rule made mixed sessions misleadingly export the wrong notebook. `repl` and `bash` are
// control-plane runs with no standalone kernelspec; the service translates them to the kernel of the
// most recent data run, or rejects the call when no data run has ever occurred.
export type ExportNotebookKernelRequest = NotebookSessionRequest & {
  kernel: NotebookKernelKind
}

// "Download all" path: every data kernel that actually has runs gets its own .ipynb in a directory
// the user picks, with control-plane runs grouped under the data kernel that was active at the time.
export type ExportNotebookAllRequest = NotebookSessionRequest

export type ExportNotebookAllResult =
  | { saved: false }
  | {
      saved: true
      // The directory the user picked plus the kernel → file basename map. The renderer uses this to
      // confirm "saved <count> notebooks to <dir>" in the footer banner.
      directory: string
      files: Array<{ kernel: 'python' | 'r'; filePath: string }>
    }

// Starts a streamed code write into a notebook cell.
export type BeginNotebookCodeCellRequest = NotebookSessionRequest & {
  cellId?: string
  source?: NotebookRunSource
  language?: NotebookLanguage
  // Named env to bind this cell to; omitted -> the default env for language.
  environment?: string
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
  // Named env to run this cell in; omitted -> the default env for the cell's language.
  environment?: string
}

// Convenience request that writes a cell and runs it in one command.
export type ExecuteNotebookCodeRequest = NotebookSessionRequest & {
  code: string
  timeoutMs?: number
  cellId?: string
  source?: NotebookRunSource
  inputKind?: NotebookRunInputKind
  language?: NotebookLanguage
  // Named env to execute in; omitted -> the default env for language.
  environment?: string
}

// Runs code on the control-plane REPL kernel (JS; the only kernel with host.mcp connector access).
// Distinct from data cells: no run history, no NotebookLanguage — just code and an optional timeout.
export type ExecuteNotebookControlRequest = NotebookSessionRequest & {
  code: string
  timeoutMs?: number
}

// Runs one shell command in a fresh, stateless process in the session workspace. Distinct from every
// other kernel: no persistent process, no run history, no NotebookLanguage — just a command and an
// optional timeout.
export type ExecuteShellRequest = NotebookSessionRequest & {
  command: string
  timeoutMs?: number
}
