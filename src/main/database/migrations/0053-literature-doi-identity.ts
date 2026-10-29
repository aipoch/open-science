import { Prisma } from '@prisma/client'

import { normalizeLiteratureDoiKeyV1 } from '@aipoch/literature-citations/doi'
import { DatabaseValidationError } from '../database-validation-error'
import { migrationSqlExecutor } from '../migration-sql-executor'

const literatureDoiIdentityMigration = {
  id: '0053_literature_doi_identity',
  statements: [
    `-- Backfill DOI identity v1 from retained rawValue only: unwrap recognized resolver URLs once,
-- preserve punctuation and literal percent escapes, lowercase ASCII A-Z only, no Unicode normalization.
-- Preserve every row, raw value, primary flag, source, item metadata, revision and timestamp.
-- Reject same-item final aliases atomically; stage changed keys outside all existing and final keys.
-- Plan in a transaction-local temporary table, binding at most 500 rows per read or write batch.
UPDATE "LiteratureIdentifier" SET "normalizedValue" = "normalizedValue" WHERE 0`
  ],
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'LiteratureIdentifier', column: 'rawValue' },
    { kind: 'column-exists', version: 1, table: 'LiteratureIdentifier', column: 'normalizedValue' },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'LiteratureIdentifier_itemId_scheme_normalizedValue_key',
          sql: 'CREATE UNIQUE INDEX "LiteratureIdentifier_itemId_scheme_normalizedValue_key" ON "LiteratureIdentifier"("itemId", "scheme", "normalizedValue")'
        }
      ]
    }
  ] as const
}

type IdentifierRow = { id: string; itemId: string; rawValue: string; normalizedValue: string }
// Run inside the migration transaction for both released-ledger upgrades and current-schema adoption.
// SQLite owns the complete plan, so aliases cannot hide across bounded JavaScript batch boundaries.
const backfillLiteratureDoiIdentity = async (client: Prisma.TransactionClient): Promise<void> => {
  await migrationSqlExecutor.execute(
    client,
    `CREATE TEMP TABLE "_literature_doi_identity_v1" (
    id TEXT NOT NULL PRIMARY KEY, "itemId" TEXT NOT NULL, "key" TEXT NOT NULL,
    "temporaryKey" TEXT NOT NULL DEFAULT '', changed INTEGER NOT NULL
  )`
  )
  await migrationSqlExecutor.execute(
    client,
    `CREATE INDEX "_literature_doi_identity_v1_key"
    ON "_literature_doi_identity_v1"("key", "itemId")`
  )
  let cursor: string | undefined
  for (;;) {
    const rows = await client.$queryRaw<IdentifierRow[]>(Prisma.sql`
      SELECT id, "itemId", "rawValue", "normalizedValue" FROM "LiteratureIdentifier"
      WHERE scheme = 'doi' ${cursor === undefined ? Prisma.empty : Prisma.sql`AND id > ${cursor}`}
      ORDER BY id LIMIT 500`)
    if (!rows.length) break
    const values = rows.map((row) => {
      const key = normalizeLiteratureDoiKeyV1(row.rawValue)
      return { id: row.id, itemId: row.itemId, key, changed: Number(key !== row.normalizedValue) }
    })
    await client.$executeRaw`INSERT INTO "_literature_doi_identity_v1" (id, "itemId", "key", changed)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.itemId'),
        json_extract(value, '$.key'), json_extract(value, '$.changed')
      FROM json_each(${JSON.stringify(values)})`
    cursor = rows.at(-1)!.id
  }
  const aliases = await client.$queryRaw<{ id: string; itemId: string }[]>`
    SELECT plan.id, plan."itemId" FROM "_literature_doi_identity_v1" AS plan
    JOIN (SELECT "itemId", "key" FROM "_literature_doi_identity_v1"
      GROUP BY "itemId", "key" HAVING count(*) > 1 LIMIT 1) AS conflict
      ON conflict."itemId" = plan."itemId" AND conflict."key" = plan."key"
    ORDER BY plan.id LIMIT 2`
  if (aliases.length) {
    throw new DatabaseValidationError(
      'DOI identity migration blocked by duplicate DOI aliases for one item. All raw values are retained. Close Open Science and all database connections. If open-science.db.before-0053_literature_doi_identity.backup exists beside the application database, preserve it under a distinct unused archive name and verify the archived bytes match the original before making verified corrections with a SQLite-aware maintenance tool. If that file is absent, retain earlier migration backups. Do not overwrite or delete snapshots, invent a different DOI, or change only normalized keys; genuine aliases require an explicitly backed-up consolidation. Close the maintenance tool, then restart Open Science to create a fresh backup of the repaired database and retry. Retain archived snapshots manually.',
      {
        kind: 'literature-doi-identity-alias-conflict',
        table: 'LiteratureIdentifier',
        column: 'normalizedValue',
        constraint: 'LiteratureIdentifier_itemId_scheme_normalizedValue_key',
        actual: { itemId: aliases[0]!.itemId, identifierIds: aliases.map(({ id }) => id) }
      }
    )
  }
  // Even anomalous historical strings may look like staging keys. Prove the entire prefix safe
  // against every existing DOI key and every final key before touching the persistent table.
  let prefix = '__open_science_doi_v1_migration__:'
  for (;;) {
    await client.$executeRaw`UPDATE "_literature_doi_identity_v1"
      SET "temporaryKey" = ${prefix} || id WHERE changed = 1`
    const collision = await client.$queryRaw<{ id: string }[]>`
      SELECT plan.id FROM "_literature_doi_identity_v1" AS plan WHERE changed = 1 AND (
        EXISTS (SELECT 1 FROM "LiteratureIdentifier" AS existing
          WHERE existing.scheme = 'doi' AND existing."normalizedValue" = plan."temporaryKey")
        OR EXISTS (SELECT 1 FROM "_literature_doi_identity_v1" AS target
          WHERE target."key" = plan."temporaryKey")
      ) LIMIT 1`
    if (!collision.length) break
    prefix += '#'
  }
  for (const temporary of [true, false]) {
    cursor = undefined
    for (;;) {
      const updates: { id: string; key: string }[] = await client.$queryRaw<
        { id: string; key: string }[]
      >(Prisma.sql`
        SELECT id, ${temporary ? Prisma.sql`"temporaryKey"` : Prisma.sql`"key"`} AS "key"
        FROM "_literature_doi_identity_v1" WHERE changed = 1
        ${cursor === undefined ? Prisma.empty : Prisma.sql`AND id > ${cursor}`} ORDER BY id LIMIT 500`)
      if (!updates.length) break
      await client.$executeRaw`UPDATE "LiteratureIdentifier" SET
        "normalizedValue" = json_extract(data.value, '$.key')
        FROM json_each(${JSON.stringify(updates)}) AS data
        WHERE "LiteratureIdentifier".id = json_extract(data.value, '$.id')`
      cursor = updates.at(-1)!.id
    }
  }
  await migrationSqlExecutor.execute(client, 'DROP TABLE "_literature_doi_identity_v1"')
}

export { literatureDoiIdentityMigration, backfillLiteratureDoiIdentity }
