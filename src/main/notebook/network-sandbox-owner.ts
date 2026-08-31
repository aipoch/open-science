import { NotebookNetworkSandbox } from '@aipoch/notebook-network-sandbox'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildNotebookNetworkPolicy,
  notebookNetworkSettingsAllowDomain,
  normalizeNotebookNetworkSettings,
  validateCustomAllowedDomain,
  type NotebookNetworkSettings,
  type NotebookNetworkStatus,
  type NotebookNetworkStatusReason
} from '../../shared/notebook-network'
import type {
  NotebookProcessSandbox,
  NotebookNetworkAccessDecisionRequest,
  NotebookNetworkAccessDecisionResult,
  NotebookSandboxedSpawn,
  NotebookSandboxInvocation
} from './process-sandbox'
import { environmentPathRoots, notebookTrustBundleEnvironment } from './process-environment'
import {
  notebookTrustBundleStatus,
  resolveNotebookTrustBundle,
  type NotebookTrustBundle,
  type NotebookTrustBundleStatus
} from './trust-bundle'
import type { GrantedLocalRoot } from '../../shared/local-fs'

export type NotebookNetworkDecision = 'deny' | 'allowOnce' | 'alwaysAllow'

type NotebookNetworkDecisionRequest = Readonly<{
  sessionId: string
  projectId: string
  hostname: string
  port?: number
  runtime?: NotebookSandboxInvocation['runtime']
  reason?: string
  signal: AbortSignal
}>

type NotebookCommandRuntime = NotebookSandboxInvocation['runtime']

const executionGrantKey = (sessionId: string, runtime: NotebookCommandRuntime): string =>
  `${sessionId}\0${runtime}`

const commandGrantKey = (
  sessionId: string,
  runtime: NotebookCommandRuntime,
  commandText: string
): string => `${executionGrantKey(sessionId, runtime)}\0${commandText}`

const blockedDestinationKey = (sessionId: string, hostname: string): string =>
  `${sessionId}\0${hostname}`

type NotebookNetworkSandboxOwnerOptions = Readonly<{
  resourceRoot: string
  getSettings: () => Promise<NotebookNetworkSettings | undefined>
  persistAlwaysAllow: (hostname: string) => Promise<NotebookNetworkSettings>
  requestDecision: (request: NotebookNetworkDecisionRequest) => Promise<NotebookNetworkDecision>
  getParentProxy?: () => Promise<
    Readonly<{ http?: string; https?: string; noProxy?: string }> | undefined
  >
  getCaBundlePath?: () => Promise<string | undefined>
  getGrantedLocalRoots?: () => Promise<readonly GrantedLocalRoot[]>
  platform?: NodeJS.Platform
}>

const quotePosix = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`
const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`

const protectedWriteRoots = (readWriteRoots: readonly string[]): string[] =>
  [
    join(homedir(), '.bash_profile'),
    join(homedir(), '.bashrc'),
    join(homedir(), '.profile'),
    join(homedir(), '.zprofile'),
    join(homedir(), '.zshrc'),
    join(homedir(), '.gitconfig'),
    join(homedir(), '.ssh'),
    join(homedir(), '.aws'),
    join(homedir(), '.config', 'git'),
    ...readWriteRoots.map((root) => join(root, '.git'))
  ].filter(existsSync)

const dependencyReason = (message: string): NotebookNetworkStatusReason => {
  if (message.includes('bubblewrap')) return 'linuxBubblewrapMissing'
  if (message.includes('Seatbelt')) return 'macSeatbeltUnavailable'
  if (message.includes('host not executable')) return 'windowsHostMissing'
  if (message.includes('gateway port')) return 'windowsGatewayPortUnavailable'
  if (message.includes('profile is not installed')) return 'windowsProfileMissing'
  if (message.includes('loopback access is not installed')) return 'windowsLoopbackMissing'
  if (message.includes('loopback network fence is not installed'))
    return 'windowsNetworkFenceMissing'
  if (message.includes('ownership')) return 'windowsOwnershipMissing'
  return 'runtimeFailure'
}

const presentStatus = (
  status: Awaited<ReturnType<NotebookNetworkSandbox['status']>>
): NotebookNetworkStatus => {
  if (status.kind === 'ready') {
    return { kind: 'ready', warnings: status.warnings.map(dependencyReason) }
  }
  if (status.kind === 'setupRequired') {
    return {
      kind: 'setupRequired',
      platform: status.platform,
      reasons: status.reasons.map(dependencyReason)
    }
  }
  if (status.kind === 'error') return { kind: 'error', reason: 'runtimeFailure' }
  return status
}

const commandLine = (
  invocation: Pick<NotebookSandboxInvocation, 'executable' | 'args'>,
  platform: NodeJS.Platform
): string => {
  const quote = platform === 'win32' ? quotePowerShell : quotePosix
  const serialized = [invocation.executable, ...invocation.args].map(quote).join(' ')
  return platform === 'win32' ? `& ${serialized}` : serialized
}

class NotebookNetworkSandboxOwner implements NotebookProcessSandbox {
  private sandbox: NotebookNetworkSandbox | undefined
  private initializePromise: Promise<void> | undefined
  private initialized = false
  private settings: NotebookNetworkSettings | undefined
  private trustBundle: NotebookTrustBundle | undefined
  private readonly nextExecutionGrants = new Map<string, Set<string>>()
  private readonly blockedDestinationCommands = new Map<
    string,
    Map<NotebookCommandRuntime, Set<string>>
  >()
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: NotebookNetworkSandboxOwnerOptions) {
    this.platform = options.platform ?? process.platform
  }

  async status(): Promise<NotebookNetworkStatus> {
    if (this.initializePromise) return { kind: 'checking' }
    try {
      await resolveNotebookTrustBundle(await this.options.getCaBundlePath?.())
    } catch {
      return { kind: 'error', reason: 'trustBundleInvalid' }
    }
    try {
      return presentStatus(await this.getOrCreateSandbox().status(this.platform))
    } catch {
      return { kind: 'error', reason: 'runtimeFailure' }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = this.initializeInternal()
    try {
      await this.initializePromise
    } finally {
      this.initializePromise = undefined
    }
  }

  async wrap(invocation: NotebookSandboxInvocation): Promise<NotebookSandboxedSpawn> {
    await this.initialize()
    await this.updateTrustBundle()
    const grantedRoots = (await this.options.getGrantedLocalRoots?.()) ?? []
    const commandTempRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-'))
    const env = {
      ...invocation.env,
      ...notebookTrustBundleEnvironment(this.trustBundle?.path),
      TMPDIR: commandTempRoot,
      TEMP: commandTempRoot,
      TMP: commandTempRoot
    }
    let activeExecutionGrants: ReadonlySet<string> = new Set()
    let executionActive = false
    let wrapped: Awaited<ReturnType<NotebookNetworkSandbox['wrap']>>
    try {
      wrapped = await this.sandbox!.wrap({
        command: commandLine(invocation, this.platform),
        cwd: invocation.cwd,
        env,
        ...(invocation.localRpcSocketPath
          ? { localRpcSocketPath: invocation.localRpcSocketPath }
          : {}),
        ...(invocation.inheritedFileDescriptorCount
          ? { inheritedFileDescriptorCount: invocation.inheritedFileDescriptorCount }
          : {}),
        filesystem: {
          privateRoot: homedir(),
          readOnlyRoots: [
            ...invocation.filesystem.readOnlyRoots,
            ...environmentPathRoots(env, this.platform),
            ...grantedRoots.map((root) => root.path),
            ...(this.trustBundle ? [this.trustBundle.path] : [])
          ],
          readWriteRoots: [
            ...invocation.filesystem.readWriteRoots,
            commandTempRoot,
            ...grantedRoots.filter((root) => root.access === 'rw').map((root) => root.path)
          ],
          deniedReadRoots: invocation.filesystem.deniedReadRoots,
          deniedWriteRoots: [
            ...invocation.filesystem.deniedWriteRoots,
            ...protectedWriteRoots([
              ...invocation.filesystem.readWriteRoots,
              ...grantedRoots.filter((root) => root.access === 'rw').map((root) => root.path)
            ]),
            ...(this.trustBundle ? [this.trustBundle.path] : [])
          ]
        },
        ...(invocation.signal ? { signal: invocation.signal } : {}),
        onNetworkAccessRequest: (request) =>
          this.isCommandGrantAllowed(
            invocation.sessionId,
            invocation.runtime,
            invocation.commandText,
            executionActive,
            activeExecutionGrants,
            request
          )
      })
    } catch (error) {
      await rm(commandTempRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      activeExecutionGrants = new Set()
      executionActive = false
      try {
        wrapped.cleanup()
      } finally {
        void rm(commandTempRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    const [executable, ...args] = wrapped.argv
    if (!executable) {
      cleanup()
      throw new Error('Notebook network sandbox returned an empty command.')
    }
    return {
      executable,
      args,
      env: wrapped.env,
      beginExecution: () => {
        if (cleaned) throw new Error('Notebook sandbox process is already closed.')
        if (executionActive) throw new Error('Notebook sandbox execution is already active.')
        wrapped.resetNetworkConnections()
        executionActive = true
        const grantKey = commandGrantKey(
          invocation.sessionId,
          invocation.runtime,
          invocation.commandText
        )
        activeExecutionGrants = this.nextExecutionGrants.get(grantKey) ?? new Set()
        this.nextExecutionGrants.delete(grantKey)
        let ended = false
        return () => {
          if (ended) return
          ended = true
          activeExecutionGrants = new Set()
          executionActive = false
          wrapped.resetNetworkConnections()
        }
      },
      annotateStderr: wrapped.annotateStderr,
      cleanup
    }
  }

  async requestNetworkAccess(
    request: NotebookNetworkAccessDecisionRequest
  ): Promise<NotebookNetworkAccessDecisionResult> {
    const normalized = validateCustomAllowedDomain(request.hostname)
    if (!normalized.ok) {
      return { hostname: request.hostname, status: 'blocked' }
    }
    const settings = normalizeNotebookNetworkSettings(
      this.settings ?? (await this.options.getSettings())
    )
    this.settings = settings
    if (notebookNetworkSettingsAllowDomain(settings, normalized.hostname)) {
      return { hostname: normalized.hostname, status: 'alreadyAllowed' }
    }

    const destinationKey = blockedDestinationKey(request.sessionId, normalized.hostname)
    const blockedCommands = this.blockedDestinationCommands.get(destinationKey)
    const blockedRuntimes = blockedCommands ? new Set(blockedCommands.keys()) : undefined
    const runtime = request.runtime
      ? blockedRuntimes?.has(request.runtime)
        ? request.runtime
        : undefined
      : blockedRuntimes?.size === 1
        ? [...blockedRuntimes][0]
        : undefined
    if (!blockedRuntimes || !runtime) {
      return { hostname: normalized.hostname, status: 'denied' }
    }
    const commands = blockedCommands!.get(runtime)
    const commandText =
      request.command && commands?.has(request.command)
        ? request.command
        : commands?.size === 1
          ? [...commands][0]
          : undefined
    if (!commands || !commandText) {
      return { hostname: normalized.hostname, status: 'denied' }
    }
    commands.delete(commandText)
    if (commands.size === 0) blockedCommands!.delete(runtime)
    if (blockedCommands!.size === 0) this.blockedDestinationCommands.delete(destinationKey)

    const controller = request.signal ? undefined : new AbortController()
    const signal = request.signal ?? controller!.signal
    if (signal.aborted) return { hostname: normalized.hostname, status: 'denied' }
    const decision = await this.options.requestDecision({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostname: normalized.hostname,
      runtime,
      reason: request.reason,
      signal
    })
    if (decision === 'deny' || signal.aborted) {
      return { hostname: normalized.hostname, status: 'denied' }
    }
    if (decision === 'allowOnce') {
      const grantKey = commandGrantKey(request.sessionId, runtime, commandText)
      const grants = this.nextExecutionGrants.get(grantKey) ?? new Set<string>()
      grants.add(normalized.hostname)
      this.nextExecutionGrants.set(grantKey, grants)
      return { hostname: normalized.hostname, status: 'allowedOnce' }
    }

    const next = await this.options.persistAlwaysAllow(normalized.hostname)
    this.applySettings(next)
    return { hostname: normalized.hostname, status: 'alwaysAllowed' }
  }

  applySettings(settings: NotebookNetworkSettings): void {
    this.settings = normalizeNotebookNetworkSettings(settings)
    if (this.initialized) this.sandbox!.updatePolicy(buildNotebookNetworkPolicy(this.settings))
  }

  async updateParentProxy(): Promise<void> {
    if (!this.initialized || !this.options.getParentProxy) return
    const parentProxy = await this.options.getParentProxy()
    this.sandbox!.updateConfiguration({ parentProxy: parentProxy ?? null })
  }

  async updateTrustBundle(): Promise<NotebookTrustBundleStatus> {
    const next = await resolveNotebookTrustBundle(await this.options.getCaBundlePath?.())
    const changed =
      next?.path !== this.trustBundle?.path ||
      next?.certificates.join('\n') !== this.trustBundle?.certificates.join('\n')
    this.trustBundle = next
    if (changed && this.initialized) {
      this.sandbox!.updateConfiguration({
        trustBundle: next ? { path: next.path, certificates: next.certificates } : null
      })
    }
    return notebookTrustBundleStatus(next)
  }

  installWindows(): Promise<{ cancelled: boolean }> {
    return this.getOrCreateSandbox().installWindows()
  }

  removeWindows(): Promise<{ cancelled: boolean }> {
    return this.getOrCreateSandbox().removeWindows()
  }

  async dispose(): Promise<void> {
    await this.initializePromise?.catch(() => undefined)
    await this.sandbox?.dispose()
    this.initialized = false
    this.sandbox = undefined
    this.nextExecutionGrants.clear()
    this.blockedDestinationCommands.clear()
  }

  private async initializeInternal(): Promise<void> {
    this.settings = normalizeNotebookNetworkSettings(
      this.settings ?? (await this.options.getSettings())
    )
    const parentProxy = await this.options.getParentProxy?.()
    this.trustBundle = await resolveNotebookTrustBundle(await this.options.getCaBundlePath?.())
    this.sandbox = this.createSandbox(this.settings, parentProxy)
    await this.sandbox.initialize()
    this.initialized = true
  }

  private getOrCreateSandbox(): NotebookNetworkSandbox {
    if (!this.sandbox) {
      this.sandbox = this.createSandbox(normalizeNotebookNetworkSettings(this.settings), undefined)
    }
    return this.sandbox
  }

  private createSandbox(
    settings: NotebookNetworkSettings,
    parentProxy: Readonly<{ http?: string; https?: string; noProxy?: string }> | undefined
  ): NotebookNetworkSandbox {
    return new NotebookNetworkSandbox({
      policy: buildNotebookNetworkPolicy(settings),
      resources: { root: this.options.resourceRoot },
      ...(parentProxy ? { parentProxy } : {}),
      ...(this.trustBundle
        ? {
            trustBundle: {
              path: this.trustBundle.path,
              certificates: this.trustBundle.certificates
            }
          }
        : {})
    })
  }

  private isCommandGrantAllowed(
    sessionId: string,
    runtime: NotebookCommandRuntime,
    commandText: string,
    executionActive: boolean,
    commandGrants: ReadonlySet<string>,
    request: { host: string; signal: AbortSignal }
  ): Promise<boolean> {
    if (request.signal.aborted) return Promise.resolve(false)
    const normalized = validateCustomAllowedDomain(request.host)
    if (!normalized.ok || !executionActive) return Promise.resolve(false)
    if (commandGrants.has(normalized.hostname)) return Promise.resolve(true)
    const key = blockedDestinationKey(sessionId, normalized.hostname)
    const runtimes = this.blockedDestinationCommands.get(key) ?? new Map()
    const commands = runtimes.get(runtime) ?? new Set<string>()
    commands.add(commandText)
    runtimes.set(runtime, commands)
    this.blockedDestinationCommands.set(key, runtimes)
    return Promise.resolve(false)
  }
}

export { NotebookNetworkSandboxOwner, commandLine }
