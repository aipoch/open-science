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
import { startDiagnosticOperation } from '../diagnostics/operation'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { environmentPathRoots, notebookTrustBundleEnvironment } from './process-environment'
import {
  notebookTrustBundleStatus,
  resolveNotebookTrustBundle,
  type NotebookTrustBundle,
  type NotebookTrustBundleStatus
} from './trust-bundle'
import type { GrantedLocalRoot } from '../../shared/local-fs'

export type NotebookNetworkDecision = 'deny' | 'allowOnce' | 'alwaysAllow' | 'unavailable'

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
  logger?: Logger
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
  private readonly log: Logger
  private lastStatusSignature: string | undefined

  constructor(private readonly options: NotebookNetworkSandboxOwnerOptions) {
    this.platform = options.platform ?? process.platform
    this.log = options.logger ?? createLogger('notebook:network-sandbox')
  }

  async status(): Promise<NotebookNetworkStatus> {
    if (this.initializePromise) return this.recordStatus({ kind: 'checking' })
    try {
      await resolveNotebookTrustBundle(await this.options.getCaBundlePath?.())
    } catch (error) {
      return this.recordStatus(
        { kind: 'error', reason: 'trustBundleInvalid' },
        diagnosticErrorFields(error)
      )
    }
    try {
      return this.recordStatus(presentStatus(await this.getOrCreateSandbox().status(this.platform)))
    } catch (error) {
      return this.recordStatus(
        { kind: 'error', reason: 'runtimeFailure' },
        diagnosticErrorFields(error)
      )
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
        ...(this.platform === 'win32'
          ? { executable: invocation.executable, args: invocation.args }
          : {}),
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
      this.log.error('sandbox process preparation failed', {
        platform: this.platform,
        runtime: invocation.runtime,
        ...diagnosticErrorFields(error)
      })
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
      return this.networkAccessResult(request.hostname, 'blocked', request.runtime, {
        validationReason: normalized.reason
      })
    }
    const settings = normalizeNotebookNetworkSettings(
      this.settings ?? (await this.options.getSettings())
    )
    this.settings = settings
    if (notebookNetworkSettingsAllowDomain(settings, normalized.hostname)) {
      return this.networkAccessResult(normalized.hostname, 'alreadyAllowed', request.runtime)
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
      return this.networkAccessResult(normalized.hostname, 'denied', request.runtime, {
        decisionSource: 'no-matching-block'
      })
    }
    const commands = blockedCommands!.get(runtime)
    const commandText =
      request.command && commands?.has(request.command)
        ? request.command
        : commands?.size === 1
          ? [...commands][0]
          : undefined
    if (!commands || !commandText) {
      return this.networkAccessResult(normalized.hostname, 'denied', runtime, {
        decisionSource: 'no-matching-command'
      })
    }
    commands.delete(commandText)
    if (commands.size === 0) blockedCommands!.delete(runtime)
    if (blockedCommands!.size === 0) this.blockedDestinationCommands.delete(destinationKey)

    const controller = request.signal ? undefined : new AbortController()
    const signal = request.signal ?? controller!.signal
    if (signal.aborted) {
      return this.networkAccessResult(normalized.hostname, 'denied', runtime, {
        decisionSource: 'aborted'
      })
    }
    const decision = await this.options.requestDecision({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostname: normalized.hostname,
      runtime,
      reason: request.reason,
      signal
    })
    if (decision === 'unavailable') {
      return this.networkAccessResult(normalized.hostname, 'unavailable', runtime, {
        decisionSource: 'approval-surface-unavailable'
      })
    }
    if (decision === 'deny' || signal.aborted) {
      return this.networkAccessResult(normalized.hostname, 'denied', runtime, {
        decisionSource: signal.aborted ? 'aborted' : 'user-decision'
      })
    }
    if (decision === 'allowOnce') {
      const grantKey = commandGrantKey(request.sessionId, runtime, commandText)
      const grants = this.nextExecutionGrants.get(grantKey) ?? new Set<string>()
      grants.add(normalized.hostname)
      this.nextExecutionGrants.set(grantKey, grants)
      return this.networkAccessResult(normalized.hostname, 'allowedOnce', runtime)
    }

    const next = await this.options.persistAlwaysAllow(normalized.hostname)
    this.applySettings(next)
    return this.networkAccessResult(normalized.hostname, 'alwaysAllowed', runtime)
  }

  applySettings(settings: NotebookNetworkSettings): void {
    this.settings = normalizeNotebookNetworkSettings(settings)
    try {
      if (this.initialized) this.sandbox!.updatePolicy(buildNotebookNetworkPolicy(this.settings))
      this.log.info('network policy applied', {
        active: this.initialized,
        customDomainCount: this.settings.allowedDomains.length,
        disabledGroupCount: this.settings.disabledOpenScienceDomainGroups.length,
        disabledDomainCount: this.settings.disabledOpenScienceDomains.length
      })
    } catch (error) {
      this.log.error('network policy application failed', {
        active: this.initialized,
        ...diagnosticErrorFields(error)
      })
      throw error
    }
  }

  async updateParentProxy(): Promise<void> {
    if (!this.initialized || !this.options.getParentProxy) return
    try {
      const parentProxy = await this.options.getParentProxy()
      this.sandbox!.updateConfiguration({ parentProxy: parentProxy ?? null })
      this.log.info('parent proxy configuration applied', { configured: Boolean(parentProxy) })
    } catch (error) {
      this.log.error('parent proxy configuration failed', diagnosticErrorFields(error))
      throw error
    }
  }

  async updateTrustBundle(): Promise<NotebookTrustBundleStatus> {
    let next: NotebookTrustBundle | undefined
    try {
      next = await resolveNotebookTrustBundle(await this.options.getCaBundlePath?.())
    } catch (error) {
      this.log.error('trust bundle configuration failed', diagnosticErrorFields(error))
      throw error
    }
    const changed =
      next?.path !== this.trustBundle?.path ||
      next?.certificates.join('\n') !== this.trustBundle?.certificates.join('\n')
    this.trustBundle = next
    if (changed && this.initialized) {
      this.sandbox!.updateConfiguration({
        trustBundle: next ? { path: next.path, certificates: next.certificates } : null
      })
    }
    if (changed) {
      this.log.info('trust bundle configuration applied', {
        active: this.initialized,
        configured: Boolean(next),
        certificateCount: next?.certificates.length ?? 0
      })
    }
    return notebookTrustBundleStatus(next)
  }

  async installWindows(): Promise<{ cancelled: boolean }> {
    const operation = startDiagnosticOperation(this.log, {
      operation: 'notebook-network-windows-setup',
      fields: { platform: this.platform }
    })
    try {
      const result = await this.getOrCreateSandbox().installWindows()
      if (result.cancelled) operation.cancel()
      else operation.complete()
      return result
    } catch (error) {
      operation.fail(error)
      throw error
    }
  }

  async removeWindows(): Promise<{ cancelled: boolean }> {
    const operation = startDiagnosticOperation(this.log, {
      operation: 'notebook-network-windows-remove',
      fields: { platform: this.platform }
    })
    try {
      const result = await this.getOrCreateSandbox().removeWindows()
      if (result.cancelled) operation.cancel()
      else operation.complete()
      return result
    } catch (error) {
      operation.fail(error)
      throw error
    }
  }

  async dispose(): Promise<void> {
    await this.initializePromise?.catch(() => undefined)
    try {
      await this.sandbox?.dispose()
    } catch (error) {
      this.log.error('sandbox disposal failed', diagnosticErrorFields(error))
      throw error
    }
    this.log.info('sandbox disposed')
    this.initialized = false
    this.sandbox = undefined
    this.nextExecutionGrants.clear()
    this.blockedDestinationCommands.clear()
  }

  private async initializeInternal(): Promise<void> {
    const operation = startDiagnosticOperation(this.log, {
      operation: 'notebook-network-sandbox-initialize',
      fields: { platform: this.platform }
    })
    try {
      this.settings = normalizeNotebookNetworkSettings(
        this.settings ?? (await this.options.getSettings())
      )
      const parentProxy = await this.options.getParentProxy?.()
      this.trustBundle = await resolveNotebookTrustBundle(await this.options.getCaBundlePath?.())
      this.sandbox = this.createSandbox(this.settings, parentProxy)
      await this.sandbox.initialize()
      this.initialized = true
      operation.complete({
        customDomainCount: this.settings.allowedDomains.length,
        parentProxyConfigured: Boolean(parentProxy),
        trustBundleConfigured: Boolean(this.trustBundle)
      })
    } catch (error) {
      operation.fail(error)
      throw error
    }
  }

  private recordStatus(
    status: NotebookNetworkStatus,
    extraFields: Record<string, unknown> = {}
  ): NotebookNetworkStatus {
    const signature = JSON.stringify(status)
    if (signature === this.lastStatusSignature) return status
    this.lastStatusSignature = signature
    const fields =
      status.kind === 'ready'
        ? { kind: status.kind, warningCount: status.warnings.length, warnings: status.warnings }
        : status.kind === 'setupRequired'
          ? {
              kind: status.kind,
              platform: status.platform,
              reasonCount: status.reasons.length,
              reasons: status.reasons
            }
          : status.kind === 'unsupported'
            ? { kind: status.kind, platform: status.platform }
            : status.kind === 'error'
              ? { kind: status.kind, reason: status.reason }
              : { kind: status.kind }
    const level = status.kind === 'error' ? 'error' : status.kind === 'ready' ? 'info' : 'warn'
    this.log[level]('sandbox status changed', { ...fields, ...extraFields })
    return status
  }

  private networkAccessResult(
    hostname: string,
    status: NotebookNetworkAccessDecisionResult['status'],
    runtime: NotebookCommandRuntime | undefined,
    fields: Record<string, unknown> = {}
  ): NotebookNetworkAccessDecisionResult {
    const level = status === 'allowedOnce' || status === 'alwaysAllowed' ? 'info' : 'warn'
    this.log[level]('network access request resolved', {
      status,
      runtime: runtime ?? 'unknown',
      ...fields
    })
    return { hostname, status }
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
