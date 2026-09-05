import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import {
  MIGRATION_MANIFEST,
  migrateApplicationDatabase,
  type MigrationManifestEntry
} from './migration-service'
import { applySqliteMigrationOperations } from './sqlite-schema-migrations'
import { visionEvidenceMigration } from './migrations/0009-vision-evidence'

type Row = Record<string, string | number | null>
const now = Date.now()
const rows: Record<string, Row> = {
  MemoryCategory: {
    id: 'category',
    systemKey: null,
    name: 'Research',
    nameKey: 'research',
    guidance: '',
    autoRecall: 1,
    updatedAt: now
  },
  ComputeJobOperation: {
    id: 'operation',
    jobId: 'job',
    kind: 'cancel',
    phase: 'settled',
    outcome: 'fulfilled',
    settledAt: now,
    updatedAt: now
  },
  SessionAuxiliaryTurnUsage: {
    sessionId: 'session',
    eventId: 'event',
    source: 'reviewer',
    frameworkId: 'codex-response',
    completedAtMs: 0,
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 5,
    cachedWriteTokens: 5
  },
  SessionModelCallUsage: {
    sessionId: 'session',
    messageId: 'message',
    callId: 'call',
    callIndex: 0,
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 5,
    cachedWriteTokens: 5
  },
  UploadVersion: {
    id: 'version',
    uploadFileId: 'upload',
    versionNumber: 1,
    state: 'ready',
    contentStorageKey: 'uploads/data',
    filename: 'data',
    originalFilename: 'data',
    sizeBytes: 0,
    checksum: 'a'.repeat(64),
    updatedAt: now
  },
  ArtifactVersion: {
    id: 'version',
    artifactId: 'artifact',
    versionNumber: 1,
    state: 'finalized',
    originKind: 'legacy',
    contentStorageKey: 'artifacts/data',
    filename: 'data',
    sizeBytes: 0,
    checksum: 'a'.repeat(64),
    updatedAt: now
  },
  ManagedFile: {
    source: 'upload',
    sourceFileId: 'upload',
    projectId: 'project',
    sessionId: 'session',
    displayName: 'data',
    storageKey: 'uploads/data',
    sizeBytes: 0,
    sortAtMs: 0,
    updatedAt: now
  },
  ManagedFileVersionWriteOperation: {
    operationId: 'write',
    source: 'upload',
    projectId: 'project',
    sourceFileId: 'upload',
    basedOnVersionId: 'version',
    expectedHeadVersionId: 'version',
    state: 'staging',
    storageTag: 'tag',
    storedFilename: 'data',
    contentStorageKey: 'uploads/write',
    checksum: 'a'.repeat(64),
    sizeBytes: 0,
    textFormatJson: '{}',
    updatedAt: now
  }
}
rows.ArtifactVersionInput = {
  id: 'input',
  artifactVersionId: 'version',
  ordinal: 0,
  inputFileVersionId: 'version',
  sourceKind: 'upload-version',
  sourceFileId: 'upload',
  sourceUploadVersionId: 'version',
  sourceVersionNumber: 1,
  sourceProjectId: 'project',
  sourceSessionId: 'session',
  filename: 'data',
  sizeBytes: 0,
  checksum: 'a'.repeat(64),
  storageKey: 'uploads/data',
  strongestAssociation: 'captured-version'
}
const nullCases: Array<[string, Row]> = [
  ['MemoryCategory', { name: null, nameKey: null }],
  ['ComputeJobOperation', { outcome: null }],
  ['SessionAuxiliaryTurnUsage', { cachedReadTokens: null }],
  ['SessionAuxiliaryTurnUsage', { cachedWriteTokens: null }],
  ['SessionModelCallUsage', { cachedReadTokens: null }],
  ['SessionModelCallUsage', { cachedWriteTokens: null }]
]
const numericCases: Array<[string, Row]> = [
  ['UploadVersion', { versionNumber: -1 }],
  ['UploadVersion', { versionNumber: 0 }],
  ['UploadVersion', { sizeBytes: -3 }],
  ['ArtifactVersion', { versionNumber: -1 }],
  ['ArtifactVersion', { versionNumber: 0 }],
  ['ArtifactVersion', { sizeBytes: -3 }],
  ['ArtifactVersionInput', { sizeBytes: -3 }],
  ['ArtifactVersionInput', { sourceVersionNumber: -1 }],
  ['ArtifactVersionInput', { sourceVersionNumber: 0 }],
  ['ManagedFile', { sizeBytes: -3 }],
  ['ManagedFileVersionWriteOperation', { sizeBytes: -3 }]
]

describe('D02/D04 persisted database boundaries', () => {
  let client: PrismaClient
  let root: string
  // Identifiers and rows are trusted test fixtures, never external input.
  const insert = (table: string, row: Row): Promise<number> =>
    client.$executeRawUnsafe(
      `INSERT INTO "${table}" (${Object.keys(row)
        .map((key) => `"${key}"`)
        .join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`,
      ...Object.values(row)
    )
  const prepare = async (table: string): Promise<void> => {
    if (table === 'ArtifactVersionInput') {
      await insert('UploadVersion', rows.UploadVersion!)
      await insert('ArtifactVersion', rows.ArtifactVersion!)
    }
  }
  const seedParents = async (): Promise<void> => {
    await insert('Project', { id: 'project', name: 'Project', updatedAt: now })
    await insert('Session', {
      id: 'session',
      number: 1,
      projectId: 'project',
      title: 'Session',
      status: 'idle',
      presentedStatus: 'idle',
      createdAtMs: 0,
      updatedAtMs: 0
    })
    await insert('SessionTurnUsage', {
      sessionId: 'session',
      messageId: 'message',
      completedAtMs: 0,
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      isRootFrame: 1
    })
    await insert('ComputeJob', {
      id: 'job',
      providerId: 'ssh:host',
      shape: 'direct_ssh',
      sessionId: 'session',
      projectId: 'project',
      status: 'success',
      intent: 'test',
      command: 'true',
      commandHash: 'hash'
    })
    await insert('FileOriginSession', {
      projectId: 'project',
      sessionId: 'session',
      updatedAt: now
    })
    await insert('UploadFile', {
      id: 'upload',
      projectId: 'project',
      sessionId: 'session',
      filename: 'data',
      originalFilename: 'data',
      updatedAt: now
    })
    await insert('ArtifactLineage', {
      id: 'artifact',
      projectId: 'project',
      sessionId: 'session',
      filename: 'data',
      normalizedFilename: 'data',
      updatedAt: now
    })
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-persisted-boundaries-'))
    client = createProjectDbClient(root)
  })

  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  describe('current schema', () => {
    beforeEach(async () => {
      await migrateApplicationDatabase(client)
      await seedParents()
    })
    describe.each(['INSERT', 'UPDATE'] as const)('%s', (operation) => {
      it.each([...nullCases, ...numericCases])('rejects %s %j', async (table, patch) => {
        await prepare(table)
        const row = rows[table]!
        if (operation === 'INSERT') {
          await expect(insert(table, { ...row, ...patch })).rejects.toThrow(
            /CHECK constraint failed/i
          )
        } else {
          await insert(table, row)
          await expect(
            client.$executeRawUnsafe(
              `UPDATE "${table}" SET ${Object.keys(patch)
                .map((key) => `"${key}" = ?`)
                .join(',')} WHERE "${Object.keys(row)[0]}" = ?`,
              ...Object.values(patch),
              Object.values(row)[0]
            )
          ).rejects.toThrow(/CHECK constraint failed/i)
        }
      })
    })

    it.each([...nullCases, ...numericCases])(
      'blocks startup with invalid persisted %s %j',
      async (table, patch) => {
        await prepare(table)
        // Emulate corruption/old accepted data without weakening the schema being verified.
        await client.$executeRawUnsafe('PRAGMA ignore_check_constraints = ON')
        try {
          await insert(table, { ...rows[table]!, ...patch })
        } finally {
          await client.$executeRawUnsafe('PRAGMA ignore_check_constraints = OFF')
        }
        await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
          code: 'database_validation_failed',
          retryable: false
        })
      }
    )

    it('accepts valid rows, including empty files and nullable cache pairs, on reopen', async () => {
      for (const [table, row] of Object.entries(rows)) {
        await insert(
          table,
          table.startsWith('Session')
            ? { ...row, cachedReadTokens: null, cachedWriteTokens: null }
            : row
        )
      }
      await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    })

    it.each([
      ['MemoryCategory', { name: null }],
      ['MemoryCategory', { nameKey: null }],
      ['MemoryCategory', { systemKey: 'unknown' }],
      ['ComputeJobOperation', { outcome: 'unknown' }],
      ['ComputeJobOperation', { settledAt: null }]
    ] as Array<[string, Row]>)('rejects other invalid shapes in %s %j', async (table, patch) => {
      await expect(insert(table, { ...rows[table]!, ...patch })).rejects.toThrow(
        /CHECK constraint failed/i
      )
    })
  })

  describe('released 0027 schema', () => {
    const migrationId = '0028_database_numeric_and_null_constraints'
    beforeEach(async () => {
      // Build history exclusively from released immutable entries, not today's generated DDL.
      const released: readonly MigrationManifestEntry[] = MIGRATION_MANIFEST.slice(
        0,
        MIGRATION_MANIFEST.findIndex(({ id }) => id === migrationId)
      )
      expect(released.at(-1)?.id).toBe('0027_project_session_defaults')
      await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
      for (const migration of released) {
        for (const statement of migration.statements) await client.$executeRawUnsafe(statement)
        await applySqliteMigrationOperations(client, migration.operations ?? [])
        // Match the released owner's repair after 0025 renames UploadVersion.
        if (migration.id === '0025_managed_file_version_foundation') {
          await applySqliteMigrationOperations(client, visionEvidenceMigration.operations)
        }
      }
      await client.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
        "id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL,
        "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "_open_science_migrations_checksum_check" CHECK (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
      )`)
      for (const migration of released)
        await client.$executeRawUnsafe(
          `INSERT INTO "_open_science_migrations" ("id", "checksum") VALUES (?, ?)`,
          migration.id,
          migration.checksum
        )
      await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
      await seedParents()
    })

    const readRows = (table: string): Promise<unknown[]> =>
      client.$queryRawUnsafe(`SELECT * FROM "${table}" ORDER BY 1`)

    it('upgrades valid legacy rows while retaining foreign keys, triggers, and allocator history', async () => {
      for (const [table, row] of Object.entries(rows)) await insert(table, row)
      await insert('MemoryEntry', {
        id: 'memory',
        categoryId: 'category',
        content: 'preserved research',
        contentKey: 'preserved research',
        origin: 'user',
        updatedAt: now
      })
      await client.$executeRawUnsafe(`UPDATE "UploadFile" SET "currentVersionId" = 'version'`)
      await client.$executeRawUnsafe(`UPDATE "ArtifactLineage" SET "currentVersionId" = 'version'`)
      await client.$executeRawUnsafe(
        `UPDATE "ArtifactVersionInput" SET "sourceVersionNumber" = NULL`
      )
      await client.$executeRawUnsafe(
        `UPDATE "SessionAuxiliaryTurnUsage" SET "cachedReadTokens" = NULL, "cachedWriteTokens" = NULL`
      )
      await client.$executeRawUnsafe(
        `UPDATE sqlite_sequence SET seq = 43 WHERE name = 'ManagedFile'`
      )
      await client.$executeRawUnsafe(`DELETE FROM "ManagedFile"`)
      const tables = [...Object.keys(rows), 'MemoryEntry', 'UploadFile', 'ArtifactLineage']
      const before = await Promise.all(tables.map(readRows))
      const ledger = await readRows('_open_science_migrations')
      await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
        applied: [migrationId],
        to: migrationId
      })
      expect(await Promise.all(tables.map(readRows))).toEqual(before)
      expect((await readRows('_open_science_migrations')).slice(0, -1)).toEqual(ledger)
      await expect(client.$queryRawUnsafe('PRAGMA foreign_key_check')).resolves.toEqual([])
      await expect(
        client.$executeRawUnsafe(
          `DELETE FROM "MemoryCategory" WHERE "id" = 'memory-category-about-you'`
        )
      ).rejects.toThrow('About you category cannot be deleted')
      await expect(
        client.$queryRawUnsafe(
          `SELECT "rowid" FROM "MemoryEntryFts" WHERE "MemoryEntryFts" MATCH 'preserved'`
        )
      ).resolves.toHaveLength(1)
      await insert('ManagedFile', rows.ManagedFile!)
      await expect(client.$queryRawUnsafe(`SELECT seq FROM "ManagedFile"`)).resolves.toEqual([
        { seq: 44 }
      ])
      await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    })

    it('rejects unknown historical columns without losing their data', async () => {
      await client.$executeRawUnsafe(
        `ALTER TABLE "MemoryCategory" ADD COLUMN "unrecognized" TEXT DEFAULT 'preserve'`
      )
      await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
        code: 'database_validation_failed',
        retryable: false
      })
      await expect(
        client.$queryRawUnsafe(`SELECT "unrecognized" FROM "MemoryCategory"`)
      ).resolves.toEqual([{ unrecognized: 'preserve' }])
    })

    it.each([...nullCases, ...numericCases])(
      'rolls back an upgrade containing invalid %s %j without deleting data',
      async (table, patch) => {
        await prepare(table)
        await insert(table, { ...rows[table]!, ...patch })
        const before = await readRows(table)
        const ledger = await readRows('_open_science_migrations')
        const schema = await client.$queryRawUnsafe(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`
        )
        await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
          code: 'database_validation_failed',
          retryable: false,
          migrationId,
          cause: expect.objectContaining({ data: { kind: 'check-constraint-violation', table } })
        })
        await expect(
          access(join(root, `open-science.db.before-${migrationId}.backup`))
        ).resolves.toBeUndefined()
        expect(await readRows(table)).toEqual(before)
        expect(await readRows('_open_science_migrations')).toEqual(ledger)
        expect(
          await client.$queryRawUnsafe(
            `SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`
          )
        ).toEqual(schema)
        await expect(client.$queryRawUnsafe('PRAGMA foreign_keys')).resolves.toEqual([
          { foreign_keys: 1n }
        ])
      }
    )
  })
})
