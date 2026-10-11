export type NotebookLanguage = 'python' | 'r'

export type NotebookPackageSource =
  | {
      type: 'github'
      repository: string
      ref?: string
      commit?: string
      subdirectory?: string
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

export type NotebookEnvironmentManifest<ExecutionContext = unknown> = {
  executionContext?: ExecutionContext
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

export type NotebookEnvironmentLockPartialReason =
  | 'external-interpreter-required'
  | 'environment-manifest-partial'
  | 'non-conda-package-detected'
  | 'non-conda-installer-detected'
  | 'native-lock-file-best-effort'
  | 'native-lock-file-rejected'

export type NotebookEnvironmentLockDiagnostic = {
  reason:
    | 'package-lock-missing'
    | 'package-version-unresolved'
    | 'package-version-mismatch'
    | 'package-not-captured'
    | 'source-unpinned'
    | 'source-mismatch'
    | 'project-selection-unresolved'
  packageName?: string
  observedVersion?: string
  lockedVersion?: string
}

export type NotebookEnvironmentLockFile = {
  path: string
  checksum: string
  content: string
}

export type NotebookEnvironmentLockComponent =
  | {
      ecosystem: 'conda'
      format: 'conda-explicit-md5'
      resolution: 'locked'
      explicitLock: string
      packages: string[]
    }
  | {
      ecosystem: 'python'
      format: 'uv-lock' | 'poetry-lock' | 'pip-requirements'
      resolution: 'locked' | 'best-effort'
      files: NotebookEnvironmentLockFile[]
    }
  | {
      ecosystem: 'r'
      format: 'renv-lock' | 'pak-lock'
      resolution: 'locked'
      files: NotebookEnvironmentLockFile[]
    }

export type NotebookEnvironmentLock = {
  schemaVersion: 1 | 2
  // v2 native-only locks restore packages conditionally; they do not provision this runtime.
  externalRuntime?: { version: string; installerVersion: string }
  format: 'environment-lock-bundle'
  kernelKind: NotebookLanguage
  environmentName: string
  platform?: string
  architecture?: string
  components: NotebookEnvironmentLockComponent[]
  untrackedPackages?: string[]
  // Native distributions observed as unused by this run; retained in the full inventory.
  omittedPackages?: string[]
  nonCondaInstallers?: NotebookPackageInstaller[]
}

export type NotebookRunEnvironmentLockCapture =
  | {
      state: 'available' | 'partial'
      format: NotebookEnvironmentLock['format']
      lockChecksum: string
      partialReasons?: NotebookEnvironmentLockPartialReason[]
      diagnostics?: NotebookEnvironmentLockDiagnostic[]
    }
  | {
      state: 'unavailable'
      reason:
        | 'environment-not-managed'
        | 'conda-prefix-unavailable'
        | 'micromamba-unavailable'
        | 'environment-lock-capture-failed'
        | 'environment-lock-invalid'
        | 'environment-lock-publication-failed'
    }

export type NotebookLiveEnvironmentOverlay<ExecutionContext = unknown> = {
  executionContext?: ExecutionContext
  runtimeVersion?: string
  packages: NotebookEnvironmentPackage[]
  warnings?: string[]
}

// v4 environment discovery (Settings cards). Where an interpreter came from — also gates the agent
// remove-guard: only 'agent-created' envs may be removed by the agent.
export type EnvProvenance = 'app-managed' | 'user-own' | 'agent-created'

// One detected interpreter. `envId` (its real path) is the stable identity used to persist the
// per-env enabled/disabled choice across re-detection.
export type DiscoveredInterpreter = {
  language: NotebookLanguage
  provenance: EnvProvenance
  envId: string
  interpreterPath: string
  label: string
  version?: string
  runnable: boolean
  condaEnv?: string
  detail?: string
  // Advisory discovery only; never persisted as consent. Missing means detection was unavailable.
  personalRLibraries?: string[]
}

export type ProvisionScope = 'python' | 'r'
export type ProvisionOperationScope = ProvisionScope | 'upgrade'

export type ProvisionPhase =
  | 'upgrade'
  | 'upgrade-r'
  | 'restore'
  | 'fetch-python'
  | 'fetch-r'
  | 'create-python'
  | 'create-r'
  | 'verify-python'
  | 'verify-r'
  | 'python-ready'
  | 'r-ready'
  | 'done'
  | 'error'

// User-facing progress is a closed renderer-localized event. Unstructured failure details travel in
// `diagnostic` instead, so machine diagnostics can never masquerade as translated product copy.
export type ProvisionProgressEvent =
  | { code: 'legacy-package-removed' }
  | { code: 'environment-create'; environment: string }
  | { code: 'python-ready' }
  | { code: 'r-ready' }
  | { code: 'updating-default-packages' }
  | { code: 'updating-r-packages' }
  | { code: 'default-environments-updated' }
  | { code: 'restoring-environment'; environment: string }
  | { code: 'runtime-restored' }
  | { code: 'environment-ready'; environment: string }
  | { code: 'preparing-packages'; environment: string }
  | { code: 'retrying-short-cache'; environment: string }
  | { code: 'repairing-windows-crash'; environment: string }
  | { code: 'repairing-package-cache'; environment: string }
  | { code: 'verifying-interpreter'; environment: string }
  | { code: 'verifying-packages'; completed: number; total: number }
  | { code: 'fetching-runtime-manifest' }
  | { code: 'downloading-python-runtime' }
  | { code: 'downloading-r-runtime' }
  | { code: 'runtime-downloaded'; file: string }
  | { code: 'runtime-pack-unavailable' }

type ProvisionProgressBase = {
  progress: number
  // Correlates renderer-requested provision/repair progress with the originating IPC call. Automatic
  // maintenance omits it so its terminal event cannot accidentally settle a queued explicit request.
  operationId?: string
  // Explicit at process boundaries so an automatic R provision is not inferred as a global upgrade.
  scope?: ProvisionOperationScope
  // Present for a provision triggered by one notebook run; other sessions remain visible and usable.
  sessionId?: string
  // `language` attributes an event to the env it concerns so the Settings UI can show python and R
  // provisioning independently — the provisioner serializes the two runs, but neither card should look
  // cancelled when the other is requested (undefined for language-agnostic events: upgrade/restore).
  language?: NotebookLanguage
  // Present during the pack-download phase so the UI can show speed/ETA/resume detail alongside the
  // coarse `progress` fraction.
  download?: DownloadProgress
}

export type ProvisionProgress =
  | (ProvisionProgressBase & {
      phase: Exclude<ProvisionPhase, 'error'>
      event: ProvisionProgressEvent
      diagnostic?: string
    })
  | (ProvisionProgressBase & {
      phase: 'error'
      diagnostic: string
      event?: never
    })

export const isTerminalProvisionPhase = (phase: ProvisionPhase): boolean => {
  switch (phase) {
    case 'done':
    case 'error':
      return true
    case 'upgrade':
    case 'upgrade-r':
    case 'restore':
    case 'fetch-python':
    case 'fetch-r':
    case 'create-python':
    case 'create-r':
    case 'verify-python':
    case 'verify-r':
    case 'python-ready':
    case 'r-ready':
      return false
    default:
      return phase satisfies never
  }
}

export type RuntimeBundleSource = {
  kind: 'official' | 'override'
  baseUrl: string
}
export type NotebookRecoveryStatus = {
  checkedAt?: number
  corruptJournal: boolean
  operations: Array<{
    operationId: string
    runtimeId: string
    targetPath?: string
    reason: 'child-unconfirmed' | 'child-unrecorded' | 'archive-unconfirmed' | 'recovery-failed'
  }>
}

export type ProvisionStatus = {
  recovery?: NotebookRecoveryStatus
  pythonReady: boolean
  rReady: boolean
  version: number
  provisioning: boolean
  bundleSource?: RuntimeBundleSource
  // True when recovery quarantined the language's app-managed default prefix, or an explicit repair
  // left its durable marker armed after failing. The env may still read as ready or may be absent, so
  // the UI needs this signal to surface Reset instead of a healthy card or an ordinary setup retry.
  pythonRepairRequired?: boolean
  rRepairRequired?: boolean
  pythonRecoveryBlocked?: boolean
  rRecoveryBlocked?: boolean
}

// One named environment as surfaced by manage_environments(action:"list") and the UI's env selector.
export type EnvironmentInfo = {
  name: string
  language: NotebookLanguage
  ready: boolean
  isDefault: boolean
  sizeBytes?: number
}

export type DownloadPhase = 'downloading' | 'reconnecting'

export type DownloadProgress = {
  phase: DownloadPhase
  transferred: number
  total?: number
  percent?: number
  bytesPerSecond: number
  etaSeconds?: number
  attempt: number
}

// The ONE mapping from who owns an env to which tool reads/writes its packages (the `via` in
// package-operation policy): app-owned conda envs (managed OR agent-created, both under the app
// runtime root) go through the bundled micromamba; the user's own envs are handled by their own
// interpreter's pip (Python) or their own R library (R) — never the bundled micromamba against a
// foreign env. Shared by package writes and the Settings package listing so they cannot drift.
export const packageToolFor = (
  language: NotebookLanguage,
  appOwned: boolean
): 'micromamba' | 'pip' | 'r-library' =>
  appOwned ? 'micromamba' : language === 'r' ? 'r-library' : 'pip'

// One installed package in a discovered environment, surfaced by the Settings "Packages" dialog.
// `build`/`channel` are present only for conda-tracked entries (a micromamba listing); pip and CRAN
// listings carry name + version only.
export type EnvPackage = {
  name: string
  version: string
  build?: string
  channel?: string
}
