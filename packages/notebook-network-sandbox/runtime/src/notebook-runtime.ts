import { NETWORK_APPROVAL_REQUIRED, NETWORK_POLICY_BLOCKED } from './gateway/recovery-context.js'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

import {
  createLocalCertificateAuthority,
  createClientTrustBundle,
  clientTrustEnvironment,
  type LocalCertificateAuthority
} from './gateway/local-ca.js'

import { DestinationPolicy } from './gateway/address-policy.js'
import {
  CommandGateway,
  type GatewayDecision,
  type ParentProxySettings
} from './gateway/command-gateway.js'
import { ViolationLog } from './gateway/violation-log.js'
import { checkLinuxTools, linuxLaunch } from './platform/linux-isolation.js'
import { macosLaunch } from './platform/macos-isolation.js'
import { wsl2Launch } from './platform/wsl2-isolation.js'
import {
  checkWindowsAppContainer,
  installWindowsAppContainer,
  setWindowsRuntimeAccess as setWindowsRuntimeAccessImpl,
  getWindowsRuntimeAccess as getWindowsRuntimeAccessImpl,
  readAppContainerStatus,
  removeWindowsAppContainer,
  windowsLaunch,
  windowsSupervisedLaunch,
  windowsStandardLaunch,
  type WindowsShell,
  type WindowsRuntimeVerification
} from './platform/windows-appcontainer.js'
import {
  hiddenByFilesystemLayout,
  normalizeFilesystemLayout,
  type FilesystemLayout,
  type FilesystemLayoutInput
} from './platform/filesystem-layout.js'

type SandboxDependencyCheck = Readonly<{ warnings: string[]; errors: string[] }>

type NetworkRuntimeConfig = Readonly<{
  allowedDomains: readonly string[]
  askDomains?: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons?: Readonly<Record<string, string>>
  parentProxy?: Readonly<{ http?: string; https?: string; noProxy?: string }>
  trustedCaCertificates?: readonly string[]
  installationId: string
  windowsHostPath: string
  windowsOwnershipRoot: string
}>

type NetworkAskCallback = (request: {
  host: string
  port: number
  commandId?: string
  purpose?: 'probe' | 'block'
}) => Promise<boolean>

type NotebookSandboxTarget =
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'wsl2'
      profileId: string
      distro: string
      user: string
    }>

type SandboxCleanupResult = Readonly<{
  processesTerminated: boolean
  networkClosed: boolean
  temporaryResourcesRemoved: boolean
}>

type SandboxProcessOutcome = Readonly<{
  processesTerminated: boolean
}>

type SandboxCleanupReason = 'exit' | 'cancel' | 'timeout' | 'spawn-failed'

const cleanupComplete = (result: SandboxCleanupResult): boolean =>
  result.processesTerminated && result.networkClosed && result.temporaryResourcesRemoved

type NetworkWrapRequest = Readonly<{
  target?: NotebookSandboxTarget
  command: string
  executable?: string
  args?: readonly string[]
  commandId: string
  shell?: string | WindowsShell
  cwd: string
  env: NodeJS.ProcessEnv
  pathEnvironment?: NodeJS.ProcessEnv
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  superviseProcessTree?: boolean
  filesystem: FilesystemLayoutInput
  signal?: AbortSignal
}>

type RuntimeContext = {
  filesystem: FilesystemLayout
  gateway?: CommandGateway
  releasePlatform?: (reason: SandboxCleanupReason) => Promise<boolean | void | SandboxCleanupResult>
  platformOwnsProcesses?: boolean
  executionActive: boolean
  epoch: number
  certificateAuthority?: LocalCertificateAuthority
  trustBundle?: Awaited<ReturnType<typeof createClientTrustBundle>>
}

let runtimeConfig: NetworkRuntimeConfig | undefined
let approval: NetworkAskCallback | undefined
let destinationPolicy: DestinationPolicy | undefined
let windowsProtectedGatewayPort: number | undefined
const commandContexts = new Map<string, RuntimeContext>()
const finishing = new Set<Promise<unknown>>()
const violations = new ViolationLog()

const parentSettings = (config: NetworkRuntimeConfig): ParentProxySettings | undefined => {
  if (!config.parentProxy && !config.trustedCaCertificates?.length) return undefined
  return {
    ...config.parentProxy,
    ...(config.trustedCaCertificates?.length
      ? {
          get trustedCaCertificates() {
            return runtimeConfig?.trustedCaCertificates
          }
        }
      : {})
  }
}

const buildPolicy = (config: NetworkRuntimeConfig): DestinationPolicy =>
  new DestinationPolicy({
    allowedDomains: config.allowedDomains,
    askDomains: config.askDomains,
    deniedDomains: config.deniedDomains,
    ...(config.deniedDomainReasons ? { deniedDomainReasons: config.deniedDomainReasons } : {})
  })

const decide = async (
  commandId: string,
  host: string,
  port: number,
  purpose: 'probe' | 'block' = 'block'
): Promise<GatewayDecision> => {
  const context = commandContexts.get(commandId)
  const epoch = context?.epoch
  const current = (): boolean =>
    commandContexts.get(commandId) === context && context?.epoch === epoch
  const expired: GatewayDecision = {
    allowed: false,
    message:
      'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED: Execution context expired. Start a new Notebook execution if still needed; domain approval cannot revive a stale connection.'
  }
  const policy = destinationPolicy
  if (!policy) {
    violations.record(commandId, `deny network-outbound ${host}:${port} (policy unavailable)`)
    return { allowed: false, message: NETWORK_POLICY_BLOCKED }
  }
  const verdict = await policy.inspect(host, port)
  if (!current()) return expired
  if (verdict.kind === 'allow') return { allowed: true, address: verdict.address }
  if (verdict.kind === 'deny') {
    violations.record(commandId, `deny network-outbound ${host}:${port} (${verdict.reason})`)
    return {
      allowed: false,
      message: verdict.configurable ? NETWORK_APPROVAL_REQUIRED : NETWORK_POLICY_BLOCKED
    }
  }
  let allowed = false
  try {
    allowed = (await approval?.({ host: verdict.host, port, commandId, purpose })) === true
  } catch {
    allowed = false
  }
  if (!current()) return expired
  if (allowed) return { allowed: true, address: verdict.address }
  if (purpose === 'probe')
    return { allowed: false, source: verdict.source, address: verdict.address }
  violations.record(commandId, `deny network-outbound ${verdict.host}:${port} (not approved)`)
  return {
    allowed: false,
    message: NETWORK_APPROVAL_REQUIRED
  }
}

const refreshWindowsProtection = async (): Promise<SandboxDependencyCheck> => {
  const config = runtimeConfig
  if (!config || process.platform !== 'win32') {
    windowsProtectedGatewayPort = undefined
    return { warnings: [], errors: [] }
  }
  const check = await checkWindowsAppContainer(
    config.windowsHostPath,
    config.installationId,
    config.windowsOwnershipRoot
  )
  if (check.errors.length > 0) {
    windowsProtectedGatewayPort = undefined
    return check
  }
  try {
    const status = await readAppContainerStatus(
      config.windowsHostPath,
      config.installationId,
      config.windowsOwnershipRoot
    )
    windowsProtectedGatewayPort = status.gatewayPort ?? undefined
    return check
  } catch (error) {
    windowsProtectedGatewayPort = undefined
    return {
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)]
    }
  }
}

const initialize = async (config: NetworkRuntimeConfig, ask: NetworkAskCallback): Promise<void> => {
  if (runtimeConfig) throw new Error('Notebook process runtime is already initialized.')
  runtimeConfig = config
  approval = ask
  destinationPolicy = buildPolicy(config)
  await refreshWindowsProtection()
}

const wrap = async (
  request: NetworkWrapRequest
): Promise<{
  argv: string[]
  env: NodeJS.ProcessEnv
  confirmProcessTreeTermination?: () => Promise<boolean>
  beginSpawn?: () => Readonly<{ started: () => void; notStarted: () => void }>
}> => {
  if (finishing.size > 0) await Promise.allSettled([...finishing])
  const config = runtimeConfig
  if (!config) throw new Error('Notebook process runtime is not initialized.')
  const target = request.target ?? { kind: 'native' }
  const filesystem = normalizeFilesystemLayout({
    ...request.filesystem,
    ...((process.platform === 'darwin' || process.platform === 'linux') &&
    !request.filesystem.privateRoot
      ? { privateRoot: homedir() }
      : {})
  })
  const credentials = {
    username: `notebook-${request.commandId}`,
    password: randomBytes(32).toString('base64url')
  }
  if (target.kind === 'wsl2') {
    if (process.platform !== 'win32') {
      throw new Error('Notebook WSL2 sandbox target requires a Windows host.')
    }
    const gateway = await CommandGateway.open({
      decide: (host, port) => decide(request.commandId, host, port),
      credentials,
      ...(request.localRpcSocketPath ? { localRpcSocketPath: request.localRpcSocketPath } : {}),
      parentProxy: parentSettings(config)
    })
    try {
      const launch = await wsl2Launch({
        target,
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        ...(request.pathEnvironment ? { pathEnvironment: request.pathEnvironment } : {}),
        filesystem,
        gatewayPort: gateway.port,
        gatewayCredentials: credentials,
        onCleanupReady: (releasePlatform) => {
          commandContexts.set(request.commandId, {
            filesystem,
            gateway,
            releasePlatform,
            platformOwnsProcesses: true,
            executionActive: false,
            epoch: 0
          })
        },
        ...(request.signal ? { signal: request.signal } : {})
      })
      commandContexts.set(request.commandId, {
        filesystem,
        gateway,
        releasePlatform: launch.release,
        platformOwnsProcesses: true,
        executionActive: false,
        epoch: 0
      })
      return { argv: launch.argv, env: launch.env, beginSpawn: launch.beginSpawn }
    } catch (error) {
      if (commandContexts.has(request.commandId)) {
        const cleanup = await cleanupAfterCommand(request.commandId, 'spawn-failed', {
          processesTerminated: true
        })
        if (!cleanupComplete(cleanup)) {
          throw new Error(
            'SHELL_CLEANUP_INCOMPLETE: WSL2 shell preparation cleanup could not be verified.',
            { cause: error }
          )
        }
      } else {
        await gateway.close()
      }
      throw error
    }
  }
  let certificateAuthority: LocalCertificateAuthority | undefined
  let trustBundle: Awaited<ReturnType<typeof createClientTrustBundle>> | undefined
  try {
    certificateAuthority = await createLocalCertificateAuthority()
    trustBundle = await createClientTrustBundle(
      config.trustedCaCertificates,
      certificateAuthority.certificatePem
    )
  } catch {
    certificateAuthority?.dispose()
    certificateAuthority = undefined
    // Missing inspection material preserves the existing target-approval path.
  }
  const env = { ...request.env, ...(trustBundle ? clientTrustEnvironment(trustBundle.path) : {}) }
  let gateway: CommandGateway | undefined
  const context: RuntimeContext = {
    filesystem,
    executionActive: false,
    epoch: 0,
    certificateAuthority,
    trustBundle
  }
  commandContexts.set(request.commandId, context)
  try {
    const filesystem = normalizeFilesystemLayout({
      ...request.filesystem,
      readOnlyRoots: [
        ...request.filesystem.readOnlyRoots,
        ...(trustBundle ? [trustBundle.path] : [])
      ],
      deniedWriteRoots: [
        ...request.filesystem.deniedWriteRoots,
        ...(trustBundle ? [trustBundle.path] : [])
      ],
      ...((process.platform === 'darwin' || process.platform === 'linux') &&
      !request.filesystem.privateRoot
        ? { privateRoot: homedir() }
        : {})
    })
    const credentials = {
      username: `notebook-${request.commandId}`,
      password: randomBytes(32).toString('base64url')
    }
    const windowsGatewayPort = windowsProtectedGatewayPort
    gateway = await CommandGateway.open({
      decide: (host, port, purpose) => decide(request.commandId, host, port, purpose),
      ...(certificateAuthority
        ? {
            inspection: {
              certificate: certificateAuthority.getSecureContext,
              isExecutionActive: () => context?.executionActive === true,
              get trustedCaCertificates() {
                return runtimeConfig?.trustedCaCertificates
              }
            }
          }
        : {}),
      credentials,
      ...(request.localRpcSocketPath ? { localRpcSocketPath: request.localRpcSocketPath } : {}),
      parentProxy: parentSettings(config),
      ...(windowsGatewayPort ? { sharedPort: windowsGatewayPort } : {})
    })
    context.filesystem = filesystem
    context.gateway = gateway
    if (process.platform === 'darwin') {
      return macosLaunch({
        command: request.command,
        shell: typeof request.shell === 'string' ? request.shell : '/bin/bash',
        gatewayPort: gateway.port,
        gatewayCredentials: credentials,
        env,
        ...(request.localRpcSocketPath ? { localRpcSocketPath: request.localRpcSocketPath } : {}),
        ...(request.inheritedFileDescriptorCount
          ? { inheritedFileDescriptorCount: request.inheritedFileDescriptorCount }
          : {}),
        filesystem
      })
    }
    if (process.platform === 'linux') {
      if (typeof request.shell === 'object') {
        throw new Error('Structured shell selection is only supported on Windows.')
      }
      const launch = await linuxLaunch({
        command: request.command,
        shell: request.shell ?? '/bin/bash',
        cwd: request.cwd,
        gatewayPort: gateway.port,
        gatewayCredentials: credentials,
        env,
        ...(request.localRpcSocketPath ? { localRpcSocketPath: request.localRpcSocketPath } : {}),
        ...(request.inheritedFileDescriptorCount
          ? { inheritedFileDescriptorCount: request.inheritedFileDescriptorCount }
          : {}),
        filesystem
      })
      context.releasePlatform = launch.release
      return { argv: launch.argv, env: launch.env }
    }
    if (process.platform === 'win32') {
      const launchRequest = {
        command: request.command,
        ...(request.executable ? { executable: request.executable, args: request.args ?? [] } : {}),
        ...(request.shell ? { shell: request.shell } : {}),
        gatewayPort: gateway.port,
        gatewayCredentials: credentials,
        env,
        ...(request.localRpcSocketPath ? { localRpcSocketPath: request.localRpcSocketPath } : {})
      }
      // Standard mode has no AppContainer, but opted-in short-lived workers still need reliable
      // process-tree ownership so a normal leader exit cannot poison the next cleanup attempt.
      if (!windowsGatewayPort && request.superviseProcessTree) {
        return windowsSupervisedLaunch({
          ...launchRequest,
          cwd: request.cwd,
          hostPath: config.windowsHostPath
        })
      }
      if (!windowsGatewayPort) return windowsStandardLaunch(launchRequest)
      return windowsLaunch({
        ...launchRequest,
        cwd: request.cwd,
        filesystem,
        hostPath: config.windowsHostPath,
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot
      })
    }
    throw new Error(`Notebook process sandbox does not support ${process.platform}.`)
  } catch (error) {
    const cleanup = await cleanupAfterCommand(request.commandId, 'spawn-failed', {
      processesTerminated: true
    })
    if (!cleanupComplete(cleanup)) {
      throw new Error(
        'SHELL_CLEANUP_INCOMPLETE: Notebook preparation cleanup could not be verified.',
        {
          cause: error
        }
      )
    }
    throw error
  }
}

const closeContext = async (
  context: RuntimeContext,
  reason: SandboxCleanupReason,
  processOutcome: SandboxProcessOutcome
): Promise<SandboxCleanupResult> => {
  context.executionActive = false
  context.epoch += 1
  context.certificateAuthority?.dispose()
  const [network, temporaryResources, trustBundle] = await Promise.allSettled([
    context.gateway?.close(),
    context.releasePlatform?.(reason),
    context.trustBundle?.cleanup()
  ])
  const platformResult =
    temporaryResources.status === 'fulfilled' ? temporaryResources.value : false
  const platformCleanup =
    typeof platformResult === 'object'
      ? platformResult
      : {
          processesTerminated: platformResult !== false,
          networkClosed: platformResult !== false,
          temporaryResourcesRemoved: platformResult !== false
        }
  return {
    processesTerminated: context.platformOwnsProcesses
      ? platformCleanup.processesTerminated
      : platformCleanup.processesTerminated && processOutcome.processesTerminated,
    networkClosed: network.status === 'fulfilled' && platformCleanup.networkClosed,
    temporaryResourcesRemoved:
      platformCleanup.temporaryResourcesRemoved && trustBundle.status === 'fulfilled'
  }
}

const cleanupAfterCommand = async (
  commandId: string,
  reason: SandboxCleanupReason,
  processOutcome: SandboxProcessOutcome
): Promise<SandboxCleanupResult> => {
  const context = commandContexts.get(commandId)
  if (!context) {
    return {
      processesTerminated: processOutcome.processesTerminated,
      networkClosed: true,
      temporaryResourcesRemoved: true
    }
  }
  const task = closeContext(context, reason, processOutcome)
    .then((result) => {
      if (cleanupComplete(result)) {
        commandContexts.delete(commandId)
        violations.forget(commandId)
      }
      return result
    })
    .finally(() => finishing.delete(task))
  finishing.add(task)
  return task
}

const resetCommandConnections = (commandId: string): void => {
  const context = commandContexts.get(commandId)
  if (!context) return
  context.epoch += 1
  context.gateway?.resetConnections()
}

const updateConfig = (config: NetworkRuntimeConfig): void => {
  if (!runtimeConfig) throw new Error('Notebook process runtime is not initialized.')
  runtimeConfig = config
  destinationPolicy = buildPolicy(config)
  const nextParent = parentSettings(config)
  for (const context of commandContexts.values()) {
    context.epoch += 1
    context.gateway?.updateParentProxy(nextParent)
    context.gateway?.resetConnections()
  }
}

const reset = async (): Promise<void> => {
  const active = [...commandContexts.entries()]
  await Promise.all([
    ...finishing,
    ...active.map(([id, context]) =>
      closeContext(context, 'cancel', { processesTerminated: false }).then((result) => {
        const complete = context.platformOwnsProcesses
          ? cleanupComplete(result)
          : result.networkClosed && result.temporaryResourcesRemoved
        if (!complete) return
        commandContexts.delete(id)
        violations.forget(id)
      })
    )
  ])
  finishing.clear()
  if (commandContexts.size > 0) {
    throw new Error('Notebook process runtime cleanup was incomplete.')
  }
  violations.clear()
  runtimeConfig = undefined
  approval = undefined
  destinationPolicy = undefined
  windowsProtectedGatewayPort = undefined
}

const statusForPlatform = async (
  platform: NodeJS.Platform,
  config: NetworkRuntimeConfig
): Promise<SandboxDependencyCheck> => {
  if (platform === 'darwin') {
    try {
      await access('/usr/bin/sandbox-exec', constants.X_OK)
      return { warnings: [], errors: [] }
    } catch {
      return { warnings: [], errors: ['macOS Seatbelt runner is unavailable'] }
    }
  }
  if (platform === 'linux') return checkLinuxTools()
  if (platform === 'win32')
    return checkWindowsAppContainer(
      config.windowsHostPath,
      config.installationId,
      config.windowsOwnershipRoot
    )
  return { warnings: [], errors: [`Unsupported platform: ${platform}`] }
}

const installWindows = (config: NetworkRuntimeConfig): Promise<{ cancelled: boolean }> =>
  installWindowsAppContainer(
    config.windowsHostPath,
    config.installationId,
    config.windowsOwnershipRoot
  )

const removeWindows = (config: NetworkRuntimeConfig): Promise<{ cancelled: boolean }> =>
  removeWindowsAppContainer(
    config.windowsHostPath,
    config.installationId,
    config.windowsOwnershipRoot
  )

const getWindowsRuntimeAccess = (
  config: NetworkRuntimeConfig,
  executable: string
): Promise<{ authorized: boolean; registered: boolean }> =>
  getWindowsRuntimeAccessImpl(
    config.windowsHostPath,
    config.installationId,
    config.windowsOwnershipRoot,
    executable
  )

const setWindowsRuntimeAccess = (
  config: NetworkRuntimeConfig,
  executable: string,
  authorized: boolean,
  verification?: WindowsRuntimeVerification
): Promise<{ cancelled: boolean }> =>
  setWindowsRuntimeAccessImpl(
    config.windowsHostPath,
    config.installationId,
    config.windowsOwnershipRoot,
    executable,
    authorized,
    verification
  )

const NotebookNetworkRuntime = {
  initialize,
  wrap,
  updateConfig,
  annotateStderr: (commandId: string, stderr: string): string =>
    violations.attach(commandId, stderr, (path) => {
      const filesystem = commandContexts.get(commandId)?.filesystem
      return filesystem ? hiddenByFilesystemLayout(filesystem, path) : false
    }),
  setCommandExecutionActive: (commandId: string, active: boolean): void => {
    const context = commandContexts.get(commandId)
    if (!context) return
    context.epoch += 1
    context.executionActive = active
    context.gateway?.resetConnections()
  },
  resetCommandConnections,
  cleanupAfterCommand,
  refreshWindowsProtection,
  reset
} as const

export {
  NotebookNetworkRuntime,
  installWindows,
  removeWindows,
  setWindowsRuntimeAccess,
  getWindowsRuntimeAccess,
  statusForPlatform
}
export type {
  NetworkAskCallback,
  NetworkRuntimeConfig,
  NetworkWrapRequest,
  SandboxDependencyCheck,
  WindowsShell,
  WindowsRuntimeVerification
}
