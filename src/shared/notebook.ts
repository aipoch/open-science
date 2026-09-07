import { z } from 'zod'

import {
  defineApplicationCommandContract,
  validationCodec,
  type RuntimeCodec
} from './application-command-contract'
import type { ArtifactFile } from './artifacts'
import type { ExecutionFileEvidenceSummary } from './execution-file-evidence'
import type { NotebookRuntimeBindings } from './notebook-runtime'
import type { OptionalProjectIdScope, ProjectIdScope } from './project-scope'

export const NOTEBOOKS_DIR = 'notebooks'
export const NOTEBOOK_RUN_FILE = 'run.json'
// Execution authorization canonicalizes omitted control/shell deadlines to the same defaults used
// by the MCP schema and process owner. These are runtime constants, not persisted schema fields.
export const NOTEBOOK_REPL_DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000 + 15_000
export const NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS = 120_000

// Identifies whether a run was initiated by the agent or by the user terminal.
export type NotebookRunSource = 'agent' | 'user'

// Exact app-local dispatch methods corresponding to the three approval-gated Notebook MCP tools.
export type NotebookExecutionRpcMethod = 'execute' | 'executeControl' | 'executeShell'

export type RequestNotebookNetworkAccessRequest = NotebookSessionRequest & {
  hostname: string
  reason: string
  runtime?: 'python' | 'r' | 'repl' | 'bash'
  command?: string
}

export type RequestNotebookNetworkAccessResult = Readonly<{
  hostname: string
  status: 'alreadyAllowed' | 'allowedOnce' | 'alwaysAllowed' | 'denied' | 'blocked' | 'unavailable'
}>

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
  originMessageId?: string
}

// Languages a notebook kernel can run in this phase; each runs as a persistent exec-loop process
// (no ipykernel/IRkernel involved). Renderer IPC must parse this at runtime — TypeScript unions
// do not reject a compromised or stale client.
export const NOTEBOOK_LANGUAGES = ['python', 'r'] as const
export type NotebookLanguage = (typeof NOTEBOOK_LANGUAGES)[number]
export const notebookLanguageSchema = z.enum(NOTEBOOK_LANGUAGES)

export const parseNotebookLanguage = (value: unknown): NotebookLanguage => {
  const parsed = notebookLanguageSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Notebook language must be python or r.')
  }
  return parsed.data
}

export const parseOptionalNotebookLanguage = (value: unknown): NotebookLanguage | undefined => {
  if (value == null) return undefined
  return parseNotebookLanguage(value)
}

// JSON RPC encodes omitted optional slots as null. Drop trailing nulls so cancel() and
// provision/repair without an operation id stay valid, while a null required language still fails.
const omitTrailingNull = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value
  const args = [...value]
  while (args.length > 0 && args[args.length - 1] === null) args.pop()
  return args
}

const parsedArgs = <Args extends readonly unknown[]>(schema: z.ZodType<Args>): RuntimeCodec<Args> =>
  Object.freeze({
    parse: (value: unknown): Args => schema.parse(omitTrailingNull(value))
  })

const languageAndOptionalOperationId = parsedArgs(
  z.union([z.tuple([notebookLanguageSchema]), z.tuple([notebookLanguageSchema, z.string()])])
)

const repairArgs = parsedArgs(
  z.union([
    z.tuple([notebookLanguageSchema, z.string().min(1)]),
    z.tuple([notebookLanguageSchema, z.string().min(1), z.string()])
  ])
)

export const notebookEnvironmentApplicationCommandContracts = Object.freeze({
  provision: defineApplicationCommandContract(
    languageAndOptionalOperationId,
    validationCodec(z.undefined())
  ),
  repair: defineApplicationCommandContract(repairArgs, validationCodec(z.undefined())),
  cancel: defineApplicationCommandContract(
    parsedArgs(z.union([z.tuple([]), z.tuple([notebookLanguageSchema])])),
    validationCodec(z.undefined())
  )
})

// Identifies which kernel produced a run: python/r are analysis cells, repl/bash are
// control-plane/shell.
export type NotebookKernelKind = 'python' | 'r' | 'repl' | 'bash'

export type NotebookPackageSource =
  | {
      type: 'github'
      repository: string
      ref?: string
      commit?: string
    }
  | {
      type: 'bioconductor'
      version?: string
    }

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
  source?: NotebookPackageSource
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
  | 'github'
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
  source?: NotebookPackageSource
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

export type NotebookEnvironmentOperationLogTruncation = {
  omittedCount: number
  earliestRetainedAt?: string
}

export const isNotebookEnvironmentOperationLogTruncation = (
  value: unknown
): value is NotebookEnvironmentOperationLogTruncation => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Number.isInteger(candidate.omittedCount) &&
    Number(candidate.omittedCount) > 0 &&
    (candidate.earliestRetainedAt === undefined || typeof candidate.earliestRetainedAt === 'string')
  )
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
  platform?: string
  architecture?: string
  inventorySources: Array<'kernel-native' | 'interpreter-native' | 'operation-log'>
  packages: NotebookEnvironmentPackage[]
  operationLog?: NotebookEnvironmentOperation[]
  operationLogTruncation?: NotebookEnvironmentOperationLogTruncation
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

// Transient model-facing projection of one exact Notebook input Version. The relative path is
// materialized under the current Notebook data directory and is never persisted in run history.
export type NotebookPromptInput = Pick<
  NotebookRunInputFile,
  'sourceKind' | 'inputFileVersionId' | 'filename'
> & {
  notebookPath: string
}

export type NotebookInputPreviewIdentity = {
  projectId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  sourceFileId: string
  inputFileVersionId: string
}

const NOTEBOOK_INPUT_PREVIEW_PREFIX = 'notebook-input:'

export const createNotebookInputPreviewKey = (identity: NotebookInputPreviewIdentity): string =>
  `${NOTEBOOK_INPUT_PREVIEW_PREFIX}${encodeURIComponent(
    JSON.stringify([
      identity.projectId,
      identity.sourceKind,
      identity.sourceFileId,
      identity.inputFileVersionId
    ])
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
    parsed.length !== 4 ||
    parsed.some((value) => typeof value !== 'string') ||
    (parsed[1] !== 'upload-version' && parsed[1] !== 'artifact-version')
  ) {
    throw new Error('Invalid Notebook input preview key.')
  }
  return {
    projectId: parsed[0] as string,
    sourceKind: parsed[1],
    sourceFileId: parsed[2] as string,
    inputFileVersionId: parsed[3] as string
  }
}

// Observation reports unclassified changes under data/ and handoff/, not scientific file roles.
// Historical JSON is read permissively; this contract describes current runtime output.
export type NotebookWorkingFileKind = 'other'

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
  // Optional immutable generation evidence. Historical working-file entries predate this capture.
  generationId?: string
  checksum?: string
  change?: 'created' | 'modified'
}

// Captures the interpreter metadata persisted alongside run history.
// 'idle' is the resting state between runs; 'running' is written around a live cell/control run;
// 'restarting' covers the window of a restart() in progress; 'terminated' marks a proc dropped for
// being idle or lost to a crash/hard-timeout (see NotebookKernelExecutor). 'shutdown' remains the
// explicit user/app-initiated teardown. 'starting' and 'error' are reserved: proc spawn is transient
// and internal to the executor, and a kernel-level failure currently surfaces as a run-level 'failed'
// status rather than a distinct kernel state.
export type NotebookKernelMetadata = {
  pythonPath?: string
  kernelName: string
  runtimeRoot: string
  lastKnownStatus:
    'idle' | 'starting' | 'running' | 'error' | 'shutdown' | 'restarting' | 'terminated'
  // Exact persistent kernel instances known to have terminated while the app was alive. Optional
  // keeps existing run.json documents readable; an old coarse `terminated` without this field has
  // unknown ownership and is cleared only by an explicit restart.
  terminatedKernelInstances?: NotebookKernelInstanceIdentity[]
}

// Durable identity of one persistent notebook kernel. This deliberately stores domain fields rather
// than the executor's `${kind}:${environment}` routing string or an unstable operating-system PID.
export type NotebookKernelInstanceIdentity =
  { kind: 'python' | 'r'; environment: string } | { kind: 'repl' }

// Immutable source evidence for one registered helper generation loaded into a Python kernel.
// The host computes sourceDigest from the exact UTF-8 source stored here; callers never supply it.
export type NotebookHelperModuleEvidence = {
  helperId: string
  skillIdentity: string
  packageOrigin: string
  interfaceRevision: string
  registeredGeneration: string
  exports: string[]
  dependencies?: string[]
  source: string
  sourceDigest: string
}

export type NotebookHelperEvidenceStatus =
  | { state: 'complete' }
  | {
      state: 'incomplete'
      reasons: Array<'source-missing' | 'source-corrupt' | 'payload-limit'>
    }

// Stores one durable notebook execution, including code, output, and generated-file references.
export type NotebookRunRecord = {
  runId: string
  // App-owned one-shot identity joining an authorized ACP tool call to the execution admitted by
  // the authenticated Notebook RPC bridge. Optional keeps existing run.json documents readable.
  executionInvocationId?: string
  // Identifies one live persistent-kernel generation. A new value is allocated after process/app
  // restart; optional keeps legacy run.json documents readable without a migration.
  kernelEpochId?: string
  // Whether this run's source was handed to the persistent data kernel. Pre-dispatch failures set
  // false so dependency projection never invents mutations; absent legacy evidence stays conservative.
  kernelDispatched?: boolean
  // Sticky for the kernel epoch: every later Python run retains the complete loaded-helper set,
  // even when that cell omitted helperModules.
  helperModules?: NotebookHelperModuleEvidence[]
  helperEvidenceStatus?: NotebookHelperEvidenceStatus
  // Stable identity of the external runtime used by this run. Managed runs are reproducible from
  // their environment; external runs need this identity to rebuild a missing derived sidecar.
  runtimeId?: string
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
  // Retained only for reading/exporting historical run.json documents. New native Artifact
  // relationships are recorded by ArtifactVersion provenance and omit this field.
  artifacts?: ArtifactFile[]
  workingFiles: NotebookWorkingFile[]
  // Immutable file-generation evidence is stored in a checksummed per-run sidecar. Optional keeps
  // historical run.json documents readable without fabricating capture coverage.
  fileEvidence?: ExecutionFileEvidenceSummary
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
  // records may omit it. An Artifact producer must share root/agent identity, belong to the trusted
  // Branch and message ancestry, and match the active Runtime Segment for the active prompt.
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  runtimeSegmentId?: string
  promptMessageId?: string
  // Why a run ended non-normally. 'app-terminated' is startup reconciliation after process death;
  // 'execution-error' is an unexpected execution-infrastructure rejection in the live process.
  // Optional keeps existing run.json documents readable without a migration.
  interruptionReason?: 'app-terminated' | 'execution-error'
}

// Orthogonal to NotebookRunStatus: a completed run may later become stale when a name it depended
// on is redefined in the same persistent-kernel generation.
export type NotebookRunStaleness =
  | { state: 'clear' }
  | { state: 'stale'; causedByRunId: string; names: string[]; path: string[] }
  | { state: 'unknown'; reasons: string[] }

type NotebookAffectedRun = {
  runId: string
  cellId: string
  names: string[]
}

export type NotebookInvalidatedRun =
  | (NotebookAffectedRun & { state: 'stale' })
  | (NotebookAffectedRun & { state: 'unknown'; reasons: string[] })

// The complete JSON document persisted at each notebook session's run.json path.
export type NotebookRunDocument = ProjectIdScope & {
  version: 1
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
  status:
    | 'idle'
    | 'receiving-code'
    | 'running'
    | 'completed'
    | 'failed'
    | 'timeout'
    | 'interrupted'
    | 'cancelled'
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
// Live statuses remain in-memory; exact terminated instances are also restored from run.json so a
// relaunch can identify which environment needs recovery without persisting the full live-status map.
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

// Bounded, non-persisted discovery metadata for one Agent's complete durable history. The renderer
// requests one summary at a time so old kernel kinds remain exportable without widening `runs`.
export type NotebookRunHistorySummary = {
  agentFrameId: string
  runCount: number
  kernelCounts: Record<NotebookKernelKind, number>
  latestDataKernel?: 'python' | 'r'
}

// Stable chronological cursor for renderer history pagination. runId disambiguates runs that share
// the same millisecond timestamp across Notebook lanes.
export type NotebookRunCursor = {
  startedAt: number
  runId: string
}

export type NotebookRunPage = {
  hasEarlierRuns: boolean
  oldestCursor?: NotebookRunCursor
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
  // Total durable run count across lanes. `runs` is a bounded recent window for renderer safety.
  runCount: number
  // Latest durable environment evidence per data kernel, independent of the bounded run window.
  latestRunEnvironments: Partial<Record<'python' | 'r', string>>
  // Live execution target derived from each language's Session runtime binding. This is not
  // persisted; optional keeps older renderer/remote clients compatible.
  executionEnvironments?: Partial<Record<'python' | 'r', string>>
  // Current per-language runtime bindings returned by state(); optional keeps older renderer and
  // remote clients compatible. The binding itself is already persisted on NotebookRunDocument.
  runtimeBindings?: NotebookRuntimeBindings
  // Present only when state() requested one Agent's complete-history discovery metadata.
  historySummary?: NotebookRunHistorySummary
  // Present on normal and cursor-paged renderer reads; omitted for sparse run-id/summary requests.
  historyPage?: NotebookRunPage
  runs: NotebookRunRecord[]
  recentRuns: NotebookRunRecord[]
  // Derived from run history and the rebuildable dependency-analysis sidecar; never written into
  // run.json. Optional keeps older renderer/remote clients compatible.
  runStaleness?: Record<string, NotebookRunStaleness>
  // Live per-(kind, env) kernel status view (design D6); empty until the session spawns a kernel.
  environments: NotebookEnvironmentStatus[]
}

// Lightweight session handle used by events and preview tabs to reopen the notebook.
export type NotebookSessionReference = ProjectIdScope & {
  sessionId: string
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
  staleness?: NotebookRunStaleness
  invalidatedRuns?: NotebookInvalidatedRun[]
}

// Common routing fields required by every notebook command.
export type NotebookSessionRequest = OptionalProjectIdScope & {
  sessionId: string
  workspaceCwd: string
  provenanceContext?: NotebookRunProvenanceContext
  // Injected only by the authenticated local RPC bridge. Public/renderer adapters strip it.
  executionInvocationId?: string
  // Injected only by the authenticated local RPC bridge after resolving the active turn registry.
  // Renderer IPC strips this field before calling the runtime service.
  registeredInputFiles?: NotebookRunInputFile[]
  // Injected only by the authenticated local RPC bridge for a Specialist-bound session. Renderer
  // IPC strips this field together with executionInvocationId; it is never caller authority.
  registeredHelperSkillIds?: string[]
  // Identifies the exact active input lease for this execution. The bridge generates it and the
  // kernel returns it when resolving an immutable input so overlapping runs cannot claim access.
  inputRunLeaseId?: string
}

// Restarts either every kernel in the Session (target omitted, preserving the historical behavior)
// or one exact data-kernel target. Runtime boundaries reject half-specified targets.
export type NotebookRestartRequest =
  | (NotebookSessionRequest & { language: NotebookLanguage; environment: string })
  | (NotebookSessionRequest & { language?: never; environment?: never })

// A normal state read returns the latest renderer window. Transcript hydration may additionally
// request immutable historical Runs by id without changing or widening that default window.
export const NOTEBOOK_STATE_TARGET_RUN_LIMIT = 20
export const NOTEBOOK_STATE_HISTORY_FRAME_ID_LIMIT_BYTES = 1_024
export const NOTEBOOK_STATE_HISTORY_PAGE_LIMIT = 100
export const NOTEBOOK_STATE_HISTORY_CURSOR_RUN_ID_LIMIT = 1_024

export const isNotebookRunCursor = (value: unknown): value is NotebookRunCursor => {
  if (!value || typeof value !== 'object') return false
  const cursor = value as Partial<NotebookRunCursor>
  return (
    Number.isFinite(cursor.startedAt) &&
    typeof cursor.runId === 'string' &&
    cursor.runId.length > 0 &&
    cursor.runId.length <= NOTEBOOK_STATE_HISTORY_CURSOR_RUN_ID_LIMIT
  )
}

export type NotebookSessionStateRequest = NotebookSessionRequest & {
  runIds?: string[]
  historySummaryFrameId?: string
  historyBefore?: NotebookRunCursor
  historyLimit?: number
}

// Read-only, process-local view of the selected live data-kernel namespace. These values are never
// persisted: a kernel restart destroys both the interpreter objects and the snapshot identity.
export type NotebookNamespaceRequest = NotebookSessionRequest & {
  language: NotebookLanguage
  environment: string
  includePrivate?: boolean
}

export type NotebookNamespaceVariable = {
  name: string
  type: string
  sizeBytes?: number
  shape?: string
  preview: string
  previewTruncated?: boolean
  private?: boolean
}

export type NotebookNamespaceSnapshot =
  | {
      status: 'available'
      language: NotebookLanguage
      environment: string
      kernelEpochId: string
      variableCount: number
      variablesTruncated: boolean
      variables: NotebookNamespaceVariable[]
    }
  | {
      status: 'unavailable'
      reason: 'kernel-not-live' | 'kernel-restarted'
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
  // Undefined exports the All projection; null selects legacy Runs without Frame attribution.
  agentFrameFilter?: string | null
}

// "Download all" path: every data kernel that actually has runs gets its own .ipynb in a directory
// the user picks, with control-plane runs grouped under the data kernel that was active at the time.
export type ExportNotebookAllRequest = NotebookSessionRequest & {
  agentFrameFilter?: string | null
}

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

// Cancels exactly one active write and discards its unfinished code.
export type AbortNotebookCodeCellRequest = FinishNotebookCodeCellRequest

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
  // Stable IDs resolved by the host-owned registered Skill catalog. Callers cannot provide helper
  // implementation paths, source, or digests.
  helperModules?: string[]
  // Immutable Artifact Versions produced or selected during the current control-plane workflow.
  // The main process resolves and validates these identities before dispatch, then records them as
  // inputs of this Run. This is intentionally identities-only: callers cannot supply paths or
  // provenance metadata.
  artifactVersionInputs?: string[]
  timeoutMs?: number
  cellId?: string
  source?: NotebookRunSource
  inputKind?: NotebookRunInputKind
  language?: NotebookLanguage
  // Named env to execute in; omitted -> the default env for language.
  environment?: string
}

// Runs code on the control-plane REPL kernel (JS; the only kernel with host.mcp connector access).
// Distinct from data cells: durable Run history uses kernelKind "repl", with no NotebookLanguage.
export type ExecuteNotebookControlRequest = NotebookSessionRequest & {
  code: string
  timeoutMs?: number
}

// Runs one shell command in a fresh, stateless process in the session workspace. It has no
// persistent process or NotebookLanguage, but each invocation is persisted as a "bash" Run.
export type ExecuteShellRequest = NotebookSessionRequest & {
  command: string
  timeoutMs?: number
}
