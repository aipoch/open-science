import { DatabaseValidationError } from './database-validation-error'
import { migrationSqlExecutor, type MigrationSqlClient } from './migration-sql-executor'
import {
  PRE_RELEASE_MEMORY_ENTRY_REBUILD_DDLS,
  PRE_RELEASE_MEMORY_ENTRY_REPLACEMENT_TABLE
} from './migrations/0016-agent-memory-project-scope'

const PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID = '0016_agent_memory'
const PRE_RELEASE_AGENT_MEMORY_CATEGORY_ONLY_CHECKSUM =
  '7cc61c23b294792e4675d0d80968b6365a43e4fc92e8cf27e31668706b453267'
const PRE_RELEASE_AGENT_MEMORY_PROJECT_SCOPE_CHECKSUM =
  '43bd42fc137a0a88fb513f701db6e3e19ed3bdb5b8ead5691b5fad3fb68fb01a'
const PRE_RELEASE_AGENT_MEMORY_CHECKSUMS = new Set([
  PRE_RELEASE_AGENT_MEMORY_CATEGORY_ONLY_CHECKSUM,
  PRE_RELEASE_AGENT_MEMORY_PROJECT_SCOPE_CHECKSUM
])
const PRE_RELEASE_MEMORY_ENTRY_COLUMNS = [
  'id',
  'categoryId',
  'content',
  'contentKey',
  'origin',
  'sourceSessionId',
  'sourceAgentId',
  'revision',
  'createdAt',
  'updatedAt'
] as const
const MEMORY_CONTENT_KEY_MAX_LENGTH = 4000
type SqliteColumnRow = { name: string }
type CountRow = { count: bigint | number }
type PreReleaseAgentIdentityRow = {
  sourceRowId: bigint | number
  id: string
  projectId: string
  contentKey: string
}
type ContentKeyUpdate = { id: string; contentKey: string }

const isSupportedPreReleaseAgentMemory = (id: string, checksum: string): boolean =>
  id === PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID && PRE_RELEASE_AGENT_MEMORY_CHECKSUMS.has(checksum)

const readCount = async (client: MigrationSqlClient, sql: string): Promise<bigint> => {
  const rows = await migrationSqlExecutor.query<CountRow[]>(client, sql)
  return BigInt(rows[0]?.count ?? 0)
}

const validatePreReleaseMemoryEntryShape = async (client: MigrationSqlClient): Promise<void> => {
  const columns = await migrationSqlExecutor.query<SqliteColumnRow[]>(
    client,
    `PRAGMA table_info("MemoryEntry")`
  )
  const actual = columns.map(({ name }) => name)
  if (
    actual.length !== PRE_RELEASE_MEMORY_ENTRY_COLUMNS.length ||
    actual.some((name, index) => name !== PRE_RELEASE_MEMORY_ENTRY_COLUMNS[index])
  ) {
    throw new DatabaseValidationError(
      'Pre-release agent memory migration was blocked by an unexpected MemoryEntry shape.',
      {
        kind: 'pre-release-agent-memory-shape-mismatch',
        table: 'MemoryEntry',
        expected: PRE_RELEASE_MEMORY_ENTRY_COLUMNS,
        actual
      }
    )
  }
}

const validateAgentProjectBackfill = async (client: MigrationSqlClient): Promise<void> => {
  const missingSessionCount = await readCount(
    client,
    `SELECT COUNT(*) AS "count"
     FROM "MemoryEntry" e
     LEFT JOIN "Session" s ON s."id" = e."sourceSessionId"
     WHERE e."origin" = 'agent' AND s."id" IS NULL`
  )
  if (missingSessionCount === 0n) return

  throw new DatabaseValidationError(
    'Pre-release agent memory project classification blocked because a source Session is missing.',
    {
      kind: 'pre-release-agent-memory-session-missing',
      table: 'MemoryEntry',
      expected: 0,
      actual: missingSessionCount
    }
  )
}

const buildLegacyDuplicateContentKey = (
  contentKey: string,
  sourceRowId: bigint | number,
  attempt: bigint
): string => {
  const rowIdHex = BigInt.asUintN(64, BigInt(sourceRowId)).toString(16).padStart(16, '0')
  const suffix = `\u001flegacy:${rowIdHex}${attempt === 0n ? '' : `:${attempt}`}`
  return `${Array.from(contentKey)
    .slice(0, MEMORY_CONTENT_KEY_MAX_LENGTH - suffix.length)
    .join('')}${suffix}`
}

const planPreReleaseProjectIdentity = async (
  client: MigrationSqlClient
): Promise<ContentKeyUpdate[]> => {
  const rows = await migrationSqlExecutor.query<PreReleaseAgentIdentityRow[]>(
    client,
    `SELECT e."rowid" AS "sourceRowId", e."id", s."projectId", e."contentKey"
     FROM "MemoryEntry" e
     JOIN "Session" s ON s."id" = e."sourceSessionId"
     WHERE e."origin" = 'agent'
     ORDER BY s."projectId", e."contentKey", e."createdAt", e."id"`
  )
  const assignedKeysByProject = new Map<string, Set<string>>()
  const seenKeysByProject = new Map<string, Set<string>>()

  for (const { projectId, contentKey } of rows) {
    const assigned = assignedKeysByProject.get(projectId) ?? new Set<string>()
    assigned.add(contentKey)
    assignedKeysByProject.set(projectId, assigned)
  }

  const updates: ContentKeyUpdate[] = []
  for (const row of rows) {
    const seen = seenKeysByProject.get(row.projectId) ?? new Set<string>()
    seenKeysByProject.set(row.projectId, seen)
    if (!seen.has(row.contentKey)) {
      seen.add(row.contentKey)
      continue
    }

    const assigned = assignedKeysByProject.get(row.projectId)!
    let attempt = 0n
    let candidate = buildLegacyDuplicateContentKey(row.contentKey, row.sourceRowId, attempt)
    while (assigned.has(candidate)) {
      attempt += 1n
      candidate = buildLegacyDuplicateContentKey(row.contentKey, row.sourceRowId, attempt)
    }
    assigned.add(candidate)
    updates.push({ id: row.id, contentKey: candidate })
  }
  return updates
}

const validateReplacementProjectIdentity = async (client: MigrationSqlClient): Promise<void> => {
  const duplicateCount = await readCount(
    client,
    `SELECT COUNT(*) AS "count"
     FROM (
       SELECT 1
       FROM "${PRE_RELEASE_MEMORY_ENTRY_REPLACEMENT_TABLE}"
       WHERE "projectId" IS NOT NULL
       GROUP BY "projectId", "contentKey"
       HAVING COUNT(*) > 1
     )`
  )
  if (duplicateCount === 0n) return

  throw new DatabaseValidationError(
    'Pre-release agent memory migration could not establish unique project content identity.',
    {
      kind: 'pre-release-agent-memory-project-identity-conflict',
      table: 'MemoryEntry',
      expected: 0,
      actual: duplicateCount
    }
  )
}

const rebuildPreReleaseMemoryEntry = async (client: MigrationSqlClient): Promise<void> => {
  await validatePreReleaseMemoryEntryShape(client)
  await validateAgentProjectBackfill(client)
  const sourceRowCount = await readCount(client, 'SELECT COUNT(*) AS "count" FROM "MemoryEntry"')
  const contentKeyUpdates = await planPreReleaseProjectIdentity(client)

  // The FTS content table uses MemoryEntry rowids, so rebuild it after the canonical table swap.
  for (const statement of PRE_RELEASE_MEMORY_ENTRY_REBUILD_DDLS.beforeCopy) {
    await migrationSqlExecutor.execute(client, statement)
  }
  await migrationSqlExecutor.execute(
    client,
    `INSERT INTO "${PRE_RELEASE_MEMORY_ENTRY_REPLACEMENT_TABLE}" (
       "id", "categoryId", "projectId", "content", "contentKey", "origin",
       "sourceSessionId", "sourceAgentId", "revision", "createdAt", "updatedAt"
     )
     SELECT e."id", e."categoryId",
       CASE WHEN e."origin" = 'agent' THEN s."projectId" ELSE NULL END,
       e."content", e."contentKey", e."origin", e."sourceSessionId", e."sourceAgentId",
       e."revision", e."createdAt", e."updatedAt"
     FROM "MemoryEntry" e
     LEFT JOIN "Session" s ON s."id" = e."sourceSessionId"`
  )
  for (const update of contentKeyUpdates) {
    const updated = await migrationSqlExecutor.execute(
      client,
      `UPDATE "${PRE_RELEASE_MEMORY_ENTRY_REPLACEMENT_TABLE}"
       SET "contentKey" = ? WHERE "id" = ?`,
      update.contentKey,
      update.id
    )
    if (updated !== 1) {
      throw new DatabaseValidationError(
        'Pre-release agent memory migration could not update a duplicate content identity.',
        {
          kind: 'pre-release-agent-memory-content-key-update-mismatch',
          table: 'MemoryEntry',
          expected: 1,
          actual: updated
        }
      )
    }
  }
  const replacementRowCount = await readCount(
    client,
    `SELECT COUNT(*) AS "count" FROM "${PRE_RELEASE_MEMORY_ENTRY_REPLACEMENT_TABLE}"`
  )
  if (replacementRowCount !== sourceRowCount) {
    throw new DatabaseValidationError(
      'Pre-release agent memory migration found a row-count mismatch.',
      {
        kind: 'row-count-mismatch',
        table: 'MemoryEntry',
        expected: sourceRowCount,
        actual: replacementRowCount
      }
    )
  }
  await validateReplacementProjectIdentity(client)

  for (const statement of PRE_RELEASE_MEMORY_ENTRY_REBUILD_DDLS.afterCopy) {
    await migrationSqlExecutor.execute(client, statement)
  }
  await migrationSqlExecutor.execute(
    client,
    `INSERT INTO "MemoryEntryFts"("MemoryEntryFts", "rank") VALUES('secure-delete', 1)`
  )
  await migrationSqlExecutor.execute(
    client,
    `INSERT INTO "MemoryEntryFts"("MemoryEntryFts") VALUES('rebuild')`
  )
}

const upgradePreReleaseAgentMemorySchema = async (
  client: MigrationSqlClient,
  checksum: string
): Promise<void> => {
  if (checksum === PRE_RELEASE_AGENT_MEMORY_CATEGORY_ONLY_CHECKSUM) {
    await rebuildPreReleaseMemoryEntry(client)
    return
  }
  if (checksum !== PRE_RELEASE_AGENT_MEMORY_PROJECT_SCOPE_CHECKSUM) {
    throw new Error('Unsupported pre-release agent memory migration checksum.')
  }
}

export {
  isSupportedPreReleaseAgentMemory,
  PRE_RELEASE_AGENT_MEMORY_MIGRATION_ID,
  upgradePreReleaseAgentMemorySchema
}
