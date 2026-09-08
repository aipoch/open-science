export type WslSetupState =
  | 'checking'
  | 'not-installed'
  | 'restart-required'
  | 'distro-required'
  | 'first-launch-required'
  | 'dependency-required'
  | 'ready'
  | 'failed'

export type WslDistro = Readonly<{
  name: string
  version: 1 | 2
  release?: string
  defaultUser?: string
  defaultUserIsRoot?: boolean
  isDefault: boolean
}>

export type WslSelection = Readonly<{
  distro: string
  user: string
}>

export type LocalShellRuntimePreference = 'powershell' | 'wsl2-bash'

export type Wsl2BashPreviewStatus = Readonly<{
  available: boolean
  development?: true
  reason:
    | 'available'
    | 'build-disabled'
    | 'unsupported-platform'
    | 'unsupported-architecture'
    | 'unpackaged-build'
    | 'assets-unavailable'
    | 'not-initialized'
}>

export type SwitchToPowerShellResult = Readonly<{
  runtimeBinding: Readonly<{ kind: 'powershell'; version: '5.1' }>
  appliesTo: 'subsequent-executions'
  wslProfilePreserved: boolean
}>

export type UseWsl2BashResult = Readonly<{
  runtime: 'wsl2-bash'
  selection: WslSelection
  appliesTo: 'subsequent-executions'
}>

export type WslReadiness = Readonly<{
  wsl2?: boolean
  home?: boolean
  bash?: boolean
  bwrap?: boolean
  python3?: boolean
  mirroredNetworking?: boolean
  namespaces?: boolean
  localWorkspace?: boolean
}>

export type WslDiagnosticCheckState = 'pass' | 'fail' | 'not-checked' | 'not-applicable'

export type WslDiagnosticCheck = Readonly<{
  state: WslDiagnosticCheckState
  version?: string
  path?: string
}>

export type WslSetupFailureStage =
  | 'platform'
  | 'distribution'
  | 'identity'
  | 'dependencies'
  | 'networking'
  | 'namespaces'
  | 'workspace'
  | 'installation'
  | 'recovery'

export type WslSetupFailure = Readonly<{
  stage: WslSetupFailureStage
  code: string
  exitCode?: number
  timedOut?: boolean
  cancelled?: boolean
  stdout?: string
  stderr?: string
}>

export type WslSetupSnapshot = Readonly<{
  state: WslSetupState
  distros: readonly WslDistro[]
  activeRuntime?: LocalShellRuntimePreference
  activatedSelection?: WslSelection
  selection?: WslSelection
  readiness?: WslReadiness
  errorCode?: string
  failure?: WslSetupFailure
  suggestedCommand?: string
  operationReference: string
}>

export type WslPlatformInstallOutcome =
  'uac-cancelled' | 'spawn-failed' | 'restart-required' | 'completed' | 'unknown'

export const WSL_PLATFORM_OWNERSHIP = 'user-and-os-managed' as const

export type WslExternalComponentOwnership = typeof WSL_PLATFORM_OWNERSHIP

export type WslPlatformInstallResult = Readonly<{
  outcome: WslPlatformInstallOutcome
  ownership: WslExternalComponentOwnership
  operationReference: string
  snapshot: WslSetupSnapshot
}>

export type WslSetupOperationKind = 'install-platform' | 'install-recommended-distro'

export type WslSetupOperationOutcome =
  'completed' | 'restart-required' | 'cancelled' | 'failed' | 'interrupted' | 'blocked'

export type WslSetupOperation =
  | Readonly<{ state: 'idle' }>
  | Readonly<{
      state: 'running'
      kind: WslSetupOperationKind
      phase: 'installing' | 'verifying'
      operationReference: string
      startedAt: number
    }>
  | Readonly<{
      state: 'finished'
      kind: WslSetupOperationKind
      outcome: WslSetupOperationOutcome
      operationReference: string
      startedAt: number
      finishedAt: number
    }>

export type WslSetupStatus = Readonly<{
  revision: number
  snapshot?: WslSetupSnapshot
  operation: WslSetupOperation
}>

export const WSL_SETUP_DIAGNOSTICS_SCHEMA_VERSION = 1 as const
export const WSL_SETUP_GUIDE_ID = 'wsl2-setup' as const
export const WSL_SETUP_GUIDE_VERSION = '1' as const

export type WslSetupGuide = Readonly<{
  id: typeof WSL_SETUP_GUIDE_ID
  version: typeof WSL_SETUP_GUIDE_VERSION
  status: 'available' | 'missing' | 'version-mismatch'
  markdown?: string
}>

export type WslSupportHandoff = Readonly<{
  schemaVersion: typeof WSL_SETUP_DIAGNOSTICS_SCHEMA_VERSION
  guide: WslSetupGuide
  capturedAt: string
  revision: number
  errorCode: string
  supportReference: string
  operationReference: string
  windows: Readonly<{
    version: string
    build: string
    architecture: string
    previewAvailable: boolean | 'unknown'
    previewReason: string
  }>
  wsl: Readonly<{
    softwareVersion: string
    linuxKernelVersion: string
    installState: WslSetupState
  }>
  distros: readonly WslDistro[]
  selectedTarget?: WslSelection
  activatedTarget?: WslSelection
  currentBackend: LocalShellRuntimePreference | 'unknown'
  checks: Readonly<{
    wsl2: WslDiagnosticCheck
    home: WslDiagnosticCheck
    bash: WslDiagnosticCheck
    bwrap: WslDiagnosticCheck
    python3: WslDiagnosticCheck
    mirroredNetworking: WslDiagnosticCheck
    namespaces: WslDiagnosticCheck
    localWorkspace: WslDiagnosticCheck
  }>
  failure?: WslSetupFailure
  operation: WslSetupOperation
  recovery: Readonly<{
    lastOperation?: WslSetupOperationKind
    restartRequired: boolean
    resultUnknown: boolean
    recheck: readonly string[]
  }>
  /** Compatibility summary for renderer versions that predate structured checks. */
  capabilities: WslReadiness
  /** Compatibility summary. `wsl` is a software version, never the distro WSL generation. */
  versions: Readonly<{
    wsl: string
    distribution: '1' | '2' | 'unknown'
  }>
  target: 'restore-wsl2-bash'
}>

export type WslSetupConversationBootstrap = Readonly<{
  handoff: WslSupportHandoff
  setupSessionToken: string
}>

export type SelectWslProfileRequest = Readonly<{
  distro: string
  user: string
}>

export type OpenWslTerminalRequest = Readonly<{
  distro: string
  user?: string
}>

export const RECOMMENDED_WSL_DISTRO = 'Ubuntu-22.04'
