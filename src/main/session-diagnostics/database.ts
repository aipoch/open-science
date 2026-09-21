import { lstatSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// Explicit metadata projections only. No credentials, content blobs or global state.
const tables: Record<string, string[]> = {
  Session: [
    'id',
    'projectId',
    'number',
    'status',
    'presentedStatus',
    'revision',
    'activeMessageCount',
    'artifactCount',
    'createdAtMs',
    'updatedAtMs',
    'needsStartupRecovery',
    'sourceByteLength',
    'sourceMtimeMs',
    'filesRevision',
    'presentedActivityAtMs',
    'deletedAtMs',
    'archivedAtMs'
  ],
  PendingSessionReconciliation: ['sessionId', 'projectId', 'operation', 'markedAt'],
  SessionRun: ['sessionId', 'messageId', 'createdAtMs'],
  SessionTurnUsage: [
    'sessionId',
    'messageId',
    'frameworkId',
    'providerId',
    'model',
    'completedAtMs',
    'inputTokens',
    'cacheTokens',
    'cachedReadTokens',
    'cachedWriteTokens',
    'outputTokens',
    'modelCallCount',
    'isRootFrame'
  ],
  SessionModelCallUsage: [
    'sessionId',
    'messageId',
    'callId',
    'callIndex',
    'sourceInvocationId',
    'backendId',
    'frameworkId',
    'providerId',
    'model',
    'inputTokens',
    'cacheTokens',
    'cachedReadTokens',
    'cachedWriteTokens',
    'outputTokens',
    'contextUsedTokens',
    'contextWindowSize'
  ],
  SessionAuxiliaryTurnUsage: [
    'sessionId',
    'eventId',
    'source',
    'frameworkId',
    'providerId',
    'model',
    'completedAtMs',
    'inputTokens',
    'cacheTokens',
    'cachedReadTokens',
    'cachedWriteTokens',
    'modelCallCount',
    'outputTokens'
  ],
  SessionArtifactRef: ['sessionId', 'artifactId', 'artifactCreatedAtMs'],
  FileOriginSession: [
    'projectId',
    'sessionId',
    'state',
    'deletedAt',
    'deletionOperationId',
    'createdAt',
    'updatedAt'
  ],
  ArtifactLineage: ['id', 'projectId', 'sessionId', 'currentVersionId', 'createdAt', 'updatedAt'],
  UploadFile: ['id', 'projectId', 'sessionId', 'currentVersionId', 'createdAt', 'updatedAt'],
  Review: [
    'id',
    'projectId',
    'sessionId',
    'turnMessageId',
    'lifecycle',
    'outcome',
    'model',
    'createdAt',
    'updatedAt'
  ],
  ComputeJob: [
    'id',
    'projectId',
    'sessionId',
    'providerId',
    'shape',
    'executionMode',
    'status',
    'exitCode',
    'errorCode',
    'analysisState',
    'analysisMessageId',
    'analysisUpdatedAt',
    'timeoutSeconds',
    'remoteCleanupDisposition',
    'notifiedAt',
    'notificationConsumedAt',
    'submittedAt',
    'harvestedAt',
    'createdAt',
    'startedAt',
    'finishedAt'
  ],
  ComputeJobOperation: [
    'id',
    'jobId',
    'kind',
    'phase',
    'outcome',
    'revision',
    'attemptCount',
    'eligibleAt',
    'claimExpiresAt',
    'createdAt',
    'settledAt',
    'updatedAt'
  ],
  Finding: [
    'id',
    'reviewId',
    'status',
    'resolution',
    'artifactVersionId',
    'artifactBindingState',
    'sortIndex',
    'reflagCount'
  ],
  BackgroundResultDelivery: [
    'id',
    'projectId',
    'sessionId',
    'sourceKind',
    'sourceId',
    'state',
    'attemptCount',
    'continuationMessageId',
    'createdAt',
    'updatedAt'
  ]
}

// Refuse recovery inputs and symlinks before SQLite opens the source. Never delete sidecars:
// WAL shared-memory coordination belongs to SQLite and the running application.
function openReadOnlyDatabase(path: string): DatabaseSync {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stat = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false })
    if (!stat) {
      if (!suffix) throw new Error('Database is missing')
      continue
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Database source or sidecar is not a regular file')
    if (suffix === '-journal' && stat.size > 0)
      throw new Error('Database rollback journal requires recovery; diagnostic query skipped')
  }
  const db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=25; PRAGMA temp_store=MEMORY')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export type DiagnosticDatabaseMetadata = {
  returnedCount: number
  truncationReasons: ('row-limit' | 'byte-limit' | 'cell-limit')[]
  timeRange?: { column: string; earliest: string; latest: string }
  missingColumns?: string[]
}

type DiagnosticDatabaseResult = {
  table: string
  rows?: unknown[]
  truncated?: boolean
  error?: string
  metadata?: DiagnosticDatabaseMetadata
}

function databaseFailure(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'errcode' in error ? error.errcode : undefined
  // SQLite primary result codes; never echo an exception's arbitrary source text.
  if (code === 5 || code === 6) return 'Database is busy; diagnostic query skipped'
  if (code === 11 || code === 26) return 'Database is corrupt or has an unsupported format'
  return 'Diagnostic table or version query unavailable'
}

// All expressions and identifiers below are application-owned constants, never input SQL.
function priorityOrder(table: string, available: Set<string>): string[] {
  if (table === 'ComputeJob' && available.has('status'))
    return [
      `CASE WHEN "status" IN ('error', 'failed', 'timeout', 'queued', 'submitted', 'running') THEN 0 ELSE 1 END`
    ]
  if (table === 'Review' && available.has('lifecycle'))
    return [
      available.has('outcome')
        ? `CASE WHEN "lifecycle" != 'complete' OR "outcome" = 'flagged' THEN 0 ELSE 1 END`
        : `CASE WHEN "lifecycle" != 'complete' THEN 0 ELSE 1 END`
    ]
  if (table === 'ComputeJobOperation' && available.has('phase'))
    return [`CASE WHEN "phase" != 'settled' THEN 0 ELSE 1 END`]
  if (table === 'BackgroundResultDelivery' && available.has('state'))
    return [`CASE WHEN "state" != 'consumed' THEN 0 ELSE 1 END`]
  return []
}

export function* readDiagnosticDatabase(
  path: string,
  projectId: string,
  sessionId: string
): Generator<DiagnosticDatabaseResult> {
  const db = openReadOnlyDatabase(path)
  try {
    for (const [table, allowedColumns] of Object.entries(tables)) {
      try {
        const available = new Set(
          (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
            (row) => row.name
          )
        )
        if (!available.size) throw new Error('Diagnostic table is unavailable')
        const columns = allowedColumns.filter((column) => available.has(column))
        const missingColumns = allowedColumns.filter((column) => !available.has(column))
        let scope: string
        let parameters: string[]
        if (table === 'ComputeJobOperation' || table === 'Finding') {
          const parent = table === 'Finding' ? 'Review' : 'ComputeJob'
          const foreign = table === 'Finding' ? 'reviewId' : 'jobId'
          scope = `"${foreign}" IN (SELECT "id" FROM "${parent}" WHERE "projectId" = ? AND "sessionId" = ?)`
          parameters = [projectId, sessionId]
        } else if (allowedColumns.includes('projectId')) {
          scope = `"projectId" = ? AND "${table === 'Session' ? 'id' : 'sessionId'}" = ?`
          parameters = [projectId, sessionId]
        } else {
          scope =
            '"sessionId" = ? AND NOT EXISTS (SELECT 1 FROM "Session" WHERE "id" = ? AND "projectId" != ?)'
          parameters = [sessionId, sessionId, projectId]
        }
        const timeColumn =
          table === 'SessionModelCallUsage'
            ? 'turnCompletedAtMs'
            : [
                'updatedAtMs',
                'updatedAt',
                'completedAtMs',
                'createdAtMs',
                'createdAt',
                'artifactCreatedAtMs',
                'markedAt'
              ].find((column) => columns.includes(column))
        const order = priorityOrder(table, available)
        if (table === 'SessionModelCallUsage') {
          // Recent owning turns first; callIndex only orders calls within that turn.
          order.push('"turnCompletedAtMs" DESC')
          order.push('"messageId" DESC', '"callIndex" ASC')
        } else if (timeColumn) order.push(`"${timeColumn}" DESC`)
        order.push(
          ...['id', 'messageId', 'callId', 'eventId', 'artifactId', 'sessionId']
            .filter((column) => columns.includes(column))
            .map((column) => `"${column}" DESC`)
        )
        const projection = columns.map(
          (column) =>
            `CASE WHEN length(CAST("${column}" AS BLOB)) > 16384 THEN '[omitted: cell limit]' ELSE "${column}" END AS "${column}"`
        )
        if (table === 'SessionModelCallUsage')
          projection.push(
            `(SELECT "completedAtMs" FROM "SessionTurnUsage" AS turn WHERE turn."sessionId" = "SessionModelCallUsage"."sessionId" AND turn."messageId" = "SessionModelCallUsage"."messageId") AS "turnCompletedAtMs"`
          )
        // Error bodies may contain credentials, research content, or OS-protected ciphertext.
        // Export presence/protection only; never fetch or decrypt those values.
        for (const column of table === 'ComputeJob'
          ? ['lastPollError', 'harvestError']
          : table === 'Review'
            ? ['errorMessage']
            : []) {
          if (available.has(column))
            projection.push(
              `("${column}" IS NOT NULL AND length("${column}") > 0) AS "${column}Present"`
            )
        }
        if (table === 'ComputeJob' && available.has('sensitiveDataEncrypted'))
          projection.push('"sensitiveDataEncrypted" AS "errorsProtected"')
        const statement = db.prepare(
          `SELECT ${projection.join(', ')} FROM "${table}" WHERE ${scope} ORDER BY ${order.join(', ')} LIMIT 1001`
        )
        statement.setReadBigInts(true)
        const iterator = statement.iterate(...parameters)
        const rows: Record<string, unknown>[] = []
        let bytes = 0
        const reasons = new Set<DiagnosticDatabaseMetadata['truncationReasons'][number]>()
        try {
          for (const row of iterator) {
            if (rows.length >= 1000) {
              reasons.add('row-limit')
              break
            }
            bytes += Buffer.byteLength(
              JSON.stringify(row, (_key, value) =>
                typeof value === 'bigint' ? value.toString() : value
              )
            )
            if (bytes > 4 * 1024 * 1024) {
              reasons.add('byte-limit')
              break
            }
            if (Object.values(row).includes('[omitted: cell limit]')) reasons.add('cell-limit')
            rows.push(row)
          }
        } finally {
          iterator.return?.()
        }
        const metadata: DiagnosticDatabaseMetadata = {
          returnedCount: rows.length,
          truncationReasons: [...reasons]
        }
        if (missingColumns.length) metadata.missingColumns = missingColumns
        if (timeColumn) {
          const times = rows
            .map((row) => row[timeColumn])
            .filter(
              (value): value is bigint | number | string =>
                typeof value === 'bigint' ||
                typeof value === 'number' ||
                (typeof value === 'string' && value !== '[omitted: cell limit]')
            )
          times.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          if (times.length)
            metadata.timeRange = {
              column: timeColumn,
              earliest: String(times[0]),
              latest: String(times[times.length - 1])
            }
        }
        yield { table, rows, truncated: reasons.size > 0, metadata }
      } catch (error) {
        yield { table, error: databaseFailure(error) }
      }
    }
    // Fixed read-only engine/schema versions, not settings, migration bodies, or global data.
    try {
      const versions: Record<string, unknown> = {
        sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get()?.version,
        userVersion: db.prepare('PRAGMA user_version').get()?.user_version,
        schemaVersion: db.prepare('PRAGMA schema_version').get()?.schema_version
      }
      try {
        versions.sessionProjectionVersion =
          db
            .prepare(
              "SELECT projectionVersion FROM SessionProjectionState WHERE id = 'session-projection' LIMIT 1"
            )
            .get()?.projectionVersion ?? null
      } catch {
        versions.sessionProjectionVersionUnavailable = true
      }
      yield {
        table: '_metadata',
        rows: [versions],
        metadata: { returnedCount: 1, truncationReasons: [] }
      }
    } catch (error) {
      yield {
        table: '_metadata',
        error: databaseFailure(error)
      }
    }
  } finally {
    db.close()
  }
}
