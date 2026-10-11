import type { ComputeHost } from '@aipoch/compute'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  buildScpUploadArgs,
  resolveScpBinary,
  resolveSshTarget,
  type BoundedScpResult,
  type ResolvedSshTarget,
  type ScpRunner,
  type SshRunner
} from '@aipoch/compute/node'

import {
  classifyConnectionFailure,
  ComputeConnectionError,
  type AcquireComputeConnectionRequest,
  type ComputeConnectionAdapter,
  type ComputeConnectionLease
} from '@aipoch/compute/node'
interface ComputeConnectionBroker {
  acquire(
    providerId: string,
    request: AcquireComputeConnectionRequest
  ): Promise<ComputeConnectionLease>
  clearAuthenticationFailure?(providerId: string): Promise<void>
  invalidateAuthenticationIdentity?(providerId: string): void
  beginHostDeletion(providerId: string): Promise<void>
  abortHostDeletion(providerId: string): void
  completeHostDeletion(providerId: string): void
}
type SshConfigComputeConnectionBrokerDependencies = Readonly<{
  getHost(providerId: string): Promise<ComputeHost | null>
  runner: SshRunner
  scpRunner?: ScpRunner
  resolveTarget?: (
    alias: string,
    overrides: ComputeHost['sshOverrides']
  ) => Promise<ResolvedSshTarget>
  passwordAdapter?: ComputeConnectionAdapter
  persistAuthenticationFailure?: (host: ComputeHost) => Promise<void>
  clearPersistedAuthenticationFailure?: (providerId: string) => Promise<void>
  reportAuthenticationFailurePersistenceError?: (error: unknown) => void
}>

/**
 * Compatibility Broker for the existing SSH-configuration authentication path.
 *
 * The Probe owner supplies only a registered Host identity and operation intent. Resolution and
 * transport stay behind this seam, so later authentication adapters can be introduced without
 * teaching Probe how credentials are selected. This implementation deliberately delegates to the
 * existing resolver and runner without reclassifying their results.
 */
class SshConfigComputeConnectionBroker implements ComputeConnectionBroker {
  private readonly authenticationFailures = new Map<string, string>()
  private readonly authenticationFailurePersistence = new Map<string, Promise<void>>()
  private readonly backgroundAuthenticationTails = new Map<string, Promise<void>>()
  private readonly deletingHosts = new Set<string>()
  private readonly hostGenerations = new Map<string, number>()
  private readonly generationInvalidationCodes = new Map<
    string,
    'credential_conflict' | 'credential_unavailable'
  >()
  private readonly activeOperations = new Map<string, number>()
  private readonly drainWaiters = new Map<string, Set<() => void>>()

  constructor(private readonly dependencies: SshConfigComputeConnectionBrokerDependencies) {}

  async clearAuthenticationFailure(providerId: string): Promise<void> {
    this.authenticationFailures.delete(providerId)
    await this.serializeAuthenticationFailurePersistence(providerId, async () => {
      await this.dependencies.clearPersistedAuthenticationFailure?.(providerId)
    })
  }

  async beginHostDeletion(providerId: string): Promise<void> {
    this.deletingHosts.add(providerId)
    this.hostGenerations.set(providerId, (this.hostGenerations.get(providerId) ?? 0) + 1)
    this.generationInvalidationCodes.set(providerId, 'credential_unavailable')
    if ((this.activeOperations.get(providerId) ?? 0) === 0) return
    await new Promise<void>((resolve) => {
      const waiters = this.drainWaiters.get(providerId) ?? new Set<() => void>()
      waiters.add(resolve)
      this.drainWaiters.set(providerId, waiters)
    })
  }

  invalidateAuthenticationIdentity(providerId: string): void {
    this.hostGenerations.set(providerId, (this.hostGenerations.get(providerId) ?? 0) + 1)
    this.generationInvalidationCodes.set(providerId, 'credential_conflict')
  }

  abortHostDeletion(providerId: string): void {
    this.deletingHosts.delete(providerId)
  }

  completeHostDeletion(providerId: string): void {
    this.deletingHosts.delete(providerId)
  }

  private assertGenerationCurrent(providerId: string, generation: number): void {
    if (this.deletingHosts.has(providerId)) {
      throw new ComputeConnectionError(
        'credential_unavailable',
        'This Compute Host is being removed and cannot accept new connections.'
      )
    }
    if ((this.hostGenerations.get(providerId) ?? 0) !== generation) {
      const code = this.generationInvalidationCodes.get(providerId) ?? 'credential_conflict'
      throw new ComputeConnectionError(
        code,
        code === 'credential_unavailable'
          ? 'This Compute Host is being removed and cannot accept new connections.'
          : undefined
      )
    }
  }

  private guardLease(
    providerId: string,
    generation: number,
    lease: ComputeConnectionLease
  ): ComputeConnectionLease {
    return {
      run: (remoteCommand, options) =>
        this.withActiveOperation(providerId, generation, () => lease.run(remoteCommand, options)),
      upload: (localPath, remotePath) =>
        this.withActiveOperation(providerId, generation, () => lease.upload(localPath, remotePath)),
      download: (remotePath, localPath, maxBytes) =>
        this.withActiveOperation(providerId, generation, () =>
          lease.download(remotePath, localPath, maxBytes)
        ),
      ...(lease.redactSensitiveOutputs
        ? {
            redactSensitiveOutputs: (values: readonly string[]) =>
              lease.redactSensitiveOutputs!(values)
          }
        : {})
    }
  }

  private async withActiveOperation<Result>(
    providerId: string,
    generation: number,
    operation: () => Promise<Result>
  ): Promise<Result> {
    this.assertGenerationCurrent(providerId, generation)
    this.activeOperations.set(providerId, (this.activeOperations.get(providerId) ?? 0) + 1)
    try {
      return await operation()
    } finally {
      const remaining = (this.activeOperations.get(providerId) ?? 1) - 1
      if (remaining > 0) this.activeOperations.set(providerId, remaining)
      else {
        this.activeOperations.delete(providerId)
        const waiters = this.drainWaiters.get(providerId)
        this.drainWaiters.delete(providerId)
        for (const resolve of waiters ?? []) resolve()
      }
    }
  }

  async acquire(
    providerId: string,
    request: AcquireComputeConnectionRequest
  ): Promise<ComputeConnectionLease> {
    request.signal?.throwIfAborted()
    const generation = this.hostGenerations.get(providerId) ?? 0
    this.assertGenerationCurrent(providerId, generation)
    const host = await this.dependencies.getHost(providerId)
    this.assertGenerationCurrent(providerId, generation)
    if (!host) throw new Error(`No compute host found with provider id "${providerId}".`)
    const authenticationGeneration = `${host.id}:${host.authentication?.revision ?? 0}`
    const persistedAuthenticationFailure =
      host.probeResult?.authenticationCode === 'authentication_failed' &&
      host.probeResult.authenticationRevision === (host.authentication?.revision ?? 0)
    const isBackgroundAuthentication =
      request.intent === 'job_poll' || request.intent === 'job_harvest'
    if (
      isBackgroundAuthentication &&
      (this.authenticationFailures.get(providerId) === authenticationGeneration ||
        persistedAuthenticationFailure)
    ) {
      throw new ComputeConnectionError('authentication_failed')
    }
    const authenticationMode = host.authentication?.mode ?? 'ssh_config'
    if (authenticationMode !== 'ssh_config' && authenticationMode !== 'password') {
      throw new ComputeConnectionError('unsupported_auth_configuration')
    }
    if (authenticationMode === 'password') {
      if (!this.dependencies.passwordAdapter) {
        throw new ComputeConnectionError('unsupported_auth_configuration')
      }
      try {
        const lease = await this.dependencies.passwordAdapter.acquire(host, request)
        this.assertGenerationCurrent(providerId, generation)
        return this.guardLease(
          providerId,
          generation,
          this.observeAuthentication(providerId, authenticationGeneration, host, request, lease)
        )
      } catch (error) {
        await this.recordAuthenticationFailure(providerId, authenticationGeneration, host, error)
        throw error
      }
    }
    const resolveTarget =
      this.dependencies.resolveTarget ??
      ((alias, overrides) =>
        resolveSshTarget(alias, overrides, undefined, {
          controlDirectory: join(homedir(), '.ssh', 'ctrl')
        }))
    const target = await resolveTarget(host.sshAlias, host.sshOverrides)
    this.assertGenerationCurrent(providerId, generation)
    request.signal?.throwIfAborted()

    const upload = async (localPath: string, remotePath: string): Promise<void> => {
      const scpRunner = this.dependencies.scpRunner
      if (!scpRunner) throw new ComputeConnectionError('unsupported_auth_configuration')
      const result = await scpRunner.copy(
        resolveScpBinary(),
        buildScpUploadArgs(target, localPath, remotePath),
        30 * 60 * 1000,
        { signal: request.signal }
      )
      const failure = classifyConnectionFailure(result, false)
      if (failure) throw failure
      if (result.exitCode !== 0) throw new Error('Remote file upload failed.')
    }

    const download = async (
      remotePath: string,
      localPath: string,
      maxBytes: number
    ): Promise<BoundedScpResult> => {
      const scpRunner = this.dependencies.scpRunner
      if (!scpRunner) throw new ComputeConnectionError('unsupported_auth_configuration')
      if (!scpRunner.copyFromRemoteBounded)
        throw new ComputeConnectionError('unsupported_auth_configuration')
      const result = await scpRunner.copyFromRemoteBounded(
        target,
        remotePath,
        localPath,
        maxBytes,
        10 * 60 * 1000,
        { signal: request.signal }
      )
      const failure = classifyConnectionFailure(result, false)
      if (failure) throw failure
      return result
    }

    return this.guardLease(
      providerId,
      generation,
      this.observeAuthentication(providerId, authenticationGeneration, host, request, {
        run: async (remoteCommand, options) => {
          const signal = request.signal ?? options.signal
          const result = await this.dependencies.runner.run(target, remoteCommand, {
            ...options,
            ...(signal ? { signal } : {})
          })
          const failure = classifyConnectionFailure(result, false)
          if (failure) throw failure
          return result
        },
        upload,
        download
      })
    )
  }

  private observeAuthentication(
    providerId: string,
    authenticationGeneration: string,
    host: ComputeHost,
    request: AcquireComputeConnectionRequest,
    lease: ComputeConnectionLease
  ): ComputeConnectionLease {
    const isBackgroundAuthentication =
      request.intent === 'job_poll' || request.intent === 'job_harvest'
    const perform = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      if (
        isBackgroundAuthentication &&
        this.authenticationFailures.get(providerId) === authenticationGeneration
      ) {
        throw new ComputeConnectionError('authentication_failed')
      }
      try {
        const result = await operation()
        if (
          request.interactive &&
          (request.intent === 'test_connection' || request.intent === 'probe')
        ) {
          await this.clearAuthenticationFailure(providerId)
        }
        return result
      } catch (error) {
        await this.recordAuthenticationFailure(providerId, authenticationGeneration, host, error)
        throw error
      }
    }
    const observe = <Result>(operation: () => Promise<Result>): Promise<Result> =>
      isBackgroundAuthentication
        ? this.enqueueBackgroundAuthenticationOperation(providerId, () => perform(operation))
        : perform(operation)
    return {
      run: (command, options) => observe(() => lease.run(command, options)),
      upload: (localPath, remotePath) => observe(() => lease.upload(localPath, remotePath)),
      download: (remotePath, localPath, maxBytes) =>
        observe(() => lease.download(remotePath, localPath, maxBytes)),
      ...(lease.redactSensitiveOutputs
        ? {
            redactSensitiveOutputs: (values: readonly string[]) =>
              lease.redactSensitiveOutputs!(values)
          }
        : {})
    }
  }

  private enqueueBackgroundAuthenticationOperation<Result>(
    providerId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const previous = this.backgroundAuthenticationTails.get(providerId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.backgroundAuthenticationTails.set(providerId, tail)
    void tail.finally(() => {
      if (this.backgroundAuthenticationTails.get(providerId) === tail) {
        this.backgroundAuthenticationTails.delete(providerId)
      }
    })
    return result
  }

  private async recordAuthenticationFailure(
    providerId: string,
    authenticationGeneration: string,
    host: ComputeHost,
    error: unknown
  ): Promise<void> {
    if (error instanceof ComputeConnectionError && error.code === 'authentication_failed') {
      this.authenticationFailures.set(providerId, authenticationGeneration)
      try {
        await this.serializeAuthenticationFailurePersistence(providerId, async () => {
          await this.dependencies.persistAuthenticationFailure?.(host)
        })
      } catch (persistenceError) {
        this.dependencies.reportAuthenticationFailurePersistenceError?.(persistenceError)
      }
    }
  }

  private async serializeAuthenticationFailurePersistence(
    providerId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const previous = this.authenticationFailurePersistence.get(providerId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.authenticationFailurePersistence.set(providerId, current)
    try {
      await current
    } finally {
      if (this.authenticationFailurePersistence.get(providerId) === current) {
        this.authenticationFailurePersistence.delete(providerId)
      }
    }
  }
}

export { SshConfigComputeConnectionBroker }
export type { ComputeConnectionBroker, SshConfigComputeConnectionBrokerDependencies }
