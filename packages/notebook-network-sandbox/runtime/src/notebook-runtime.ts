import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

import { DestinationPolicy } from './gateway/address-policy.js'
import {
  CommandGateway,
  type GatewayDecision,
  type ParentProxySettings
} from './gateway/command-gateway.js'
import { ViolationLog } from './gateway/violation-log.js'
import { checkLinuxTools, linuxLaunch } from './platform/linux-isolation.js'
import { macosLaunch } from './platform/macos-isolation.js'
import {
  checkWindowsAppContainer,
  installWindowsAppContainer,
  readAppContainerStatus,
  removeWindowsAppContainer,
  windowsLaunch,
  windowsStandardLaunch,
  type WindowsShell
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
}) => Promise<boolean>

type NetworkWrapRequest = Readonly<{
  command: string
  commandId: string
  shell?: string | WindowsShell
  cwd: string
  env: NodeJS.ProcessEnv
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  filesystem: FilesystemLayoutInput
}>

type RuntimeContext = {
  filesystem: FilesystemLayout
  gateway: CommandGateway
  releasePlatform?: () => Promise<void>
}

let runtimeConfig: NetworkRuntimeConfig | undefined
let approval: NetworkAskCallback | undefined
let destinationPolicy: DestinationPolicy | undefined
let windowsProtectedGatewayPort: number | undefined
const commandContexts = new Map<string, RuntimeContext>()
const finishing = new Set<Promise<void>>()
const violations = new ViolationLog()

const parentSettings = (config: NetworkRuntimeConfig): ParentProxySettings | undefined => {
  if (!config.parentProxy && !config.trustedCaCertificates?.length) return undefined
  return {
    ...config.parentProxy,
    ...(config.trustedCaCertificates?.length
      ? { trustedCaCertificates: config.trustedCaCertificates }
      : {})
  }
}

const buildPolicy = (config: NetworkRuntimeConfig): DestinationPolicy =>
  new DestinationPolicy({
    allowedDomains: config.allowedDomains,
    deniedDomains: config.deniedDomains,
    ...(config.deniedDomainReasons ? { deniedDomainReasons: config.deniedDomainReasons } : {})
  })

const decide = async (commandId: string, host: string, port: number): Promise<GatewayDecision> => {
  const policy = destinationPolicy
  if (!policy) {
    violations.record(commandId, `deny network-outbound ${host}:${port} (policy unavailable)`)
    return { allowed: false, message: 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED' }
  }
  const verdict = await policy.inspect(host, port)
  if (verdict.kind === 'allow') return { allowed: true, address: verdict.address }
  if (verdict.kind === 'deny') {
    violations.record(commandId, `deny network-outbound ${host}:${port} (${verdict.reason})`)
    return {
      allowed: false,
      message: verdict.configurable
        ? 'OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED: This domain is not in Settings > Network > Allowed domains.'
        : 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED: This destination is blocked by the Notebook network policy.'
    }
  }
  let allowed = false
  try {
    allowed = (await approval?.({ host: verdict.host, port, commandId })) === true
  } catch {
    allowed = false
  }
  if (allowed) return { allowed: true, address: verdict.address }
  violations.record(commandId, `deny network-outbound ${verdict.host}:${port} (not approved)`)
  return {
    allowed: false,
    message:
      'OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED: This domain is not in Settings > Network > Allowed domains.'
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
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> => {
  if (finishing.size > 0) await Promise.allSettled([...finishing])
  const config = runtimeConfig
  if (!config) throw new Error('Notebook process runtime is not initialized.')
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
  const windowsGatewayPort = windowsProtectedGatewayPort
  const gateway = await CommandGateway.open({
    decide: (host, port) => decide(request.commandId, host, port),
    credentials,
    ...(request.localRpcSocketPath ? { localRpcSocketPath: request.localRpcSocketPath } : {}),
    parentProxy: parentSettings(config),
    ...(windowsGatewayPort ? { sharedPort: windowsGatewayPort } : {})
  })
  const context: RuntimeContext = { filesystem, gateway }
  commandContexts.set(request.commandId, context)
  try {
    if (process.platform === 'darwin') {
      return macosLaunch({
        command: request.command,
        shell: typeof request.shell === 'string' ? request.shell : '/bin/bash',
        gatewayPort: gateway.port,
        gatewayCredentials: credentials,
        env: request.env,
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
        env: request.env,
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
        ...(request.shell ? { shell: request.shell } : {}),
        gatewayPort: gateway.port,
        gatewayCredentials: credentials,
        env: request.env,
        ...(request.localRpcSocketPath ? { localRpcSocketPath: request.localRpcSocketPath } : {})
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
    commandContexts.delete(request.commandId)
    await gateway.close()
    throw error
  }
}

const closeContext = async (commandId: string, context: RuntimeContext): Promise<void> => {
  await Promise.allSettled([context.gateway.close(), context.releasePlatform?.()])
  violations.forget(commandId)
}

const cleanupAfterCommand = (commandId: string): void => {
  const context = commandContexts.get(commandId)
  if (!context) return
  commandContexts.delete(commandId)
  const task = closeContext(commandId, context).finally(() => finishing.delete(task))
  finishing.add(task)
}

const resetCommandConnections = (commandId: string): void => {
  commandContexts.get(commandId)?.gateway.resetConnections()
}

const updateConfig = (config: NetworkRuntimeConfig): void => {
  if (!runtimeConfig) throw new Error('Notebook process runtime is not initialized.')
  runtimeConfig = config
  destinationPolicy = buildPolicy(config)
  const nextParent = parentSettings(config)
  for (const context of commandContexts.values()) {
    context.gateway.updateParentProxy(nextParent)
    context.gateway.resetConnections()
  }
}

const reset = async (): Promise<void> => {
  const active = [...commandContexts.entries()]
  commandContexts.clear()
  await Promise.all([...finishing, ...active.map(([id, context]) => closeContext(id, context))])
  finishing.clear()
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

const NotebookNetworkRuntime = {
  initialize,
  wrap,
  updateConfig,
  annotateStderr: (commandId: string, stderr: string): string =>
    violations.attach(commandId, stderr, (path) => {
      const filesystem = commandContexts.get(commandId)?.filesystem
      return filesystem ? hiddenByFilesystemLayout(filesystem, path) : false
    }),
  resetCommandConnections,
  cleanupAfterCommand,
  refreshWindowsProtection,
  reset
} as const

export { NotebookNetworkRuntime, installWindows, removeWindows, statusForPlatform }
export type {
  NetworkAskCallback,
  NetworkRuntimeConfig,
  NetworkWrapRequest,
  SandboxDependencyCheck,
  WindowsShell
}
