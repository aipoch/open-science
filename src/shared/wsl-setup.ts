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

export type WslSetupSnapshot = Readonly<{
  state: WslSetupState
  distros: readonly WslDistro[]
  activeRuntime?: LocalShellRuntimePreference
  activatedSelection?: WslSelection
  selection?: WslSelection
  readiness?: WslReadiness
  errorCode?: string
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

export type WslSupportHandoff = Readonly<{
  errorCode: string
  supportReference: string
  capabilities: WslReadiness
  versions: Readonly<{
    wsl: '2' | 'unknown'
    distribution: '1' | '2' | 'unknown'
  }>
  target: 'restore-wsl2-bash'
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
