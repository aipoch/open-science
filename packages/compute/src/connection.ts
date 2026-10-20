import type { ComputeAuthenticationErrorCode, ComputeHost } from './model'
import type { BoundedScpResult } from './scp-runner'
import type { SshRunner } from './ssh-runner'
type ConnectionRunOptions = Parameters<SshRunner['run']>[2]
type ConnectionRunResult = Awaited<ReturnType<SshRunner['run']>>

// Machine protocols are carried by stdout. SSH banners and diagnostics on stderr must not
// invalidate complete protocol evidence. Legacy/injected runners without stream metadata retain
// the conservative aggregate check; human-facing output keeps the aggregate truncated flag.
export const isConnectionStdoutTruncated = (
  result: Pick<ConnectionRunResult, 'truncated' | 'stdoutTruncated'>
): boolean => result.stdoutTruncated ?? result.truncated

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
  // Password leases expose post-parse redaction so structured protocol fields remain intact while
  // user-visible or persisted payloads can still be scrubbed before crossing their boundary.
  redactSensitiveOutputs?(values: readonly string[]): Promise<string[]>
}

const redactConnectionOutputs = async (
  lease: ComputeConnectionLease,
  values: readonly string[]
): Promise<string[]> =>
  lease.redactSensitiveOutputs ? lease.redactSensitiveOutputs(values) : [...values]

interface ComputeConnectionBrokerAcquirer {
  acquire(
    providerId: string,
    request: AcquireComputeConnectionRequest
  ): Promise<ComputeConnectionLease>
}

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

export {
  classifyConnectionFailure,
  ComputeConnectionError,
  redactConnectionOutputs,
  safeConnectionErrorMessage
}
export type {
  AcquireComputeConnectionRequest,
  ComputeConnectionAdapter,
  ComputeConnectionBrokerAcquirer,
  ComputeConnectionLease,
  ConnectionRunOptions,
  ConnectionRunResult
}
