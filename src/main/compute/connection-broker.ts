import type { ComputeAuthenticationErrorCode, ComputeHost } from '../../shared/compute'
import {
  buildScpUploadArgs,
  resolveScpBinary,
  type BoundedScpResult,
  type ScpRunner
} from './scp-runner'
import { resolveSshTarget, type ResolvedSshTarget, type SshRunner } from './ssh-runner'

type ConnectionRunOptions = Parameters<SshRunner['run']>[2]
type ConnectionRunResult = Awaited<ReturnType<SshRunner['run']>>

type AcquireComputeConnectionRequest = Readonly<{
  intent:
    | 'probe'
    | 'test_connection'
    | 'direct_browse'
    | 'direct_command'
    | 'direct_upload'
    | 'direct_download'
    | 'job_dispatch'
    | 'job_poll'
    | 'job_harvest'
    | 'job_cleanup'
  interactive?: boolean
  signal?: AbortSignal
}>

interface ComputeConnectionLease {
  run(remoteCommand: string, options: ConnectionRunOptions): Promise<ConnectionRunResult>
  upload(localPath: string, remotePath: string): Promise<void>
  download(remotePath: string, localPath: string, maxBytes: number): Promise<BoundedScpResult>
}

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

type ComputeConnectionBrokerAcquirer = Pick<ComputeConnectionBroker, 'acquire'>

interface ComputeConnectionAdapter {
  acquire(
    host: ComputeHost,
    request: AcquireComputeConnectionRequest
  ): Promise<ComputeConnectionLease>
}

class ComputeConnectionError extends Error {
  readonly name = 'ComputeConnectionError'

  constructor(
    readonly code: ComputeAuthenticationErrorCode,
    message = safeConnectionErrorMessage(code)
  ) {
    super(message)
  }
}

const safeConnectionErrorMessage = (code: ComputeAuthenticationErrorCode): string => {
  switch (code) {
    case 'credential_required':
      return 'A password must be configured before this Compute Host can connect.'
    case 'credential_unavailable':
      return 'The saved credential is unavailable on this device.'
    case 'secure_storage_unavailable':
      return 'Secure credential storage is unavailable. Unlock the system keychain and retry.'
    case 'authentication_failed':
      return 'Authentication failed. Verify the username and password.'
    case 'credential_conflict':
      return 'The Compute Host credentials changed. Start the operation again.'
    case 'credential_change_blocked_by_jobs':
      return 'Authentication cannot change while a Compute Job is active or waiting for result collection.'
    case 'host_key_unknown':
      return 'The SSH host key is unknown. Verify it in a terminal before connecting.'
    case 'host_key_changed':
      return 'The SSH host key changed. Verify known_hosts in a terminal before connecting.'
    case 'host_unreachable':
      return 'The Compute Host could not be reached.'
    case 'timeout':
      return 'The Compute Host connection timed out.'
    case 'create_failed':
      return 'Could not add host.'
    case 'reset_failed':
      return 'Could not update the saved password.'
    case 'unsupported_auth_configuration':
      return 'This SSH authentication configuration is not supported.'
  }
}

const classifyConnectionFailure = (
  result: { exitCode: number | null; stderr: string; timedOut: boolean },
  unsupportedFallback = true
): ComputeConnectionError | undefined => {
  if (result.timedOut) return new ComputeConnectionError('timeout')
  if (result.exitCode === 0) return undefined
  const stderr = result.stderr.toLowerCase()
  if (stderr.includes('remote host identification has changed'))
    return new ComputeConnectionError('host_key_changed')
  if (
    stderr.includes('host key verification failed') ||
    stderr.includes('no host key is known') ||
    stderr.includes('authenticity of host')
  )
    return new ComputeConnectionError('host_key_unknown')
  if (
    stderr.includes('permission denied (') ||
    stderr.includes('permission denied, please try again') ||
    (result.exitCode === 255 && stderr.includes('permission denied')) ||
    stderr.includes('authentication failed')
  )
    return new ComputeConnectionError('authentication_failed')
  if (
    stderr.includes('connection refused') ||
    stderr.includes('network is unreachable') ||
    stderr.includes('no route to host') ||
    stderr.includes('could not resolve hostname') ||
    result.exitCode === 255
  )
    return new ComputeConnectionError('host_unreachable')
  return unsupportedFallback
    ? new ComputeConnectionError('unsupported_auth_configuration')
    : undefined
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
        )
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
    const resolveTarget = this.dependencies.resolveTarget ?? resolveSshTarget
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
        observe(() => lease.download(remotePath, localPath, maxBytes))
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

export {
  ComputeConnectionError,
  SshConfigComputeConnectionBroker,
  classifyConnectionFailure,
  safeConnectionErrorMessage
}
export type {
  AcquireComputeConnectionRequest,
  ComputeConnectionBroker,
  ComputeConnectionBrokerAcquirer,
  ComputeConnectionAdapter,
  ComputeConnectionLease,
  ConnectionRunOptions,
  ConnectionRunResult,
  SshConfigComputeConnectionBrokerDependencies
}
