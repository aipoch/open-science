export type NotebookNetworkPolicy = Readonly<{
  allowedDomains: readonly string[]
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
  readWriteRoots: readonly string[]
  deniedReadRoots: readonly string[]
  deniedWriteRoots: readonly string[]
}>

export type NotebookNetworkAccessRequest = Readonly<{
  host: string
  port?: number
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
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  shell?: string | Readonly<{ kind: 'powershell' | 'cmd'; path: string }>
  signal?: AbortSignal
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  filesystem?: NotebookFilesystemPolicy
  onNetworkAccessRequest: NotebookNetworkDecisionHandler
}>

export type NotebookSandboxedProcess = Readonly<{
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  annotateStderr: (stderr: string) => string
  resetNetworkConnections: () => void
  cleanup: () => void
}>

export type NotebookNetworkSandboxOptions = Readonly<{
  policy: NotebookNetworkPolicy
  resources: NotebookSandboxResources
  parentProxy?: NotebookNetworkParentProxy
  trustBundle?: NotebookTrustBundle
}>
