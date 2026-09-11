import { NotebookNetworkSandbox } from '@aipoch/notebook-network-sandbox'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertProcessTreeSupport } from '../process-tree'

import {
  buildNotebookNetworkPolicy,
  notebookNetworkSettingsAllowDomain,
  normalizeNotebookNetworkSettings,
  validateCustomAllowedDomain,
  type NotebookNetworkSettings,
  type NotebookNetworkStatus,
  type NotebookNetworkStatusReason
} from '../../shared/notebook-network'
import { NotebookRuntimeAccessCancelledError } from './process-sandbox'
import { isMigrationInProgress, withDataRootWrite } from '../storage/migration-state'
import type {
  NotebookProcessSandbox,
  NotebookNetworkAccessDecisionRequest,
  NotebookNetworkAccessDecisionResult,
  NotebookSandboxCleanupReason,
  NotebookSandboxCleanupResult,
  NotebookSandboxProcessOutcome,
  NotebookSandboxTarget,
  NotebookSandboxedSpawn,
  NotebookSandboxInvocation
} from './process-sandbox'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import {
  buildNotebookKernelEnvironment,
  normalizeRProcessLocale,
  environmentPathRoots,
  notebookTrustBundleEnvironment
} from './process-environment'
import {
  notebookTrustBundleStatus,
  resolveNotebookTrustBundle,
  type NotebookTrustBundle,
  type NotebookTrustBundleStatus
} from './trust-bundle'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { kernelExecutableReadRoot } from './kernel-executor'
import { windowsCondaPrefixForR } from './environment-discovery'
import { rKernelProtocolProbe } from './r-command'
import {
  condaActivatedPath,
  DEFAULT_R_ENV,
  envPrefix,
  legacyDefaultEnvPrefix,
  rScriptBin
} from './runtime-paths'

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

type PendingCommandCleanup = Readonly<{
  target: NotebookSandboxTarget
  retry: () => Promise<NotebookSandboxCleanupResult>
}>

const sameCleanupDomain = (left: NotebookSandboxTarget, right: NotebookSandboxTarget): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind === 'native') return true
  return right.kind === 'wsl2' && left.distro === right.distro && left.user === right.user
}

const cleanupComplete = (result: NotebookSandboxCleanupResult): boolean =>
  result.processesTerminated && result.networkClosed && result.temporaryResourcesRemoved

const statusLogFields = (status: NotebookNetworkStatus): Record<string, unknown> => {
  switch (status.kind) {
    case 'ready':
      return { kind: status.kind, warningCount: status.warnings.length, warnings: status.warnings }
    case 'setupRequired':
      return {
        kind: status.kind,
        platform: status.platform,
        reasonCount: status.reasons.length,
        reasons: status.reasons
      }
    case 'unsupported':
      return { kind: status.kind, platform: status.platform }
    case 'error':
      return { kind: status.kind, reason: status.reason }
    default:
      return { kind: status.kind }
  }
}

const statusLogLevel = (status: NotebookNetworkStatus): 'error' | 'info' | 'warn' => {
  if (status.kind === 'error') return 'error'
  if (status.kind === 'ready') return 'info'
  return 'warn'
}

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
  allowRuntimeAccessPrompt?: boolean
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
  temporaryRoot?: string
}>

const COMMAND_TEMP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

const completedPreparationCleanupCause = (error: unknown): unknown | undefined => {
  if (
    !(error instanceof Error) ||
    error.name !== 'NotebookSandboxPreparationError' ||
    !('cleanupComplete' in error) ||
    error.cleanupComplete !== true
  ) {
    return undefined
  }
  return error.cause
}

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
  private readonly pendingTemporaryRoots = new Map<string, string>()
  private readonly pendingCommandCleanups = new Set<PendingCommandCleanup>()
  private readonly platform: NodeJS.Platform
  private readonly log: Logger
  private lastStatusSignature: string | undefined
  private runtimeAccessQueue: Promise<void> = Promise.resolve()
  private readonly cancelledRuntimeAccess = new Set<string>()

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
      assertProcessTreeSupport(this.platform)
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
    assertProcessTreeSupport(this.platform)
    await this.initialize()
    const target = invocation.target ?? { kind: 'native' as const }
    await this.reconcilePendingCommandCleanups(target)
    await this.updateTrustBundle()
    const grantedRoots = (await this.options.getGrantedLocalRoots?.()) ?? []
    const { commandTempRoot, receipt } = await this.createCommandTemporaryRoot(target)
    this.pendingTemporaryRoots.set(commandTempRoot, receipt)
    const env = {
      ...invocation.env,
      ...notebookTrustBundleEnvironment(this.trustBundle?.path),
      TMPDIR: commandTempRoot,
      TEMP: commandTempRoot,
      TMP: commandTempRoot
    }
    let activeExecutionGrants: ReadonlySet<string> = new Set()
    let executionActive = false
    const allowedNetworkHosts = new Set(
      (invocation.allowedNetworkHosts ?? []).flatMap((host) => {
        const normalized = validateCustomAllowedDomain(host)
        return normalized.ok ? [normalized.hostname] : []
      })
    )
    let wrapped: Awaited<ReturnType<NotebookNetworkSandbox['wrap']>> | undefined
    try {
      wrapped = await this.sandbox!.wrap({
        target,
        command: commandLine(
          invocation,
          invocation.target?.kind === 'wsl2' ? 'linux' : this.platform
        ),
        ...(this.platform === 'win32' && invocation.target?.kind !== 'wsl2'
          ? { executable: invocation.executable, args: invocation.args }
          : {}),
        cwd: invocation.cwd,
        env,
        ...(invocation.pathEnvironment ? { pathEnvironment: invocation.pathEnvironment } : {}),
        ...(invocation.localRpcSocketPath
          ? { localRpcSocketPath: invocation.localRpcSocketPath }
          : {}),
        ...(invocation.inheritedFileDescriptorCount
          ? { inheritedFileDescriptorCount: invocation.inheritedFileDescriptorCount }
          : {}),
        ...(invocation.superviseProcessTree ? { superviseProcessTree: true } : {}),
        filesystem: {
          privateRoot: homedir(),
          readOnlyRoots: [
            ...invocation.filesystem.readOnlyRoots,
            ...(invocation.target?.kind === 'wsl2' ? [] : environmentPathRoots(env, this.platform)),
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
            allowedNetworkHosts,
            request
          )
      })
      if (target.kind === 'wsl2') {
        // Returning from the runtime certifies guest-receipt reconciliation for this exact profile.
        // Host temp recovery must stay behind that stop-before-remove boundary.
        await this.reconcileCommandTemporaryRoots(target)
      }
      this.log.info('sandbox process prepared', {
        executionReference: invocation.executionReference,
        phase: 'sandbox-prepare',
        result: 'complete',
        platform: this.platform,
        target: invocation.target?.kind ?? 'native',
        runtime: invocation.runtime
      })
    } catch (error) {
      if (wrapped) {
        const cleanup = await wrapped
          .cleanup('spawn-failed', { processesTerminated: true })
          .catch(() => undefined)
        if (!cleanup || !cleanupComplete(cleanup)) {
          throw new Error(
            'SHELL_CLEANUP_INCOMPLETE: Shell preparation cleanup could not be verified.',
            { cause: error }
          )
        }
        try {
          await this.removeCommandTemporaryRoot(commandTempRoot, receipt)
          this.pendingTemporaryRoots.delete(commandTempRoot)
        } catch (cleanupError) {
          throw new Error(
            'SHELL_CLEANUP_INCOMPLETE: Command temporary cleanup could not be verified.',
            { cause: cleanupError }
          )
        }
      }
      const preparationCause = completedPreparationCleanupCause(error)
      if (preparationCause !== undefined) {
        try {
          await this.removeCommandTemporaryRoot(commandTempRoot, receipt)
          this.pendingTemporaryRoots.delete(commandTempRoot)
        } catch (cleanupError) {
          throw new Error(
            'SHELL_CLEANUP_INCOMPLETE: Command temporary cleanup could not be verified.',
            { cause: cleanupError }
          )
        }
      }
      this.log.error('sandbox process preparation failed', {
        platform: this.platform,
        runtime: invocation.runtime,
        ...diagnosticErrorFields(error)
      })
      throw preparationCause ?? error
    }
    if (!wrapped) throw new Error('Notebook network sandbox did not return a process.')
    let cleanupPromise: Promise<NotebookSandboxCleanupResult> | undefined
    let cleanupReason: NotebookSandboxCleanupReason | undefined
    let cleanupOutcome: NotebookSandboxProcessOutcome | undefined
    const pendingCleanup: PendingCommandCleanup = {
      target,
      retry: () => cleanup(cleanupReason!, cleanupOutcome!)
    }
    const cleanup: NotebookSandboxedSpawn['cleanup'] = (reason, processOutcome) => {
      cleanupReason ??= reason
      cleanupOutcome ??= processOutcome
      if (cleanupPromise) return cleanupPromise
      activeExecutionGrants = new Set()
      executionActive = false
      cleanupPromise = (async () => {
        const sandboxCleanup = await Promise.resolve(
          wrapped.cleanup(cleanupReason!, cleanupOutcome!)
        ).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error) => ({ status: 'rejected' as const, reason: error })
        )
        const backendComplete =
          sandboxCleanup.status === 'fulfilled' && cleanupComplete(sandboxCleanup.value)
        const temporaryCleanup = backendComplete
          ? await this.removeCommandTemporaryRoot(commandTempRoot, receipt).then(
              () => ({ status: 'fulfilled' as const }),
              (error) => ({ status: 'rejected' as const, reason: error })
            )
          : { status: 'rejected' as const, reason: new Error('Backend cleanup incomplete.') }
        if (temporaryCleanup.status === 'fulfilled') {
          this.pendingTemporaryRoots.delete(commandTempRoot)
        }
        const result: NotebookSandboxCleanupResult = {
          processesTerminated:
            sandboxCleanup.status === 'fulfilled' && sandboxCleanup.value.processesTerminated,
          networkClosed:
            sandboxCleanup.status === 'fulfilled' && sandboxCleanup.value.networkClosed,
          temporaryResourcesRemoved:
            sandboxCleanup.status === 'fulfilled' &&
            sandboxCleanup.value.temporaryResourcesRemoved &&
            temporaryCleanup.status === 'fulfilled'
        }
        this.log.info('sandbox cleanup completed', {
          executionReference: invocation.executionReference,
          phase: 'sandbox-cleanup',
          result: cleanupComplete(result) ? 'complete' : 'incomplete',
          platform: this.platform,
          target: invocation.target?.kind ?? 'native',
          runtime: invocation.runtime,
          reason: cleanupReason,
          ...result,
          incompleteStageCount: Object.values(result).filter((complete) => !complete).length
        })
        return result
      })()
      cleanupPromise = cleanupPromise.then(
        (result) => {
          if (cleanupComplete(result)) {
            this.pendingCommandCleanups.delete(pendingCleanup)
          } else {
            this.pendingCommandCleanups.add(pendingCleanup)
            cleanupPromise = undefined
          }
          return result
        },
        (error) => {
          cleanupPromise = undefined
          throw error
        }
      )
      return cleanupPromise
    }
    const [executable, ...args] = wrapped.argv
    if (!executable) {
      await cleanup('spawn-failed', { processesTerminated: true })
      throw new Error('Notebook network sandbox returned an empty command.')
    }
    return {
      executable,
      args,
      env: wrapped.env,
      ...(wrapped.confirmProcessTreeTermination
        ? { confirmProcessTreeTermination: wrapped.confirmProcessTreeTermination }
        : {}),
      ...(wrapped.beginSpawn ? { beginSpawn: wrapped.beginSpawn } : {}),
      beginExecution: () => {
        if (cleanupPromise) throw new Error('Notebook sandbox process is already closed.')
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

  async ensureRuntimeAccess(
    request: Pick<NotebookSandboxInvocation, 'runtime' | 'executable' | 'sessionId' | 'signal'>
  ): Promise<void> {
    if (this.platform !== 'win32' || request.runtime !== 'r') return
    if (request.signal?.aborted)
      throw new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.')
    const key = request.sessionId + '\0' + request.executable.toLowerCase()
    let started = false
    const operation = this.runtimeAccessQueue.then(async () => {
      started = true
      if (request.signal?.aborted)
        throw new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.')
      const access = await this.getOrCreateSandbox().getWindowsRuntimeAccess(request.executable)
      if (access.authorized) {
        this.cancelledRuntimeAccess.delete(key)
        return
      }
      if (this.cancelledRuntimeAccess.has(key)) throw new NotebookRuntimeAccessCancelledError()
      if (request.signal?.aborted)
        throw new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.')
      if (isMigrationInProgress())
        throw new Error(
          'Open Science is moving your data. Wait for the move to finish before running this.'
        )
      const result = await withDataRootWrite(async () => {
        if (request.signal?.aborted)
          throw new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.')
        if ((await this.status()).kind !== 'ready')
          throw new Error('Enable protected mode before authorizing R access.')
        if (request.signal?.aborted)
          throw new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.')
        if (await this.verifyWindowsRuntimeAccess(request.executable, true))
          return { cancelled: false }
        if (request.signal?.aborted)
          throw new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.')
        if (!this.options.allowRuntimeAccessPrompt)
          throw new Error(
            'R access requires administrator authorization on the local Open Science desktop.'
          )
        return this.applyWindowsRuntimeAccess(request.executable, true, request.signal)
      })
      if (result.cancelled) this.cancelledRuntimeAccess.add(key)
      if (result.cancelled) throw new NotebookRuntimeAccessCancelledError()
      if (request.signal?.aborted)
        throw new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.')
    })
    this.runtimeAccessQueue = operation.catch(() => undefined)
    const signal = request.signal
    if (!signal) return operation
    // A waiting session can stop immediately. Once elevation starts, keep the native owner and
    // writer lease until its journal is settled; cancellation must not abandon persistent grants.
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (!started)
          reject(new NotebookRuntimeAccessCancelledError('R access preparation was cancelled.'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  async setWindowsRuntimeAccess(
    executable: string,
    authorized: boolean
  ): Promise<{ cancelled: boolean }> {
    const operation = this.runtimeAccessQueue.then(async () => {
      const result = await this.applyWindowsRuntimeAccess(executable, authorized)
      if (!result.cancelled) {
        for (const key of this.cancelledRuntimeAccess) {
          if (key.endsWith('\0' + executable.toLowerCase())) this.cancelledRuntimeAccess.delete(key)
        }
      }
      return result
    })
    this.runtimeAccessQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async applyWindowsRuntimeAccess(
    executable: string,
    authorized: boolean,
    signal?: AbortSignal
  ): Promise<{ cancelled: boolean }> {
    if (!authorized) return this.getOrCreateSandbox().setWindowsRuntimeAccess(executable, false)
    try {
      await this.verifyWindowsRuntimeAccess(executable, false, { signal })
      return { cancelled: false }
    } catch (error) {
      if (error instanceof NotebookRuntimeAccessCancelledError) return { cancelled: true }
      throw error
    }
  }

  private async verifyWindowsRuntimeAccess(
    executable: string,
    pathsOnly = false,
    authorization?: { signal?: AbortSignal }
  ): Promise<boolean> {
    if ((await this.status()).kind !== 'ready')
      throw new Error('Enable protected mode before verifying R access.')
    const prefix = windowsCondaPrefixForR(executable, this.platform)
    const env = {
      ...normalizeRProcessLocale(buildNotebookKernelEnvironment(this.platform), this.platform),
      ...(prefix ? { PATH: condaActivatedPath(prefix, process.env.PATH, this.platform) } : {})
    }
    const cwd = await mkdtemp(join(tmpdir(), 'open-science-r-access-'))
    let invocation: NotebookSandboxedSpawn | undefined
    let endExecution: (() => void) | undefined
    let probeMayHaveStarted = false
    let verificationError: unknown
    let verified = false
    try {
      invocation = await this.wrap({
        executable,
        args: [
          '--vanilla',
          '-e',
          pathsOnly
            ? 'paths <- c(.Library, file.path(.Library, "compiler")); failed <- vapply(paths, function(p) inherits(try(normalizePath(p, mustWork=TRUE), silent=TRUE), "try-error"), logical(1)); if (any(failed)) { cat(paste(paths[failed], collapse="\\n")); quit(status=77) }; cat("OPEN_SCIENCE_R_ACCESS_OK")'
            : 'stopifnot(requireNamespace("jsonlite", quietly=TRUE)); normalizePath(.libPaths(), mustWork=TRUE); cat("OPEN_SCIENCE_R_ACCESS_OK")'
        ],
        cwd,
        // Only the contained path probe suppresses startup packages. Host readiness and full
        // post-authorization verification must exercise ordinary R startup and dependencies.
        env: {
          ...env,
          ...(pathsOnly ? { R_DEFAULT_PACKAGES: 'NULL', R_ENABLE_JIT: '0' } : {})
        },
        commandText: 'Verify selected R runtime',
        runtime: 'r',
        sessionId: 'runtime-access-check',
        projectId: 'runtime-access-check',
        filesystem: {
          readOnlyRoots: [kernelExecutableReadRoot(executable, 'r', this.platform)],
          readWriteRoots: [cwd],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      endExecution = invocation.beginExecution?.()
      if (authorization) {
        probeMayHaveStarted = true
        const result = await this.getOrCreateSandbox().setWindowsRuntimeAccess(executable, true, {
          argv: [invocation.executable, ...invocation.args],
          env: invocation.env,
          ...(authorization.signal ? { signal: authorization.signal } : {})
        })
        if (result.cancelled) {
          // The adapter reports cancellation only before the contained probe starts. Once the
          // elevated transaction starts, a failed/aborted verifier is an error requiring cleanup.
          probeMayHaveStarted = false
          throw new NotebookRuntimeAccessCancelledError()
        }
      } else {
        probeMayHaveStarted = true
        const { stdout } = await promisify(execFile)(invocation.executable, [...invocation.args], {
          cwd,
          env: invocation.env,
          // This bounds the native host, including ACL preparation and rollback, rather
          // than only R execution. Live kernels can make directory propagation exceed 20s.
          timeout: 60_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        })
        if (!stdout.includes('OPEN_SCIENCE_R_ACCESS_OK'))
          throw new Error('R runtime verification did not complete.')
      }
      verified = true
    } catch (error) {
      verificationError = error
      const failure = error as { code?: number; stdout?: string }
      if (pathsOnly && failure.code === 77 && failure.stdout?.trim()) {
        const paths = failure.stdout.trim().split(/\r?\n/)
        if (paths.length <= 2) {
          try {
            // Host readability and protocol readiness distinguish denied access from a broken R.
            await Promise.all(paths.map((path) => realpath(path)))
            const runnable = await rKernelProtocolProbe({
              exec: (args) =>
                promisify(execFile)(executable, ['--vanilla', ...args], {
                  cwd,
                  env,
                  timeout: 20_000,
                  windowsHide: true,
                  maxBuffer: 1024 * 1024
                })
            })
            if (!runnable) throw new Error('The R kernel protocol dependencies failed to load.')
            verificationError = undefined
          } catch (hostError) {
            verificationError = hostError
          }
        }
      }
    } finally {
      endExecution?.()
    }
    const confirmTermination = invocation?.confirmProcessTreeTermination
    const processesTerminated =
      !probeMayHaveStarted || (await confirmTermination?.().catch(() => false)) === true
    const cleanup = await invocation?.cleanup('exit', {
      processesTerminated,
      ...(confirmTermination ? { confirmTermination } : {})
    })
    if (cleanup && !cleanupComplete(cleanup)) {
      throw new Error('R runtime verification cleanup could not be confirmed.', {
        cause: verificationError
      })
    }
    // Windows can retain directory handles briefly after the probe's process tree has exited.
    // Retry only after termination and sandbox cleanup are confirmed; persistent locks still fail.
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (verificationError !== undefined) throw verificationError
    return verified
  }

  // The caller has stopped the affected kernels and holds repair/migration admission. Revoke while
  // the exact old directories still exist so the native owner can remove every recorded ACL.
  async revokeManagedRAccess(runtimeRoot: string): Promise<void> {
    if (!this.supportsWindowsRuntimeAccess) return
    // A damaged legacy interpreter can make discovery fall back to the short layout. Keep the
    // original exact path addressable; the native owner removes only its recorded permissions.
    const prefixes = new Set([
      envPrefix(runtimeRoot, DEFAULT_R_ENV, this.platform),
      legacyDefaultEnvPrefix(runtimeRoot, DEFAULT_R_ENV)
    ])
    for (const prefix of prefixes) {
      const result = await this.setWindowsRuntimeAccess(rScriptBin(prefix, this.platform), false)
      if (result.cancelled) {
        throw new Error(
          'R permission removal was cancelled; the existing runtime must be preserved.'
        )
      }
    }
  }

  get supportsWindowsRuntimeAccess(): boolean {
    return this.platform === 'win32'
  }

  async dispose(): Promise<void> {
    await this.runtimeAccessQueue
    this.cancelledRuntimeAccess.clear()
    await this.initializePromise?.catch(() => undefined)
    try {
      await this.sandbox?.dispose()
      for (const [root, receipt] of this.pendingTemporaryRoots) {
        await this.removeCommandTemporaryRoot(root, receipt)
        this.pendingTemporaryRoots.delete(root)
      }
      this.pendingCommandCleanups.clear()
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
    const level = statusLogLevel(status)
    this.log[level]('sandbox status changed', { ...statusLogFields(status), ...extraFields })
    return status
  }

  private async reconcilePendingCommandCleanups(target: NotebookSandboxTarget): Promise<void> {
    const pending = [...this.pendingCommandCleanups].filter((cleanup) =>
      sameCleanupDomain(cleanup.target, target)
    )
    if (pending.length === 0) return
    const results = await Promise.all(pending.map((cleanup) => cleanup.retry()))
    if (results.some((result) => !cleanupComplete(result))) {
      throw new Error('SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.')
    }
  }

  private commandTemporaryRoot(): string {
    return this.options.temporaryRoot ?? join(tmpdir(), 'open-science-notebook')
  }

  private async createCommandTemporaryRoot(
    target: NonNullable<NotebookSandboxInvocation['target']>
  ): Promise<{
    commandTempRoot: string
    receipt: string
  }> {
    const ownerRoot = this.commandTemporaryRoot()
    const id = randomUUID()
    const commandTempRoot = join(ownerRoot, `command-${id}`)
    const receipt = join(ownerRoot, `command-${id}.receipt`)
    await mkdir(ownerRoot, { recursive: true, mode: 0o700 })
    const ownership =
      target.kind === 'wsl2'
        ? `wsl2 ${encodeURIComponent(target.profileId)} ${encodeURIComponent(target.distro)} ${encodeURIComponent(target.user)}`
        : 'native'
    await writeFile(receipt, `v1 command-${id} ${ownership}\n`, { flag: 'wx', mode: 0o600 })
    try {
      await mkdir(commandTempRoot, { mode: 0o700 })
    } catch (error) {
      await rm(receipt, { force: true }).catch(() => undefined)
      throw error
    }
    return { commandTempRoot, receipt }
  }

  private async removeCommandTemporaryRoot(root: string, receipt: string): Promise<void> {
    await rm(root, { recursive: true, force: true })
    await rm(receipt, { force: true })
  }

  private async reconcileCommandTemporaryRoots(
    target: Extract<NonNullable<NotebookSandboxInvocation['target']>, { kind: 'wsl2' }>
  ): Promise<void> {
    const ownerRoot = this.commandTemporaryRoot()
    await mkdir(ownerRoot, { recursive: true, mode: 0o700 })
    const entries = await readdir(ownerRoot, { withFileTypes: true })
    const receipts = new Map<string, { receipt: string; matchesTarget: boolean }>()
    for (const entry of entries) {
      const match = /^command-(.+)\.receipt$/u.exec(entry.name)
      if (!match) continue
      const id = match[1]!
      if (!entry.isFile() || !COMMAND_TEMP_ID.test(id)) {
        throw new Error('SHELL_CLEANUP_INCOMPLETE: Command temporary receipt is invalid.')
      }
      const receipt = join(ownerRoot, entry.name)
      const fields = (await readFile(receipt, 'utf8')).match(
        /^v1 command-([0-9a-f-]{36}) (native|wsl2 ([^ ]+) ([^ ]+) ([^ \r\n]+))\n$/u
      )
      if (!fields || fields[1] !== id) {
        throw new Error('SHELL_CLEANUP_INCOMPLETE: Command temporary receipt is invalid.')
      }
      let matchesTarget = false
      if (fields[2] !== 'native') {
        try {
          const profileId = decodeURIComponent(fields[3]!)
          const distro = decodeURIComponent(fields[4]!)
          const user = decodeURIComponent(fields[5]!)
          if (
            encodeURIComponent(profileId) !== fields[3] ||
            encodeURIComponent(distro) !== fields[4] ||
            encodeURIComponent(user) !== fields[5]
          ) {
            throw new Error('non-canonical ownership')
          }
          matchesTarget =
            profileId === target.profileId && distro === target.distro && user === target.user
        } catch {
          throw new Error('SHELL_CLEANUP_INCOMPLETE: Command temporary receipt is invalid.')
        }
      }
      receipts.set(id, { receipt, matchesTarget })
    }
    for (const entry of entries) {
      const match = /^command-(.+)$/u.exec(entry.name)
      if (!match || entry.name.endsWith('.receipt')) continue
      const id = match[1]!
      if (!entry.isDirectory() || !COMMAND_TEMP_ID.test(id) || !receipts.has(id)) {
        throw new Error('SHELL_CLEANUP_INCOMPLETE: Command temporary ownership is incomplete.')
      }
    }
    for (const [id, ownership] of receipts) {
      const root = join(ownerRoot, `command-${id}`)
      // Native children can outlive the Electron parent, so a restart does not prove they stopped.
      // Their roots stay retained; only same-process verified cleanup may remove them.
      if (!ownership.matchesTarget || this.pendingTemporaryRoots.has(root)) continue
      await this.removeCommandTemporaryRoot(root, ownership.receipt)
    }
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
    allowedNetworkHosts: ReadonlySet<string>,
    request: { host: string; signal: AbortSignal }
  ): Promise<boolean> {
    if (request.signal.aborted) return Promise.resolve(false)
    const normalized = validateCustomAllowedDomain(request.host)
    if (!normalized.ok || !executionActive) return Promise.resolve(false)
    if (allowedNetworkHosts.has(normalized.hostname)) return Promise.resolve(true)
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
