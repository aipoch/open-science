import { createHash, randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  EXACT_PERMISSION_QUALIFIER_PATTERN,
  PERMISSION_CAPABILITY_KINDS,
  type PermissionCapability,
  type PermissionGrantContext,
  type PermissionGrantMatch,
  type PermissionGrantMutationConflict,
  type PermissionGrantMutationResult,
  type PermissionGrantOwner,
  type PermissionGrantRecord,
  type PermissionGrantScope,
  type PermissionGrantUndoReceipt,
  type ExtendPermissionGrantUndo,
  type RememberPermissionGrant,
  type RestorePermissionGrants,
  type RevokePermissionGrants
} from '../../shared/permission-grants'

type PermissionGrantRow = {
  id: string
  capabilityKind: string
  capabilityKey: string
  qualifierMode: string
  qualifierValue: string | null
  scopeKind: string
  projectId: string | null
  sessionId: string | null
  fingerprint: string
  revision: number | bigint
  createdAt: Date | string | null
}

type PermissionGrantRegistryOptions = {
  getClient: () => Promise<PrismaClient>
  createId?: () => string
  createUndoToken?: () => string
  now?: () => Date
  receiptTtlMs?: number
  isScopeLive?: (scope: PermissionGrantScope) => Promise<boolean>
}

type PermissionGrantRegistry = {
  resolve(
    capability: PermissionCapability,
    context: PermissionGrantContext
  ): Promise<PermissionGrantMatch | undefined>
  remember(command: RememberPermissionGrant): Promise<PermissionGrantRecord>
  list(): Promise<PermissionGrantRecord[]>
  listCached(): PermissionGrantRecord[]
  revoke(command: RevokePermissionGrants): Promise<PermissionGrantMutationResult>
  extendUndo(command: ExtendPermissionGrantUndo): Promise<PermissionGrantUndoReceipt | undefined>
  restore(command: RestorePermissionGrants): Promise<PermissionGrantMutationResult>
  prune(owner: PermissionGrantOwner): Promise<PermissionGrantRecord[]>
  finalizeOwnerDeletion(owner: PermissionGrantOwner): Promise<void>
  subscribe(listener: () => void): () => void
}

class PermissionGrantTargetUnavailableError extends Error {
  constructor() {
    super('Permission grant target no longer exists.')
    this.name = 'PermissionGrantTargetUnavailableError'
  }
}

type RevocationReceipt = {
  rows: PermissionGrantRow[]
  expiresAt: number
}

const CAPABILITY_KINDS = new Set<string>(PERMISSION_CAPABILITY_KINDS)

const qualifierColumns = (
  capability: PermissionCapability
): { mode: 'none' | 'any' | 'category' | 'exact'; value: string | null } => {
  const qualifier = capability.qualifier
  if (!qualifier) return { mode: 'none', value: null }
  if (qualifier.mode === 'any') return { mode: 'any', value: null }

  const value = qualifier.value.trim()
  if (!value) throw new Error('Permission capability qualifier value is required.')
  if (qualifier.mode === 'exact' && !EXACT_PERMISSION_QUALIFIER_PATTERN.test(value)) {
    throw new Error('Exact permission qualifiers must be a versioned SHA-256 digest.')
  }
  return { mode: qualifier.mode, value }
}

const validateCapability = (capability: PermissionCapability): void => {
  if (!CAPABILITY_KINDS.has(capability.kind)) {
    throw new Error(`Unsupported permission capability kind: ${String(capability.kind)}`)
  }
  if (!capability.key.trim()) throw new Error('Permission capability key is required.')
  qualifierColumns(capability)
}

const scopeColumns = (
  scope: PermissionGrantScope
): { projectId: string | null; sessionId: string | null } => {
  if (scope.kind === 'global') return { projectId: null, sessionId: null }
  if (!scope.projectId.trim()) throw new Error('Permission Project scope requires projectId.')
  if (scope.kind === 'project') return { projectId: scope.projectId, sessionId: null }
  if (!scope.sessionId.trim()) throw new Error('Permission Session scope requires sessionId.')
  return { projectId: scope.projectId, sessionId: scope.sessionId }
}

const fingerprintFor = (capability: PermissionCapability, scope: PermissionGrantScope): string => {
  validateCapability(capability)
  const qualifier = qualifierColumns(capability)
  const target = scopeColumns(scope)
  const tuple = [
    'permission-grant:v1',
    capability.kind,
    capability.key,
    qualifier.mode,
    qualifier.value,
    scope.kind,
    target.projectId,
    target.sessionId
  ]

  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex')
}

const capabilityFromRow = (row: PermissionGrantRow): PermissionCapability => ({
  kind: row.capabilityKind as PermissionCapability['kind'],
  key: row.capabilityKey,
  ...(row.qualifierMode === 'any'
    ? { qualifier: { mode: 'any' as const } }
    : row.qualifierMode === 'category' || row.qualifierMode === 'exact'
      ? {
          qualifier: {
            mode: row.qualifierMode,
            value: row.qualifierValue ?? ''
          }
        }
      : {})
})

const scopeFromRow = (row: PermissionGrantRow): PermissionGrantScope => {
  if (row.scopeKind === 'global') return { kind: 'global' }
  if (row.scopeKind === 'project' && row.projectId) {
    return { kind: 'project', projectId: row.projectId }
  }
  if (row.scopeKind === 'session' && row.projectId && row.sessionId) {
    return { kind: 'session', projectId: row.projectId, sessionId: row.sessionId }
  }
  throw new Error(`Invalid persisted permission scope: ${row.scopeKind}`)
}

const recordFromRow = (row: PermissionGrantRow): PermissionGrantRecord => ({
  id: row.id,
  capability: capabilityFromRow(row),
  scope: scopeFromRow(row),
  ...(row.createdAt ? { createdAt: new Date(row.createdAt).getTime() } : {}),
  revision: Number(row.revision)
})

const sameCapability = (left: PermissionCapability, right: PermissionCapability): boolean => {
  const leftQualifier = qualifierColumns(left)
  const rightQualifier = qualifierColumns(right)
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    leftQualifier.mode === rightQualifier.mode &&
    leftQualifier.value === rightQualifier.value
  )
}

const scopeRank = (scope: PermissionGrantScope, context: PermissionGrantContext): number => {
  if (
    scope.kind === 'session' &&
    context.projectId === scope.projectId &&
    context.sessionId === scope.sessionId
  ) {
    return 3
  }
  if (scope.kind === 'project' && context.projectId === scope.projectId) return 2
  if (scope.kind === 'global') return 1
  return 0
}

const sortedRecords = (records: Iterable<PermissionGrantRecord>): PermissionGrantRecord[] =>
  Array.from(records).sort((left, right) => {
    const scopeOrder = { global: 0, project: 1, session: 2 }
    return (
      scopeOrder[left.scope.kind] - scopeOrder[right.scope.kind] ||
      left.capability.kind.localeCompare(right.capability.kind) ||
      left.capability.key.localeCompare(right.capability.key) ||
      left.id.localeCompare(right.id)
    )
  })

const findConflict = async (
  transaction: Prisma.TransactionClient,
  id: string
): Promise<PermissionGrantMutationConflict> => {
  const rows = await transaction.$queryRawUnsafe<Array<{ revision: number | bigint }>>(
    'SELECT "revision" FROM "PermissionGrant" WHERE "id" = ? LIMIT 1',
    id
  )
  return { id, reason: rows.length > 0 ? 'stale' : 'missing' }
}

const recordBelongsToOwner = (
  record: PermissionGrantRecord,
  owner: PermissionGrantOwner
): boolean => {
  if (owner.kind === 'project') {
    return record.scope.kind !== 'global' && record.scope.projectId === owner.projectId
  }
  if (owner.kind === 'session') {
    return (
      record.scope.kind === 'session' &&
      record.scope.projectId === owner.projectId &&
      record.scope.sessionId === owner.sessionId
    )
  }
  if (owner.kind === 'mcp_server') {
    return (
      record.capability.kind === 'mcp_tool' &&
      record.capability.key.startsWith(`mcp:${owner.serverId}/`)
    )
  }
  return (
    record.capability.kind === 'execution' &&
    record.capability.key.startsWith(`exec:compute/${owner.providerId}/`)
  )
}

const escapeLikePattern = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')

const createPermissionGrantRegistry = async (
  options: PermissionGrantRegistryOptions
): Promise<PermissionGrantRegistry> => {
  const initialClient = await options.getClient()
  const createId = options.createId ?? randomUUID
  const createUndoToken = options.createUndoToken ?? randomUUID
  const now = options.now ?? (() => new Date())
  const receiptTtlMs = options.receiptTtlMs ?? 8_000
  const rows = await initialClient.$queryRawUnsafe<PermissionGrantRow[]>(
    'SELECT * FROM "PermissionGrant"'
  )
  const records = new Map(rows.map((row) => [row.fingerprint, recordFromRow(row)]))
  const receipts = new Map<string, RevocationReceipt>()
  const listeners = new Set<() => void>()
  let mutationTail: Promise<void> = Promise.resolve()
  const runMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const publish = (): void => listeners.forEach((listener) => listener())
  const purgeExpiredReceipts = (at: number): void => {
    for (const [token, receipt] of receipts) {
      if (receipt.expiresAt <= at) receipts.delete(token)
    }
  }
  const invalidateReceiptsForOwner = (owner: PermissionGrantOwner): void => {
    for (const [token, receipt] of receipts) {
      const liveRows = receipt.rows.filter(
        (row) => !recordBelongsToOwner(recordFromRow(row), owner)
      )
      if (liveRows.length === receipt.rows.length) continue
      if (liveRows.length === 0) receipts.delete(token)
      else receipts.set(token, { ...receipt, rows: liveRows })
    }
  }
  const invalidateCachedOwner = (owner: PermissionGrantOwner): boolean => {
    let changed = false
    for (const [fingerprint, record] of records) {
      if (!recordBelongsToOwner(record, owner)) continue
      records.delete(fingerprint)
      changed = true
    }
    return changed
  }

  return {
    async resolve(capability, context) {
      validateCapability(capability)
      const matches = Array.from(records.values())
        .filter((record) => sameCapability(record.capability, capability))
        .map((grant) => ({ grant, rank: scopeRank(grant.scope, context) }))
        .filter(({ rank }) => rank > 0)
        .sort((left, right) => right.rank - left.rank)

      for (const match of matches) {
        if (!options.isScopeLive || (await options.isScopeLive(match.grant.scope))) {
          // Scope liveness can require storage I/O. A revoke/prune may complete while that check is
          // pending, so re-read the cache before releasing authority instead of returning the stale
          // record captured above.
          const current = records.get(fingerprintFor(match.grant.capability, match.grant.scope))
          if (current?.id === match.grant.id && current.revision === match.grant.revision) {
            return { grant: current, matchedScope: current.scope.kind }
          }
        }
      }

      return undefined
    },

    remember(command) {
      return runMutation(async () => {
        validateCapability(command.capability)
        if (options.isScopeLive && !(await options.isScopeLive(command.scope))) {
          throw new PermissionGrantTargetUnavailableError()
        }
        const qualifier = qualifierColumns(command.capability)
        const target = scopeColumns(command.scope)
        const fingerprint = fingerprintFor(command.capability, command.scope)
        const createdAt = now()
        const client = await options.getClient()

        const row = await client.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(
            `INSERT OR IGNORE INTO "PermissionGrant" (
              "id", "capabilityKind", "capabilityKey", "qualifierMode", "qualifierValue",
              "scopeKind", "projectId", "sessionId", "fingerprint", "revision", "createdAt"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            createId(),
            command.capability.kind,
            command.capability.key,
            qualifier.mode,
            qualifier.value,
            command.scope.kind,
            target.projectId,
            target.sessionId,
            fingerprint,
            createdAt
          )
          const [persisted] = await transaction.$queryRawUnsafe<PermissionGrantRow[]>(
            'SELECT * FROM "PermissionGrant" WHERE "fingerprint" = ? LIMIT 1',
            fingerprint
          )
          return persisted
        })
        if (!row) throw new Error('Permission grant write did not produce a durable record.')

        const record = recordFromRow(row)
        records.set(fingerprint, record)
        publish()
        return record
      })
    },

    async list() {
      return sortedRecords(records.values())
    },

    listCached() {
      return sortedRecords(records.values())
    },

    revoke(command) {
      return runMutation(async () => {
        const client = await options.getClient()
        const requested = Array.from(
          new Map(command.grants.map((grant) => [grant.id, grant])).values()
        )
        const result = await client.$transaction(async (transaction) => {
          const removed: PermissionGrantRow[] = []
          const conflicts: PermissionGrantMutationConflict[] = []

          for (const grant of requested) {
            const rows = await transaction.$queryRawUnsafe<PermissionGrantRow[]>(
              'DELETE FROM "PermissionGrant" WHERE "id" = ? AND "revision" = ? RETURNING *',
              grant.id,
              grant.revision
            )
            const row = rows[0]
            if (row) removed.push(row)
            else conflicts.push(await findConflict(transaction, grant.id))
          }

          return { removed, conflicts }
        })

        for (const row of result.removed) records.delete(row.fingerprint)

        const mutation: PermissionGrantMutationResult = {
          grants: sortedRecords(records.values()),
          conflicts: result.conflicts
        }
        if (result.removed.length > 0) {
          const revokedAt = now().getTime()
          purgeExpiredReceipts(revokedAt)
          const undoToken = createUndoToken()
          const expiresAt = revokedAt + receiptTtlMs
          receipts.set(undoToken, { rows: result.removed, expiresAt })
          mutation.receipt = { undoToken, expiresAt, revokedCount: result.removed.length }
          publish()
        }
        return mutation
      })
    },

    extendUndo(command) {
      return runMutation(async () => {
        const extendedAt = now().getTime()
        purgeExpiredReceipts(extendedAt)
        const receipt = receipts.get(command.undoToken)
        if (!receipt) return undefined

        const expiresAt = extendedAt + receiptTtlMs
        receipts.set(command.undoToken, { ...receipt, expiresAt })
        return {
          undoToken: command.undoToken,
          expiresAt,
          revokedCount: receipt.rows.length
        }
      })
    },

    restore(command) {
      return runMutation(async () => {
        const receipt = receipts.get(command.undoToken)
        if (!receipt) {
          return { grants: sortedRecords(records.values()), conflicts: [] }
        }
        if (receipt.expiresAt <= now().getTime()) {
          receipts.delete(command.undoToken)
          return { grants: sortedRecords(records.values()), conflicts: [] }
        }

        const liveRows: PermissionGrantRow[] = []
        const conflicts: PermissionGrantMutationConflict[] = []
        for (const row of receipt.rows) {
          if (!options.isScopeLive || (await options.isScopeLive(scopeFromRow(row)))) {
            liveRows.push(row)
          } else {
            conflicts.push({ id: row.id, reason: 'target-unavailable' })
          }
        }

        const client = await options.getClient()
        const restoredRows = await client.$transaction(async (transaction) => {
          const restored: PermissionGrantRow[] = []
          for (const row of liveRows) {
            const revision = Number(row.revision) + 1
            await transaction.$executeRawUnsafe(
              `INSERT OR IGNORE INTO "PermissionGrant" (
                "id", "capabilityKind", "capabilityKey", "qualifierMode", "qualifierValue",
                "scopeKind", "projectId", "sessionId", "fingerprint", "revision", "createdAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              row.id,
              row.capabilityKind,
              row.capabilityKey,
              row.qualifierMode,
              row.qualifierValue,
              row.scopeKind,
              row.projectId,
              row.sessionId,
              row.fingerprint,
              revision,
              row.createdAt
            )
            const [persisted] = await transaction.$queryRawUnsafe<PermissionGrantRow[]>(
              'SELECT * FROM "PermissionGrant" WHERE "fingerprint" = ? LIMIT 1',
              row.fingerprint
            )
            if (persisted) restored.push(persisted)
          }
          return restored
        })

        receipts.delete(command.undoToken)
        for (const row of restoredRows) records.set(row.fingerprint, recordFromRow(row))
        if (restoredRows.length > 0) publish()
        return { grants: sortedRecords(records.values()), conflicts }
      })
    },

    prune(owner) {
      return runMutation(async () => {
        const client = await options.getClient()
        const clauses: string[] = []
        const values: string[] = []
        if (owner.kind === 'project') {
          clauses.push('"projectId" = ?')
          values.push(owner.projectId)
        } else if (owner.kind === 'session') {
          clauses.push('"projectId" = ?', '"sessionId" = ?')
          values.push(owner.projectId, owner.sessionId)
        } else if (owner.kind === 'mcp_server') {
          clauses.push('"capabilityKind" = ?', '"capabilityKey" LIKE ? ESCAPE \'\\\'')
          values.push('mcp_tool', `mcp:${escapeLikePattern(owner.serverId)}/%`)
        } else {
          clauses.push('"capabilityKind" = ?', '"capabilityKey" LIKE ? ESCAPE \'\\\'')
          values.push('execution', `exec:compute/${escapeLikePattern(owner.providerId)}/%`)
        }

        const removed = await client.$queryRawUnsafe<PermissionGrantRow[]>(
          `DELETE FROM "PermissionGrant" WHERE ${clauses.join(' AND ')} RETURNING *`,
          ...values
        )
        const cacheChanged = invalidateCachedOwner(owner)
        // A grant can already be absent from the table because it is waiting in an Undo receipt. Remove
        // only rows owned by the deleted Connector/Compute/Project/Session so the receipt cannot recreate
        // stale authority while unrelated rows in the same batch remain independently restorable.
        invalidateReceiptsForOwner(owner)
        if (removed.length > 0 || cacheChanged) publish()
        return removed.map(recordFromRow)
      })
    },

    finalizeOwnerDeletion(owner) {
      // External owner deletion (notably the Project FK cascade) commits outside this Registry. Queue
      // the final cache barrier after every mutation that was already in flight, then make the barrier
      // best-effort: the owner is already gone, so surfacing a listener failure as a deletion failure
      // would violate the durable deletion-intent contract while the authority is already invalidated.
      return runMutation(async () => {
        const cacheChanged = invalidateCachedOwner(owner)
        invalidateReceiptsForOwner(owner)
        if (cacheChanged) publish()
      }).catch(() => undefined)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export { createPermissionGrantRegistry, fingerprintFor, PermissionGrantTargetUnavailableError }
export type { PermissionGrantRegistry, PermissionGrantRegistryOptions }
