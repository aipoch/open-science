import { randomUUID } from 'node:crypto'

import {
  NotebookNetworkRuntime,
  installWindows,
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
  NotebookSandboxCommand,
  NotebookSandboxedProcess
} from './types.js'

let activeOwnerToken: symbol | undefined

type ActiveCommand = Readonly<{
  onNetworkAccessRequest: NotebookSandboxCommand['onNetworkAccessRequest']
  controller: AbortController
  detachSignal?: () => void
}>

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
        const reason =
          status.kind === 'setupRequired'
            ? status.reasons.join('; ')
            : status.kind === 'unsupported'
              ? `unsupported platform: ${status.platform}`
              : status.message
        throw new Error(`Notebook network sandbox is not ready: ${reason}`)
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
    const commandId = randomUUID()
    const shell = command.shell as string | WindowsShell | undefined
    let wrapped: Awaited<ReturnType<typeof NotebookNetworkRuntime.wrap>>
    try {
      wrapped = await this.#backend.wrap({
        command: command.command,
        commandId,
        ...(shell ? { shell } : {}),
        cwd: command.cwd,
        env: command.env ?? {},
        ...(command.localRpcSocketPath ? { localRpcSocketPath: command.localRpcSocketPath } : {}),
        ...(command.inheritedFileDescriptorCount
          ? { inheritedFileDescriptorCount: command.inheritedFileDescriptorCount }
          : {}),
        filesystem: command.filesystem ?? {
          readOnlyRoots: [command.cwd],
          readWriteRoots: [command.cwd],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
    } catch (error) {
      this.#backend.cleanupAfterCommand(commandId)
      throw error
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort(command.signal?.reason)
    if (command.signal?.aborted) abort()
    else command.signal?.addEventListener('abort', abort, { once: true })
    this.#activeCommands.set(commandId, {
      onNetworkAccessRequest: command.onNetworkAccessRequest,
      controller,
      ...(command.signal
        ? { detachSignal: () => command.signal?.removeEventListener('abort', abort) }
        : {})
    })
    return {
      argv: wrapped.argv,
      env: wrapped.env,
      annotateStderr: (stderr) => this.#backend.annotateStderr(commandId, stderr),
      resetNetworkConnections: () => this.#backend.resetCommandConnections(commandId),
      cleanup: () => this.#releaseCommand(commandId, true)
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
    this.#initialized = false
    for (const commandId of this.#activeCommands.keys()) this.#releaseCommand(commandId, false)
    try {
      await this.#backend.reset()
    } finally {
      if (activeOwnerToken === this.#ownerToken) activeOwnerToken = undefined
    }
  }

  #releaseCommand(commandId: string, cleanupBackend: boolean): void {
    const command = this.#activeCommands.get(commandId)
    if (!command) return
    this.#activeCommands.delete(commandId)
    command.detachSignal?.()
    command.controller.abort(new Error('Notebook process ended.'))
    if (cleanupBackend) this.#backend.cleanupAfterCommand(commandId)
  }
}

export { NotebookNetworkSandbox }
export type {
  NotebookNetworkAccessRequest,
  NotebookNetworkDecisionHandler,
  NotebookNetworkParentProxy,
  NotebookFilesystemPolicy,
  NotebookNetworkPolicy,
  NotebookNetworkSandboxOptions,
  NotebookNetworkSandboxStatus,
  NotebookSandboxCommand,
  NotebookSandboxResources,
  NotebookSandboxedProcess,
  NotebookTrustBundle
} from './types.js'
