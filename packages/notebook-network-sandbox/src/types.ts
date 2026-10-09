import type { TrustedPrivateDestination } from '../runtime/src/gateway/address-policy.js'
import type { NotebookLocalService } from '../runtime/src/platform/local-service.js'
export type { NotebookLocalService } from '../runtime/src/platform/local-service.js'
export type NotebookNetworkPolicy = Readonly<{
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  /** Overrides wildcard allows; an exact allow still represents explicit approval. */
  askDomains?: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons?: Readonly<Record<string, string>>
}>

export type NotebookNetworkParentProxy = Readonly<{
  http?: string
  https?: string
  noProxy?: string
}>

export type NotebookTrustBundle = Readonly<{
  path: string
  certificates: readonly string[]
}>

export type NotebookFilesystemPolicy = Readonly<{
  privateRoot?: string
  readOnlyRoots: readonly string[]
  /** Incidental Windows PATH directories; inability to grant them must not block the workload. */
  optionalReadOnlyRoots?: readonly string[]
  readWriteRoots: readonly string[]
  deniedReadRoots: readonly string[]
  deniedWriteRoots: readonly string[]
}>

export type NotebookSandboxTarget =
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'wsl2'
      profileId: string
      distro: string
      user: string
    }>

export type NotebookSandboxCleanupReason = 'exit' | 'cancel' | 'timeout' | 'spawn-failed'

export type NotebookSandboxProcessState =
  'never-started' | 'started-and-reaped' | 'termination-unknown'

export type NotebookSandboxCleanupResult = Readonly<{
  processesTerminated: boolean
  processState?: NotebookSandboxProcessState
  networkClosed: boolean
  temporaryResourcesRemoved: boolean
  /** Omitted means blocked; never substitutes for complete process cleanup. */
  admission?: 'blocked' | 'independent-command-allowed'
}>

export type NotebookSandboxProcessOutcome = Readonly<{
  processesTerminated: boolean
  /** Explicit child lifecycle evidence; older callers may rely on the boolean projection. */
  processState?: NotebookSandboxProcessState
  /** Retained by the command owner; rechecks the same owned tree, never a replacement PID. */
  confirmTermination?: () => Promise<boolean>
}>

export type NotebookNetworkAccessRequest = Readonly<{
  host: string
  port?: number
  purpose?: 'probe' | 'block'
  signal: AbortSignal
}>

export type NotebookNetworkDecisionHandler = (
  request: NotebookNetworkAccessRequest
) => Promise<boolean>

export type NotebookSandboxResources = Readonly<{
  root: string
}>

export type NotebookNetworkSandboxStatus =
  | Readonly<{ kind: 'ready'; warnings: readonly string[] }>
  | Readonly<{ kind: 'setupRequired'; platform: 'linux' | 'win32'; reasons: readonly string[] }>
  | Readonly<{ kind: 'unsupported'; platform: NodeJS.Platform }>
  | Readonly<{ kind: 'error'; message: string }>

export type NotebookSandboxCommand = Readonly<{
  localService?: NotebookLocalService
  target?: NotebookSandboxTarget
  command: string
  // Protected Windows launches use the exact process argv so PowerShell never has to initialize the
  // AppContainer's working drive before the requested process can start.
  executable?: string
  args?: readonly string[]
  electronAsNode?: boolean
  cwd: string
  env?: NodeJS.ProcessEnv
  pathEnvironment?: NodeJS.ProcessEnv
  shell?: string | Readonly<{ kind: 'powershell' | 'cmd'; path: string }>
  signal?: AbortSignal
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  // Opt-in Job Object ownership for standard-mode Windows process trees that require verifiable
  // descendant cleanup.
  superviseProcessTree?: boolean
  windowsShellControlPipe?: string
  /** Transient R admission decision; launch must retain this protection requirement. */
  windowsProtectionRequired?: boolean
  /** A durable grant used for admission must still be authorized at launch. */
  windowsRuntimeAccessRequired?: boolean
  filesystem?: NotebookFilesystemPolicy
  onNetworkAccessRequest: NotebookNetworkDecisionHandler
}>

export type NotebookSandboxedProcess = Readonly<{
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  // Only launchers backed by a kill-on-close Job Object may provide this proof check.
  confirmProcessTreeTermination?: () => Promise<boolean>
  requestProcessTreeTermination?: () => Promise<boolean>
  confirmProcessState?: () => Promise<NotebookSandboxProcessState>
  beginSpawn?: () => Readonly<{ started: () => void; notStarted: () => void }>
  annotateStderr: (stderr: string, stdout?: string) => string
  setExecutionActive: (active: boolean) => void
  resetNetworkConnections: () => void
  cleanup: (
    reason: NotebookSandboxCleanupReason,
    processOutcome: NotebookSandboxProcessOutcome
  ) => Promise<NotebookSandboxCleanupResult>
}>

export type NotebookNetworkSandboxOptions = Readonly<{
  /** The application supplies its mode; standalone consumers default to production. */
  packaged?: boolean
  policy: NotebookNetworkPolicy
  resources: NotebookSandboxResources
  parentProxy?: NotebookNetworkParentProxy
  trustBundle?: NotebookTrustBundle
}>
