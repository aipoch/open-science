import { randomUUID } from 'node:crypto'

import {
  NotebookNetworkRuntime,
  installWindows,
  setWindowsRuntimeAccess,
  removeWindows,
  statusForPlatform,
  type SandboxDependencyCheck,
  type WindowsShell
} from '../runtime/src/index.js'

import { createRuntimeConfig, normalizePolicy } from './config.js'
import type {
  NotebookNetworkParentProxy,
  NotebookNetworkPolicy,
  NotebookNetworkSandboxOptions,
  NotebookNetworkSandboxStatus,
  NotebookSandboxCleanupResult,
  NotebookSandboxProcessOutcome,
  NotebookSandboxCommand,
  NotebookSandboxedProcess,
  NotebookSandboxTarget
} from './types.js'

let activeOwnerToken: symbol | undefined

class NotebookSandboxPreparationError extends Error {
  readonly cleanupComplete = true

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'NotebookSandboxPreparationError'
  }
}

type ActiveCommand = {
  target: NotebookSandboxTarget
  onNetworkAccessRequest: NotebookSandboxCommand['onNetworkAccessRequest']
  controller: AbortController
  preparation: Promise<void>
  prepared: boolean
  detachSignal?: () => void
  cleanupRequest?: Readonly<{
    reason: 'exit' | 'cancel' | 'timeout' | 'spawn-failed'
    processOutcome: NotebookSandboxProcessOutcome
  }>
}

const normalizedTarget = (target: NotebookSandboxTarget | undefined): NotebookSandboxTarget =>
  target?.kind === 'wsl2'
    ? {
        kind: 'wsl2',
        profileId: target.profileId,
        distro: target.distro,
        user: target.user
      }
    : { kind: 'native' }

const sharesCleanupDomain = (
  left: NotebookSandboxTarget,
  right: NotebookSandboxTarget
): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind === 'native' || right.kind === 'native') return true
  return left.distro === right.distro && left.user === right.user
}

const cleanupComplete = (result: NotebookSandboxCleanupResult): boolean =>
  result.processesTerminated && result.networkClosed && result.temporaryResourcesRemoved

const initializationFailureReason = (
  status: Exclude<NotebookNetworkSandboxStatus, { kind: 'ready' }>
): string => {
  if (status.kind === 'setupRequired') return status.reasons.join('; ')
  if (status.kind === 'unsupported') return `unsupported platform: ${status.platform}`
  return status.message
}

const dependencyStatus = (
  platform: NodeJS.Platform,
  result: SandboxDependencyCheck
): NotebookNetworkSandboxStatus => {
  if (result.errors.length === 0) return { kind: 'ready', warnings: result.warnings }
  if (platform === 'linux' || platform === 'win32') {
    return { kind: 'setupRequired', platform, reasons: result.errors }
  }
  return { kind: 'error', message: result.errors.join('\n') }
}

class NotebookNetworkSandbox {
  readonly #backend = NotebookNetworkRuntime
  readonly #ownerToken = Symbol('NotebookNetworkSandbox owner')
  #options: NotebookNetworkSandboxOptions
  #initialized = false
  #initializing: Promise<void> | undefined
  readonly #activeCommands = new Map<string, ActiveCommand>()

  constructor(options: NotebookNetworkSandboxOptions) {
    this.#options = options
  }

  async status(
    platform: NodeJS.Platform = process.platform
  ): Promise<NotebookNetworkSandboxStatus> {
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
      return { kind: 'unsupported', platform }
    }

    try {
      const config = createRuntimeConfig(this.#options)
      const result =
        platform === 'win32' && process.platform === 'win32' && this.#initialized
          ? await this.#backend.refreshWindowsProtection()
          : await statusForPlatform(platform, config)
      return dependencyStatus(platform, result)
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return
    if (this.#initializing) return this.#initializing
    if (activeOwnerToken && activeOwnerToken !== this.#ownerToken) {
      throw new Error('Only one Notebook network sandbox owner may be active in a process.')
    }

    activeOwnerToken = this.#ownerToken
    this.#initializing = (async () => {
      const status = await this.status()
      if (status.kind !== 'ready' && process.platform !== 'win32') {
        throw new Error(
          `Notebook network sandbox is not ready: ${initializationFailureReason(status)}`
        )
      }

      await this.#backend.initialize(createRuntimeConfig(this.#options), async (request) => {
        const command = request.commandId ? this.#activeCommands.get(request.commandId) : undefined
        if (!command || command.controller.signal.aborted) return false
        try {
          const allowed = await command.onNetworkAccessRequest({
            host: request.host,
            ...(request.port === undefined ? {} : { port: request.port }),
            signal: command.controller.signal
          })
          return !command.controller.signal.aborted && allowed
        } catch {
          return false
        }
      })
      this.#initialized = true
    })()
    try {
      await this.#initializing
    } catch (error) {
      activeOwnerToken = undefined
      throw error
    } finally {
      this.#initializing = undefined
    }
  }

  async wrap(command: NotebookSandboxCommand): Promise<NotebookSandboxedProcess> {
    if (!this.#initialized) throw new Error('Notebook network sandbox is not initialized.')
    const target = normalizedTarget(command.target)
    await this.#reconcilePendingCommands(target)
    const commandId = randomUUID()
    const shell = command.shell as string | WindowsShell | undefined
    const controller = new AbortController()
    const abort = (): void => controller.abort(command.signal?.reason)
    if (command.signal?.aborted) abort()
    else command.signal?.addEventListener('abort', abort, { once: true })
    let finishPreparation!: () => void
    const activeCommand: ActiveCommand = {
      target,
      onNetworkAccessRequest: command.onNetworkAccessRequest,
      controller,
      preparation: new Promise<void>((resolve) => (finishPreparation = resolve)),
      prepared: false,
      ...(command.signal
        ? { detachSignal: () => command.signal?.removeEventListener('abort', abort) }
        : {})
    }
    this.#activeCommands.set(commandId, activeCommand)
    let wrapped: Awaited<ReturnType<typeof NotebookNetworkRuntime.wrap>>
    try {
      wrapped = await this.#backend.wrap({
        target,
        command: command.command,
        ...(command.executable ? { executable: command.executable, args: command.args ?? [] } : {}),
        commandId,
        ...(shell ? { shell } : {}),
        cwd: command.cwd,
        env: command.env ?? {},
        ...(command.pathEnvironment ? { pathEnvironment: command.pathEnvironment } : {}),
        ...(command.localRpcSocketPath ? { localRpcSocketPath: command.localRpcSocketPath } : {}),
        ...(command.inheritedFileDescriptorCount
          ? { inheritedFileDescriptorCount: command.inheritedFileDescriptorCount }
          : {}),
        ...(command.superviseProcessTree ? { superviseProcessTree: true } : {}),
        signal: controller.signal,
        filesystem: command.filesystem ?? {
          readOnlyRoots: [command.cwd],
          readWriteRoots: [command.cwd],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      activeCommand.prepared = true
    } catch (error) {
      const cleanup = await this.#releaseCommand(
        commandId,
        { processesTerminated: true },
        'spawn-failed'
      ).catch(() => undefined)
      if (!cleanup || !cleanupComplete(cleanup)) {
        throw new Error(
          'SHELL_CLEANUP_INCOMPLETE: Shell preparation cleanup could not be verified.',
          { cause: error }
        )
      }
      throw new NotebookSandboxPreparationError(error)
    } finally {
      finishPreparation()
    }
    let cleanupPromise: Promise<NotebookSandboxCleanupResult> | undefined
    return {
      argv: wrapped.argv,
      env: wrapped.env,
      ...(wrapped.confirmProcessTreeTermination
        ? { confirmProcessTreeTermination: wrapped.confirmProcessTreeTermination }
        : {}),
      ...(wrapped.beginSpawn ? { beginSpawn: wrapped.beginSpawn } : {}),
      annotateStderr: (stderr) => this.#backend.annotateStderr(commandId, stderr),
      resetNetworkConnections: () => this.#backend.resetCommandConnections(commandId),
      cleanup: (reason, processOutcome) => {
        if (cleanupPromise) return cleanupPromise
        cleanupPromise = this.#releaseCommand(commandId, processOutcome, reason).then(
          (result) => {
            if (!cleanupComplete(result)) cleanupPromise = undefined
            return result
          },
          (error) => {
            cleanupPromise = undefined
            throw error
          }
        )
        return cleanupPromise
      }
    }
  }

  updatePolicy(policy: NotebookNetworkPolicy): void {
    this.updateConfiguration({ policy })
  }

  updateConfiguration(
    update: Readonly<{
      policy?: NotebookNetworkPolicy
      parentProxy?: NotebookNetworkParentProxy | null
      trustBundle?: NotebookNetworkSandboxOptions['trustBundle'] | null
    }>
  ): void {
    if (!this.#initialized) throw new Error('Notebook network sandbox is not initialized.')
    let nextOptions: NotebookNetworkSandboxOptions = {
      ...this.#options,
      ...(update.policy ? { policy: normalizePolicy(update.policy) } : {})
    }
    if ('parentProxy' in update) {
      if (update.parentProxy) nextOptions = { ...nextOptions, parentProxy: update.parentProxy }
      else {
        nextOptions = {
          policy: nextOptions.policy,
          resources: nextOptions.resources,
          ...(nextOptions.trustBundle ? { trustBundle: nextOptions.trustBundle } : {})
        }
      }
    }
    if ('trustBundle' in update) {
      if (update.trustBundle) nextOptions = { ...nextOptions, trustBundle: update.trustBundle }
      else {
        nextOptions = {
          policy: nextOptions.policy,
          resources: nextOptions.resources,
          ...(nextOptions.parentProxy ? { parentProxy: nextOptions.parentProxy } : {})
        }
      }
    }
    this.#options = nextOptions
    this.#backend.updateConfig(createRuntimeConfig(nextOptions))
  }

  async installWindows(): Promise<{ cancelled: boolean }> {
    if (process.platform !== 'win32') {
      throw new Error('Windows sandbox installation is only available on Windows.')
    }
    if (this.#initializing) await this.#initializing
    const config = createRuntimeConfig(this.#options)
    const result = await installWindows(config)
    if (!result.cancelled && this.#initialized) await this.#backend.refreshWindowsProtection()
    return { cancelled: result.cancelled === true }
  }

  async setWindowsRuntimeAccess(
    executable: string,
    authorized: boolean
  ): Promise<{ cancelled: boolean }> {
    if (process.platform !== 'win32')
      throw new Error('R runtime access is only available on Windows.')
    if (this.#initializing) await this.#initializing
    return setWindowsRuntimeAccess(createRuntimeConfig(this.#options), executable, authorized)
  }

  async removeWindows(): Promise<{ cancelled: boolean }> {
    if (process.platform !== 'win32') {
      throw new Error('Windows sandbox removal is only available on Windows.')
    }
    if (this.#initializing) await this.#initializing
    const result = await removeWindows(createRuntimeConfig(this.#options))
    if (!result.cancelled && this.#initialized) await this.#backend.refreshWindowsProtection()
    return result
  }

  async dispose(): Promise<void> {
    if (this.#initializing) await this.#initializing
    if (!this.#initialized) return
    const preparing = [...this.#activeCommands.values()]
    for (const command of preparing) {
      if (!command.controller.signal.aborted) {
        command.detachSignal?.()
        command.controller.abort(new Error('Notebook process ended.'))
      }
    }
    await Promise.all(preparing.map((command) => command.preparation))
    const results = await Promise.all(
      [...this.#activeCommands.entries()].map(([commandId, command]) =>
        this.#releaseCommand(commandId, { processesTerminated: !command.prepared })
      )
    )
    if (results.some((result) => !cleanupComplete(result))) {
      throw new Error('Notebook network sandbox cleanup was incomplete.')
    }
    try {
      await this.#backend.reset()
      this.#initialized = false
    } finally {
      if (!this.#initialized && activeOwnerToken === this.#ownerToken) activeOwnerToken = undefined
    }
  }

  #releaseCommand(
    commandId: string,
    processOutcome: NotebookSandboxProcessOutcome,
    reason: 'exit' | 'cancel' | 'timeout' | 'spawn-failed' = 'cancel'
  ): Promise<NotebookSandboxCleanupResult> {
    const command = this.#activeCommands.get(commandId)
    if (!command) {
      return Promise.resolve({
        processesTerminated: processOutcome.processesTerminated,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    }
    if (!command.controller.signal.aborted) {
      command.detachSignal?.()
      command.controller.abort(new Error('Notebook process ended.'))
    }
    command.cleanupRequest ??= { reason, processOutcome }
    return this.#backend
      .cleanupAfterCommand(
        commandId,
        command.cleanupRequest.reason,
        command.cleanupRequest.processOutcome
      )
      .then((result) => {
        if (cleanupComplete(result)) this.#forgetCommand(commandId)
        return result
      })
  }

  async #reconcilePendingCommands(target: NotebookSandboxTarget): Promise<void> {
    const pending = [...this.#activeCommands.entries()].filter(
      ([, command]) =>
        Boolean(command.cleanupRequest) && sharesCleanupDomain(command.target, target)
    )
    if (pending.length === 0) return
    const results = await Promise.all(
      pending.map(([commandId, command]) =>
        this.#releaseCommand(
          commandId,
          command.cleanupRequest!.processOutcome,
          command.cleanupRequest!.reason
        )
      )
    )
    if (results.some((result) => !cleanupComplete(result))) {
      throw new Error('SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.')
    }
  }

  #forgetCommand(commandId: string): void {
    const command = this.#activeCommands.get(commandId)
    command?.detachSignal?.()
    this.#activeCommands.delete(commandId)
  }
}

export { NotebookNetworkSandbox, NotebookSandboxPreparationError }
// Shared transport accepts an already validated numeric destination, preserving DNS pinning.
export { tunnelThroughProxy } from '../runtime/src/gateway/command-gateway.js'
export type {
  NotebookNetworkAccessRequest,
  NotebookNetworkDecisionHandler,
  NotebookNetworkParentProxy,
  NotebookFilesystemPolicy,
  NotebookNetworkPolicy,
  NotebookNetworkSandboxOptions,
  NotebookNetworkSandboxStatus,
  NotebookSandboxCommand,
  NotebookSandboxCleanupReason,
  NotebookSandboxCleanupResult,
  NotebookSandboxProcessOutcome,
  NotebookSandboxTarget,
  NotebookSandboxResources,
  NotebookSandboxedProcess,
  NotebookTrustBundle
} from './types.js'
