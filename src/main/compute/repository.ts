import type { ComputeHost as PrismaComputeHost, PrismaClient } from '@prisma/client'

import type {
  ComputeHost,
  ComputeAuthenticationMode,
  ComputeHostShape,
  CreateComputeHostRequest,
  DetailsAuthor,
  ProbeResult,
  SshOverrides
} from '../../shared/compute'
import type {
  ChangeComputeHostAuthenticationPersistence,
  CreatePasswordHostPersistence,
  PasswordCreatePreparation,
  PasswordResetPreparation,
  PreparePasswordCreateRequest,
  PreparePasswordResetRequest,
  ResetPasswordHostPersistence
} from './compute-auth-owner'
import { computeProviderId, DETAILS_DOC_MAX_LENGTH } from '../../shared/compute'
import {
  parseHostConnectionPort,
  validateHostConnectionProfile
} from '../../shared/compute-host-connection-profile'
import { decodeVersionedJson } from '../storage/versioned-json-decoder'
import { ComputeConnectionError } from './connection-broker'
import { assertSafeScratchRoot, assertSafeSshAlias } from './remote-path-security'

// Only the computeHost delegate is needed; typing to this subset keeps the repository unit-testable
// with a lightweight mock instead of a real (engine-backed) PrismaClient (aligns with the reviewer and
// projects repositories, per design.md §2).
type ComputeHostClient = Pick<
  PrismaClient,
  | 'computeHost'
  | 'computeCredential'
  | 'computeAuthOperation'
  | 'computeJob'
  | '$transaction'
  | '$executeRawUnsafe'
>

// Resolves the Prisma client on demand so a failed initialization is not held forever (see
// projects/repository.ts).
type ComputeHostClientProvider = () => Promise<ComputeHostClient>

const COMPUTE_JSON_SCHEMA_VERSION = 1

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readSchemaVersion = (value: unknown): unknown =>
  isRecord(value) && 'schemaVersion' in value ? value.schemaVersion : undefined

const decodeSshOverrides = (value: unknown): SshOverrides | undefined => {
  if (!isRecord(value)) return undefined
  if (value.user !== undefined && typeof value.user !== 'string') return undefined
  if (
    value.port !== undefined &&
    (typeof value.port !== 'number' || !Number.isFinite(value.port))
  ) {
    return undefined
  }
  if (value.identityFile !== undefined && typeof value.identityFile !== 'string') return undefined

  return {
    ...(typeof value.user === 'string' ? { user: value.user } : {}),
    ...(typeof value.port === 'number' ? { port: value.port } : {}),
    ...(typeof value.identityFile === 'string' ? { identityFile: value.identityFile } : {})
  }
}

const authenticationErrorCodes = new Set([
  'credential_required',
  'credential_unavailable',
  'secure_storage_unavailable',
  'authentication_failed',
  'credential_conflict',
  'credential_change_blocked_by_jobs',
  'host_key_unknown',
  'host_key_changed',
  'host_unreachable',
  'timeout',
  'create_failed',
  'reset_failed',
  'unsupported_auth_configuration'
])

const decodeProbeResult = (value: unknown): ProbeResult | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.ok !== 'boolean' || typeof value.probedAt !== 'string') return undefined
  if (value.exitCode !== null && typeof value.exitCode !== 'number') return undefined
  if (value.errorTail !== null && typeof value.errorTail !== 'string') return undefined
  if (
    value.authenticationCode !== undefined &&
    (typeof value.authenticationCode !== 'string' ||
      !authenticationErrorCodes.has(value.authenticationCode))
  ) {
    return undefined
  }
  if (
    value.authenticationRevision !== undefined &&
    (typeof value.authenticationRevision !== 'number' ||
      !Number.isInteger(value.authenticationRevision))
  ) {
    return undefined
  }
  if (value.os !== undefined && typeof value.os !== 'string') return undefined
  for (const numericField of ['cpus', 'memMib'] as const) {
    if (
      value[numericField] !== undefined &&
      (typeof value[numericField] !== 'number' || !Number.isFinite(value[numericField]))
    ) {
      return undefined
    }
  }
  if (
    value.gpus !== undefined &&
    (!Array.isArray(value.gpus) ||
      value.gpus.some(
        (gpu) =>
          !isRecord(gpu) ||
          typeof gpu.type !== 'string' ||
          typeof gpu.count !== 'number' ||
          !Number.isFinite(gpu.count)
      ))
  ) {
    return undefined
  }
  if (
    value.detectedScheduler !== undefined &&
    value.detectedScheduler !== 'slurm' &&
    value.detectedScheduler !== 'pbs' &&
    value.detectedScheduler !== 'lsf' &&
    value.detectedScheduler !== 'none'
  ) {
    return undefined
  }

  return {
    ok: value.ok,
    probedAt: value.probedAt,
    exitCode: value.exitCode,
    errorTail: value.errorTail,
    ...(value.authenticationCode !== undefined
      ? { authenticationCode: value.authenticationCode as ProbeResult['authenticationCode'] }
      : {}),
    ...(typeof value.authenticationRevision === 'number'
      ? { authenticationRevision: value.authenticationRevision }
      : {}),
    ...(typeof value.os === 'string' ? { os: value.os } : {}),
    ...(typeof value.cpus === 'number' ? { cpus: value.cpus } : {}),
    ...(typeof value.memMib === 'number' ? { memMib: value.memMib } : {}),
    ...(Array.isArray(value.gpus) ? { gpus: value.gpus as ProbeResult['gpus'] } : {}),
    ...(value.detectedScheduler !== undefined
      ? { detectedScheduler: value.detectedScheduler as ProbeResult['detectedScheduler'] }
      : {})
  }
}

// Existing unversioned values remain readable as legacy data. Unsupported and corrupt payloads
// fail the Host read instead of being mistaken for a missing optional field.
const parseComputeJson = <T>(
  value: string | null,
  decode: (value: unknown) => T | undefined,
  field: string
): T | undefined => {
  if (value === null) return undefined
  const result = decodeVersionedJson(value, {
    currentVersion: COMPUTE_JSON_SCHEMA_VERSION,
    readVersion: readSchemaVersion,
    decode,
    decodeUnversioned: decode
  })
  if (result.status === 'unsupported') {
    throw new Error(
      `Compute Host data is corrupt or unsupported: ${field} uses schema version ${result.version}.`
    )
  }
  if (result.status === 'corrupt') {
    throw new Error(`Compute Host data is corrupt or unsupported: ${field} is corrupt.`)
  }
  return result.value
}

const serializeProbeResult = (result: ProbeResult): string =>
  JSON.stringify({ schemaVersion: COMPUTE_JSON_SCHEMA_VERSION, ...result })

const asShape = (value: string): ComputeHostShape => {
  if (value === 'scheduler_cluster' || value === 'bridge_runner' || value === 'direct_ssh') {
    return value
  }
  throw new Error(`Compute Host data is corrupt or unsupported: unknown shape ${value}.`)
}

const asAuthor = (value: string | null): DetailsAuthor | undefined => {
  if (value === null) return undefined
  if (value === 'user' || value === 'agent') return value
  throw new Error(`Compute Host data is corrupt or unsupported: unknown details author ${value}.`)
}

const asAuthenticationMode = (value: string): ComputeAuthenticationMode => {
  if (value === 'ssh_config' || value === 'password') return value
  throw new Error('This SSH authentication configuration is not supported.')
}

const escapeSqlLike = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')

type AuthenticationOperationKind = 'create_password' | 'reset_password' | 'change_authentication'

const assertOperationBinding = (
  operation: { providerId: string; operationKind: string; requestFingerprint: string },
  providerId: string,
  operationKind: AuthenticationOperationKind,
  requestFingerprint: string
): void => {
  if (
    operation.providerId !== providerId ||
    operation.operationKind !== operationKind ||
    operation.requestFingerprint !== requestFingerprint
  ) {
    throw new ComputeConnectionError('credential_conflict')
  }
}

// Maps a Prisma row (JSON strings + DateTime + nullable columns) into the epoch-ms domain shape shared
// with the renderer.
const toHost = (row: PrismaComputeHost, hasCredential = false): ComputeHost => ({
  id: row.id,
  providerId: row.providerId,
  displayName: row.displayName,
  shape: asShape(row.shape),
  sshAlias: row.sshAlias,
  sshOverrides: parseComputeJson(row.sshOverrides, decodeSshOverrides, 'sshOverrides'),
  authentication: {
    mode: asAuthenticationMode(row.authenticationMode ?? 'ssh_config'),
    credentialStatus:
      row.authenticationMode === 'password'
        ? hasCredential
          ? 'configured'
          : 'missing'
        : 'missing',
    revision: row.authenticationRevision ?? 1,
    lastVerifiedAt: row.lastVerifiedAt?.getTime()
  },
  scratchRoot: row.scratchRoot ?? undefined,
  scratchPinned: row.scratchPinned,
  concurrencyLimit: row.concurrencyLimit ?? undefined,
  probeResult: parseComputeJson(row.probeResult, decodeProbeResult, 'probeResult'),
  detailsDoc: row.detailsDoc,
  detailsUpdatedAt: row.detailsUpdatedAt?.getTime(),
  detailsUpdatedBy: asAuthor(row.detailsUpdatedBy),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

// Drops undefined/empty fields so an empty overrides object is stored as null (not "{}"). Security:
// only user/port/identityFile are ever serialized here — never a credential or key (design.md §1).
const serializeOverrides = (overrides: SshOverrides | undefined): string | null => {
  if (!overrides) return null
  const clean: SshOverrides = {}
  if (overrides.user?.trim()) clean.user = overrides.user.trim()
  const port = parseHostConnectionPort(overrides.port)
  if (port !== undefined) clean.port = port
  if (overrides.identityFile?.trim()) clean.identityFile = overrides.identityFile.trim()
  return Object.keys(clean).length === 0
    ? null
    : JSON.stringify({ schemaVersion: COMPUTE_JSON_SCHEMA_VERSION, ...clean })
}

// Owns ComputeHost reads/writes. The client is resolved lazily per call so schema-ensure failures can
// recover (see projects/repository.ts). Phase 1 (issue 01): create / list / get / delete; issue 02
// adds updateProbeResult and updateScratchRoot for probe persistence.
class ComputeHostRepository {
  constructor(private readonly getClient: ComputeHostClientProvider) {}

  async getAuthenticationOperation(
    operationId: string
  ): Promise<Readonly<{ requestFingerprint: string }> | null> {
    const client = await this.getClient()
    const operation = await client.computeAuthOperation.findUnique({ where: { id: operationId } })
    return operation ? { requestFingerprint: operation.requestFingerprint } : null
  }

  async preparePasswordCreate(
    request: PreparePasswordCreateRequest
  ): Promise<PasswordCreatePreparation> {
    const providerId = computeProviderId(assertSafeSshAlias(request.sshAlias))
    const client = await this.getClient()
    const replay = await client.computeAuthOperation.findUnique({
      where: { id: request.operationId }
    })
    if (replay) {
      assertOperationBinding(replay, providerId, 'create_password', request.requestFingerprint)
      const existing = await client.computeHost.findUnique({ where: { providerId } })
      if (!existing) throw new Error('The prior credential operation result is unavailable.')
      return { kind: 'replay', host: toHost(existing, true) }
    }
    const duplicate = await client.computeHost.findUnique({ where: { providerId } })
    if (duplicate) {
      throw new Error(`A host with alias "${request.sshAlias}" is already registered.`)
    }
    return { kind: 'ready' }
  }

  // Lists hosts newest-first for the Compute list view.
  async list(): Promise<ComputeHost[]> {
    const client = await this.getClient()
    const rows = await client.computeHost.findMany({ orderBy: { createdAt: 'desc' } })

    return rows.map((row) => toHost(row))
  }

  // Returns a single host by its provider id ("ssh:<alias>") or null when it no longer exists.
  async get(providerId: string): Promise<ComputeHost | null> {
    const client = await this.getClient()
    const row = await client.computeHost.findUnique({ where: { providerId } })

    return row ? toHost(row) : null
  }

  // Creates a host record. Validates the alias, the 32 KiB details cap, and rejects a duplicate
  // provider_id with a readable error before inserting. No SSH connection is made in Phase 1.
  async create(request: CreateComputeHostRequest): Promise<ComputeHost> {
    const profile = validateHostConnectionProfile({
      sshAlias: request.sshAlias,
      displayName: request.displayName,
      user: request.sshOverrides?.user,
      port: request.sshOverrides?.port,
      identityFile: request.sshOverrides?.identityFile
    })
    const alias = assertSafeSshAlias(profile.sshAlias)

    const detailsDoc = request.detailsDoc ?? ''
    if (detailsDoc.length > DETAILS_DOC_MAX_LENGTH) {
      throw new Error(
        `Details must be ${DETAILS_DOC_MAX_LENGTH} characters or fewer (got ${detailsDoc.length}).`
      )
    }

    const providerId = computeProviderId(alias)

    const client = await this.getClient()

    // Pre-check for a readable duplicate error rather than surfacing a raw unique-constraint failure.
    // The DB @unique index is still the authoritative guard against a race.
    const existing = await client.computeHost.findUnique({ where: { providerId } })
    if (existing) {
      throw new Error(`A host with alias "${alias}" is already registered.`)
    }

    // A seeded details doc is authored by the user editing the Add form.
    const hasDetails = detailsDoc.length > 0

    const row = await client.computeHost.create({
      data: {
        providerId,
        displayName: profile.displayName,
        sshAlias: alias,
        sshOverrides: serializeOverrides({
          user: profile.user,
          port: profile.port,
          identityFile: profile.identityFile
        }),
        detailsDoc,
        detailsUpdatedBy: hasDetails ? 'user' : null,
        detailsUpdatedAt: hasDetails ? new Date() : null
      }
    })

    return toHost(row)
  }

  // Validated password Hosts and their encrypted credential are committed together. The operation
  // row makes a retried local command return the original result without creating a duplicate.
  async createPasswordHost(request: CreatePasswordHostPersistence): Promise<ComputeHost> {
    const alias = assertSafeSshAlias(request.sshAlias)
    const detailsDoc = request.detailsDoc ?? ''
    if (detailsDoc.length > DETAILS_DOC_MAX_LENGTH) {
      throw new Error(
        `Details must be ${DETAILS_DOC_MAX_LENGTH} characters or fewer (got ${detailsDoc.length}).`
      )
    }
    const providerId = computeProviderId(alias)
    const client = await this.getClient()
    const row = await client.$transaction(async (transaction) => {
      const replay = await transaction.computeAuthOperation.findUnique({
        where: { id: request.operationId }
      })
      if (replay) {
        assertOperationBinding(replay, providerId, 'create_password', request.requestFingerprint)
        const existing = await transaction.computeHost.findUnique({
          where: { providerId: replay.providerId }
        })
        if (!existing) throw new Error('The prior credential operation result is unavailable.')
        return existing
      }
      const duplicate = await transaction.computeHost.findUnique({ where: { providerId } })
      if (duplicate) {
        throw new Error(`A host with alias "${alias}" is already registered.`)
      }
      const host = await transaction.computeHost.create({
        data: {
          providerId,
          displayName: request.displayName?.trim() || alias,
          sshAlias: alias,
          sshOverrides: serializeOverrides({ user: request.username, port: request.port }),
          authenticationMode: 'password',
          authenticationRevision: 1,
          lastVerifiedAt: request.verifiedAt,
          detailsDoc,
          detailsUpdatedBy: detailsDoc ? 'user' : null,
          detailsUpdatedAt: detailsDoc ? request.verifiedAt : null,
          credential: { create: { ciphertext: new Uint8Array(request.ciphertext) } }
        }
      })
      await transaction.computeAuthOperation.create({
        data: {
          id: request.operationId,
          providerId,
          operationKind: 'create_password',
          requestFingerprint: request.requestFingerprint,
          resultRevision: 1
        }
      })
      return host
    })
    return toHost(row, true)
  }

  async getCredential(
    computeHostId: string
  ): Promise<{ ciphertext: Buffer; revision: number } | null> {
    const client = await this.getClient()
    const host = await client.computeHost.findUnique({
      where: { id: computeHostId },
      select: {
        authenticationRevision: true,
        credential: { select: { ciphertext: true } }
      }
    })
    return host?.credential
      ? {
          ciphertext: Buffer.from(host.credential.ciphertext),
          revision: host.authenticationRevision
        }
      : null
  }

  async clearAuthenticationFailure(providerId: string): Promise<void> {
    const client = await this.getClient()
    await client.computeHost.update({ where: { providerId }, data: { probeResult: null } })
  }

  async updateAuthenticationFailure(
    providerId: string,
    authenticationRevision: number,
    result: ProbeResult,
    shape: ComputeHostShape
  ): Promise<boolean> {
    const client = await this.getClient()
    const updated = await client.computeHost.updateMany({
      where: { providerId, authenticationRevision },
      data: {
        probeResult: serializeProbeResult(result),
        shape
      }
    })
    return updated.count === 1
  }

  async preparePasswordReset(
    request: PreparePasswordResetRequest
  ): Promise<PasswordResetPreparation> {
    const client = await this.getClient()
    const replay = await client.computeAuthOperation.findUnique({
      where: { id: request.operationId }
    })
    if (replay && replay.providerId !== request.providerId) {
      throw new ComputeConnectionError('credential_conflict')
    }
    if (replay) {
      assertOperationBinding(
        replay,
        request.providerId,
        'reset_password',
        request.requestFingerprint
      )
    }
    const row = await client.computeHost.findUnique({ where: { providerId: request.providerId } })
    if (!row || row.authenticationMode !== 'password') {
      throw new ComputeConnectionError('credential_required')
    }
    if (replay) {
      if (
        replay.resultRevision !== request.expectedAuthenticationRevision + 1 ||
        row.authenticationRevision !== replay.resultRevision
      ) {
        throw new ComputeConnectionError('credential_conflict')
      }
      return { kind: 'replay', host: toHost(row, true) }
    }
    if (row.authenticationRevision !== request.expectedAuthenticationRevision) {
      throw new ComputeConnectionError('credential_conflict')
    }
    return { kind: 'ready', host: toHost(row, true) }
  }

  async resetPasswordHost(request: ResetPasswordHostPersistence): Promise<ComputeHost> {
    const client = await this.getClient()
    const row = await client.$transaction(async (transaction) => {
      const replay = await transaction.computeAuthOperation.findUnique({
        where: { id: request.operationId }
      })
      if (replay) {
        assertOperationBinding(
          replay,
          request.providerId,
          'reset_password',
          request.requestFingerprint
        )
        if (replay.resultRevision !== request.expectedAuthenticationRevision + 1) {
          throw new ComputeConnectionError('credential_conflict')
        }
        const existing = await transaction.computeHost.findUnique({
          where: { providerId: request.providerId }
        })
        if (!existing) throw new ComputeConnectionError('credential_required')
        if (existing.authenticationRevision !== replay.resultRevision) {
          throw new ComputeConnectionError('credential_conflict')
        }
        return existing
      }
      const current = await transaction.computeHost.findUnique({
        where: { providerId: request.providerId }
      })
      if (
        !current ||
        current.authenticationMode !== 'password' ||
        current.authenticationRevision !== request.expectedAuthenticationRevision
      ) {
        throw new ComputeConnectionError(current ? 'credential_conflict' : 'credential_required')
      }
      await transaction.computeCredential.upsert({
        where: { computeHostId: current.id },
        create: {
          computeHostId: current.id,
          ciphertext: new Uint8Array(request.ciphertext)
        },
        update: { ciphertext: new Uint8Array(request.ciphertext) }
      })
      const updated = await transaction.computeHost.update({
        where: { id: current.id },
        data: {
          authenticationRevision: { increment: 1 },
          lastVerifiedAt: request.verifiedAt,
          probeResult: null
        }
      })
      await transaction.computeAuthOperation.create({
        data: {
          id: request.operationId,
          providerId: request.providerId,
          operationKind: 'reset_password',
          requestFingerprint: request.requestFingerprint,
          resultRevision: request.expectedAuthenticationRevision + 1
        }
      })
      return updated
    })
    return toHost(row, true)
  }

  async replayAuthenticationChange(
    operationId: string,
    providerId: string,
    requestFingerprint: string
  ): Promise<ComputeHost | null> {
    const client = await this.getClient()
    const operation = await client.computeAuthOperation.findUnique({ where: { id: operationId } })
    if (!operation) return null
    assertOperationBinding(operation, providerId, 'change_authentication', requestFingerprint)
    const host = await client.computeHost.findUnique({ where: { providerId } })
    if (!host) throw new ComputeConnectionError('credential_conflict')
    if (host.authenticationRevision !== operation.resultRevision) {
      throw new ComputeConnectionError('credential_conflict')
    }
    return toHost(host, host.authenticationMode === 'password')
  }

  async changeAuthentication(
    request: ChangeComputeHostAuthenticationPersistence
  ): Promise<ComputeHost> {
    const client = await this.getClient()
    const row = await client.$transaction(async (transaction) => {
      const replay = await transaction.computeAuthOperation.findUnique({
        where: { id: request.operationId }
      })
      if (replay) {
        assertOperationBinding(
          replay,
          request.providerId,
          'change_authentication',
          request.requestFingerprint
        )
        const replayHost = await transaction.computeHost.findUnique({
          where: { providerId: request.providerId }
        })
        if (!replayHost) throw new ComputeConnectionError('credential_conflict')
        if (replayHost.authenticationRevision !== replay.resultRevision) {
          throw new ComputeConnectionError('credential_conflict')
        }
        return replayHost
      }

      const current = await transaction.computeHost.findUnique({
        where: { providerId: request.providerId }
      })
      if (!current) {
        throw new Error(`No compute host found with provider id "${request.providerId}".`)
      }
      if (current.authenticationRevision !== request.expectedRevision) {
        throw new ComputeConnectionError('credential_conflict')
      }
      const blockingJobs = await transaction.computeJob.count({
        where: {
          providerId: request.providerId,
          OR: [
            { status: { in: ['queued', 'submitted', 'running'] } },
            {
              status: { in: ['success', 'failed', 'timeout'] },
              harvestedAt: null
            },
            { remoteCleanupDisposition: 'pending' }
          ]
        }
      })
      if (blockingJobs > 0) {
        throw new ComputeConnectionError('credential_change_blocked_by_jobs')
      }

      const updated = await transaction.computeHost.updateMany({
        where: {
          id: current.id,
          authenticationRevision: request.expectedRevision
        },
        data: {
          sshOverrides: serializeOverrides({
            user: request.username,
            port: request.port,
            ...(request.authenticationMode === 'ssh_config' && request.identityFile
              ? { identityFile: request.identityFile }
              : {})
          }),
          authenticationMode: request.authenticationMode,
          authenticationRevision: { increment: 1 },
          lastVerifiedAt: request.verifiedAt,
          probeResult: null
        }
      })
      if (updated.count !== 1) throw new ComputeConnectionError('credential_conflict')

      if (request.authenticationMode === 'password') {
        if (!request.ciphertext) throw new ComputeConnectionError('credential_required')
        await transaction.computeCredential.upsert({
          where: { computeHostId: current.id },
          create: {
            computeHostId: current.id,
            ciphertext: new Uint8Array(request.ciphertext)
          },
          update: { ciphertext: new Uint8Array(request.ciphertext) }
        })
      } else {
        await transaction.computeCredential.deleteMany({ where: { computeHostId: current.id } })
      }
      await transaction.$executeRawUnsafe(
        `DELETE FROM "PermissionGrant"
         WHERE "capabilityKind" = ? AND "capabilityKey" LIKE ? ESCAPE '\\'`,
        'execution',
        `exec:compute/${escapeSqlLike(request.providerId)}/%`
      )
      await transaction.computeAuthOperation.create({
        data: {
          id: request.operationId,
          providerId: request.providerId,
          operationKind: 'change_authentication',
          requestFingerprint: request.requestFingerprint,
          resultRevision: request.expectedRevision + 1
        }
      })
      const committed = await transaction.computeHost.findUnique({
        where: { providerId: request.providerId }
      })
      if (!committed) throw new ComputeConnectionError('credential_conflict')
      return committed
    })
    return toHost(row, row.authenticationMode === 'password')
  }

  // Removes a host row by provider id.
  async delete(providerId: string): Promise<void> {
    const client = await this.getClient()
    await client.$transaction(async (transaction) => {
      const host = await transaction.computeHost.findUnique({
        where: { providerId },
        select: { id: true }
      })
      if (!host) return
      await transaction.computeCredential.deleteMany({ where: { computeHostId: host.id } })
      await transaction.computeAuthOperation.deleteMany({ where: { providerId } })
      await transaction.$executeRawUnsafe(
        `DELETE FROM "PermissionGrant"
         WHERE "capabilityKind" = ? AND "capabilityKey" LIKE ? ESCAPE '\\'`,
        'execution',
        `exec:compute/${escapeSqlLike(providerId)}/%`
      )
      await transaction.computeHost.delete({ where: { providerId } })
    })
  }

  // Defensive startup repair for databases copied with foreign-key enforcement disabled or
  // interrupted legacy writes. The normal one-to-one FK prevents these rows from being created.
  async cleanupOrphanCredentials(): Promise<number> {
    const client = await this.getClient()
    return client.$executeRawUnsafe(
      `DELETE FROM "ComputeCredential"
       WHERE NOT EXISTS (
         SELECT 1 FROM "ComputeHost"
         WHERE "ComputeHost"."id" = "ComputeCredential"."computeHostId"
       )`
    )
  }

  // Writes the structured probe snapshot and inferred shape. Never touches detailsDoc (design.md §4).
  async updateProbeResult(
    providerId: string,
    result: ProbeResult,
    shape: ComputeHostShape
  ): Promise<void> {
    const client = await this.getClient()

    if (Number.isInteger(result.authenticationRevision)) {
      await client.computeHost.updateMany({
        where: { providerId, authenticationRevision: result.authenticationRevision },
        data: {
          probeResult: serializeProbeResult(result),
          shape
        }
      })
      return
    }
    await client.computeHost.update({
      where: { providerId },
      data: {
        probeResult: serializeProbeResult(result),
        shape
      }
    })
  }

  // Updates scratchRoot when the probe reads $SCRATCH and scratchPinned is false. Probe callers
  // must check scratchPinned before calling (ComputeService.probe does this).
  async updateScratchRoot(providerId: string, scratchRoot: string): Promise<void> {
    const safeScratchRoot = assertSafeScratchRoot(scratchRoot)
    const client = await this.getClient()

    await client.computeHost.update({
      where: { providerId },
      data: { scratchRoot: safeScratchRoot }
    })
  }

  // Writes detailsDoc and records who edited it (user or agent) and when. Called by
  // ComputeService.replaceDetails (UI + agent-facing). Never called by probe.
  async updateDetails(
    providerId: string,
    detailsDoc: string,
    author: DetailsAuthor
  ): Promise<void> {
    const client = await this.getClient()

    await client.computeHost.update({
      where: { providerId },
      data: {
        detailsDoc,
        detailsUpdatedBy: author,
        detailsUpdatedAt: new Date()
      }
    })
  }

  // Updates scratchRoot and sets scratchPinned=true. Called when the user explicitly sets a
  // scratch path in the UI — pinned hosts are never overwritten by probe.
  async updateScratchPinned(providerId: string, scratchRoot: string): Promise<void> {
    const safeScratchRoot = assertSafeScratchRoot(scratchRoot)
    const client = await this.getClient()

    await client.computeHost.update({
      where: { providerId },
      data: { scratchRoot: safeScratchRoot, scratchPinned: true }
    })
  }

  async clearScratchRoot(providerId: string): Promise<void> {
    const client = await this.getClient()

    await client.computeHost.update({
      where: { providerId },
      data: { scratchRoot: null, scratchPinned: false }
    })
  }

  // Persists the concurrent job limit (1..500). ConcurrencyManager validates and enforces it in the
  // production job path; repository-only callers must validate the range before calling.
  async updateConcurrencyLimit(providerId: string, concurrencyLimit: number): Promise<void> {
    const client = await this.getClient()

    await client.computeHost.update({
      where: { providerId },
      data: { concurrencyLimit }
    })
  }
}

export { ComputeHostRepository, toHost }
export type { ComputeHostClient, ComputeHostClientProvider }
