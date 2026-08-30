import type {
  ChangeComputeHostAuthenticationRequest,
  ComputeAuthenticationMode,
  ComputeHost,
  CreatePasswordComputeHostRequest,
  ResetPasswordComputeHostRequest
} from '../../shared/compute'
import { computeProviderId, DETAILS_DOC_MAX_LENGTH } from '../../shared/compute'
import type { PasswordSshAdapter } from './connection-adapters'
import { ComputeConnectionError } from './connection-broker'
import type { CredentialVault } from './credential-vault'
import { assertSafeSshAlias } from './remote-path-security'

type CreatePasswordHostPersistence = Readonly<{
  operationId: string
  requestFingerprint: string
  sshAlias: string
  displayName?: string
  detailsDoc?: string
  username: string
  port: number
  ciphertext: Buffer
  verifiedAt: Date
}>

type PreparePasswordCreateRequest = Readonly<{
  operationId: string
  requestFingerprint: string
  sshAlias: string
}>

type PasswordCreatePreparation =
  Readonly<{ kind: 'ready' }> | Readonly<{ kind: 'replay'; host: ComputeHost }>

type PreparePasswordResetRequest = Pick<
  ResetPasswordComputeHostRequest,
  'providerId' | 'operationId' | 'expectedAuthenticationRevision'
> &
  Readonly<{ requestFingerprint: string }>

type ResetPasswordHostPersistence = PreparePasswordResetRequest &
  Readonly<{ ciphertext: Buffer; verifiedAt: Date }>

type PasswordResetPreparation =
  Readonly<{ kind: 'ready'; host: ComputeHost }> | Readonly<{ kind: 'replay'; host: ComputeHost }>

type ChangeComputeHostAuthenticationPersistence = Readonly<{
  providerId: string
  expectedRevision: number
  operationId: string
  requestFingerprint: string
  authenticationMode: ComputeAuthenticationMode
  username: string | undefined
  port: number
  identityFile?: string
  ciphertext?: Buffer
  verifiedAt: Date
}>

type ComputeAuthRepository = Readonly<{
  getAuthenticationOperation(
    operationId: string
  ): Promise<Readonly<{ requestFingerprint: string }> | null>
  preparePasswordCreate(request: PreparePasswordCreateRequest): Promise<PasswordCreatePreparation>
  createPasswordHost(request: CreatePasswordHostPersistence): Promise<ComputeHost>
  preparePasswordReset(request: PreparePasswordResetRequest): Promise<PasswordResetPreparation>
  resetPasswordHost(request: ResetPasswordHostPersistence): Promise<ComputeHost>
  get(providerId: string): Promise<ComputeHost | null>
  replayAuthenticationChange?(
    operationId: string,
    providerId: string,
    requestFingerprint: string
  ): Promise<ComputeHost | null>
  changeAuthentication(request: ChangeComputeHostAuthenticationPersistence): Promise<ComputeHost>
}>

type ComputeAuthOwnerDependencies = Readonly<{
  repository: ComputeAuthRepository
  vault: Pick<CredentialVault, 'encrypt' | 'bindOperationIntent'>
  passwordAdapter: PasswordSshAdapter
  validateSshConfig?(candidate: ComputeHost): Promise<void>
  hasBlockingJobs?(providerId: string): Promise<boolean>
  commitAuthentication?(request: ChangeComputeHostAuthenticationPersistence): Promise<ComputeHost>
  invalidateAuthenticationIdentity?(providerId: string): void
  now?: () => Date
}>

const requireValidTrimmedField = (value: string, label: string): string => {
  const result = value.trim()
  if (!result || result.length > 255 || /[\0\r\n]/.test(result)) {
    throw new ComputeConnectionError(
      'unsupported_auth_configuration',
      `${label} must contain 1–255 characters.`
    )
  }
  return result
}

const requireSafeSshAlias = (value: string): string => {
  const alias = requireValidTrimmedField(value, 'SSH alias')
  try {
    return assertSafeSshAlias(alias)
  } catch (error) {
    throw new ComputeConnectionError(
      'unsupported_auth_configuration',
      error instanceof Error ? error.message : undefined
    )
  }
}

class ComputeAuthOwner {
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private readonly dependencies: ComputeAuthOwnerDependencies) {}

  private async bindOperationIntent(
    operationId: string,
    intent: readonly unknown[]
  ): Promise<string> {
    const existing = await this.dependencies.repository.getAuthenticationOperation(operationId)
    return this.dependencies.vault.bindOperationIntent(
      JSON.stringify(intent),
      existing?.requestFingerprint
    )
  }

  private async verifyPasswordCandidate(host: ComputeHost, password: string): Promise<void> {
    const lease = await this.dependencies.passwordAdapter.acquireWithPassword(host, password, {
      intent: 'test_connection',
      interactive: true
    })
    const result = await lease.run('true', {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4 * 1024
    })
    if (result.exitCode !== 0) throw new ComputeConnectionError('authentication_failed')
  }

  private enqueueMutation<Result>(
    providerId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const previous = this.mutationTails.get(providerId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.mutationTails.set(providerId, tail)
    void tail.finally(() => {
      if (this.mutationTails.get(providerId) === tail) this.mutationTails.delete(providerId)
    })
    return result
  }
  async createPassword(request: CreatePasswordComputeHostRequest): Promise<ComputeHost> {
    if (request.authenticationMode !== 'password') {
      throw new ComputeConnectionError('unsupported_auth_configuration')
    }
    const alias = requireSafeSshAlias(request.sshAlias)
    const username = requireValidTrimmedField(request.username, 'Username')
    const operationId = requireValidTrimmedField(
      request.operationId,
      'Credential operation identifier'
    )
    if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) {
      throw new ComputeConnectionError(
        'unsupported_auth_configuration',
        'Port must be an integer from 1 through 65535.'
      )
    }
    if ((request.detailsDoc?.length ?? 0) > DETAILS_DOC_MAX_LENGTH) {
      throw new ComputeConnectionError(
        'unsupported_auth_configuration',
        `Details must be ${DETAILS_DOC_MAX_LENGTH} characters or fewer.`
      )
    }
    const requestFingerprint = await this.bindOperationIntent(operationId, [
      'create_password',
      alias,
      request.displayName?.trim() || alias,
      request.detailsDoc ?? '',
      username,
      request.port,
      request.password
    ])
    const prepared = await this.dependencies.repository.preparePasswordCreate({
      operationId,
      requestFingerprint,
      sshAlias: alias
    })
    if (prepared.kind === 'replay') return prepared.host

    const ciphertext = this.dependencies.vault.encrypt(request.password)
    const candidate = {
      id: `candidate:${operationId}`,
      providerId: computeProviderId(alias),
      displayName: request.displayName?.trim() || alias,
      sshAlias: alias,
      sshOverrides: { user: username, port: request.port },
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    } as ComputeHost
    await this.verifyPasswordCandidate(candidate, request.password)
    return this.dependencies.repository.createPasswordHost({
      operationId,
      requestFingerprint,
      sshAlias: alias,
      displayName: request.displayName,
      detailsDoc: request.detailsDoc,
      username,
      port: request.port,
      ciphertext,
      verifiedAt: (this.dependencies.now ?? (() => new Date()))()
    })
  }

  resetPassword(request: ResetPasswordComputeHostRequest): Promise<ComputeHost> {
    const providerId = requireValidTrimmedField(request.providerId, 'Compute Host identity')
    const operationId = requireValidTrimmedField(
      request.operationId,
      'Credential operation identifier'
    )
    if (
      !Number.isInteger(request.expectedAuthenticationRevision) ||
      request.expectedAuthenticationRevision < 1
    ) {
      throw new ComputeConnectionError('credential_conflict')
    }
    return this.enqueueMutation(providerId, async () => {
      const requestFingerprint = await this.bindOperationIntent(operationId, [
        'reset_password',
        providerId,
        request.expectedAuthenticationRevision,
        request.password
      ])
      const prepared = await this.dependencies.repository.preparePasswordReset({
        providerId,
        operationId,
        expectedAuthenticationRevision: request.expectedAuthenticationRevision,
        requestFingerprint
      })
      if (prepared.kind === 'replay') return prepared.host

      const ciphertext = this.dependencies.vault.encrypt(request.password)
      const candidate = {
        ...prepared.host,
        authentication: {
          mode: 'password' as const,
          credentialStatus: 'configured' as const,
          revision: request.expectedAuthenticationRevision,
          lastVerifiedAt: prepared.host.authentication?.lastVerifiedAt
        }
      }
      await this.verifyPasswordCandidate(candidate, request.password)
      const committed = await this.dependencies.repository.resetPasswordHost({
        providerId,
        operationId,
        requestFingerprint,
        expectedAuthenticationRevision: request.expectedAuthenticationRevision,
        ciphertext,
        verifiedAt: (this.dependencies.now ?? (() => new Date()))()
      })
      this.dependencies.invalidateAuthenticationIdentity?.(providerId)
      return committed
    })
  }

  async changeAuthentication(
    request: ChangeComputeHostAuthenticationRequest
  ): Promise<ComputeHost> {
    const providerId = requireValidTrimmedField(
      request.providerId,
      'Compute Host provider identifier'
    )
    return this.enqueueMutation(providerId, () =>
      this.changeAuthenticationSerialized(providerId, request)
    )
  }

  private async changeAuthenticationSerialized(
    providerId: string,
    request: ChangeComputeHostAuthenticationRequest
  ): Promise<ComputeHost> {
    const operationId = requireValidTrimmedField(
      request.operationId,
      'Credential operation identifier'
    )
    // An absent username is only valid for ssh_config mode, where ~/.ssh/config supplies the User.
    const username = request.username?.trim()
      ? requireValidTrimmedField(request.username, 'Username')
      : undefined
    if (request.authenticationMode !== 'ssh_config' && request.authenticationMode !== 'password') {
      throw new ComputeConnectionError('unsupported_auth_configuration')
    }
    if (request.authenticationMode === 'password' && !username) {
      throw new ComputeConnectionError(
        'unsupported_auth_configuration',
        'Username is required for password authentication.'
      )
    }
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1) {
      throw new ComputeConnectionError('credential_conflict')
    }
    if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) {
      throw new ComputeConnectionError(
        'unsupported_auth_configuration',
        'Port must be an integer from 1 through 65535.'
      )
    }
    const identityFile = request.identityFile
      ? requireValidTrimmedField(request.identityFile, 'Identity file')
      : undefined
    const requestFingerprint = await this.bindOperationIntent(operationId, [
      'change_authentication',
      providerId,
      request.expectedRevision,
      request.authenticationMode,
      username ?? null,
      request.port,
      identityFile ?? null,
      request.password ?? null
    ])
    const replay = await this.dependencies.repository.replayAuthenticationChange?.(
      operationId,
      providerId,
      requestFingerprint
    )
    if (replay) return replay
    const host = await this.dependencies.repository.get(providerId)
    if (!host) throw new Error(`No compute host found with provider id "${providerId}".`)
    if ((host.authentication?.revision ?? 1) !== request.expectedRevision) {
      throw new ComputeConnectionError('credential_conflict')
    }
    const currentIdentityFile =
      host.authentication?.mode === 'ssh_config' ? host.sshOverrides?.identityFile : undefined
    const hasMaterialChange =
      host.authentication?.mode !== request.authenticationMode ||
      host.sshOverrides?.user !== username ||
      (host.sshOverrides?.port ?? 22) !== request.port ||
      (request.authenticationMode === 'ssh_config' && currentIdentityFile !== identityFile)
    if (!hasMaterialChange) return host
    if (await this.dependencies.hasBlockingJobs?.(providerId)) {
      throw new ComputeConnectionError('credential_change_blocked_by_jobs')
    }
    const candidate: ComputeHost = {
      ...host,
      sshOverrides: {
        ...(username ? { user: username } : {}),
        port: request.port,
        ...(request.authenticationMode === 'ssh_config' && identityFile ? { identityFile } : {})
      },
      authentication: {
        mode: request.authenticationMode,
        credentialStatus: request.authenticationMode === 'password' ? 'configured' : 'missing',
        revision: request.expectedRevision,
        lastVerifiedAt: host.authentication?.lastVerifiedAt
      }
    }
    let ciphertext: Buffer | undefined
    if (request.authenticationMode === 'password') {
      if (request.password === undefined) throw new ComputeConnectionError('credential_required')
      ciphertext = this.dependencies.vault.encrypt(request.password)
      await this.verifyPasswordCandidate(candidate, request.password)
    } else {
      if (!this.dependencies.validateSshConfig) {
        throw new ComputeConnectionError('unsupported_auth_configuration')
      }
      await this.dependencies.validateSshConfig(candidate)
    }
    const persistence = {
      providerId,
      expectedRevision: request.expectedRevision,
      operationId,
      requestFingerprint,
      authenticationMode: request.authenticationMode,
      username,
      port: request.port,
      ...(identityFile ? { identityFile } : {}),
      ...(ciphertext ? { ciphertext } : {}),
      verifiedAt: (this.dependencies.now ?? (() => new Date()))()
    }
    if (this.dependencies.commitAuthentication) {
      return this.dependencies.commitAuthentication(persistence)
    }
    const committed = await this.dependencies.repository.changeAuthentication(persistence)
    this.dependencies.invalidateAuthenticationIdentity?.(providerId)
    return committed
  }
}

export { ComputeAuthOwner }
export type {
  ChangeComputeHostAuthenticationPersistence,
  ComputeAuthOwnerDependencies,
  ComputeAuthRepository,
  CreatePasswordHostPersistence,
  PasswordCreatePreparation,
  PasswordResetPreparation,
  PreparePasswordCreateRequest,
  PreparePasswordResetRequest,
  ResetPasswordHostPersistence
}
