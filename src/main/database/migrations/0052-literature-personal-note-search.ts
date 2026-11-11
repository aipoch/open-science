import { Prisma } from '@prisma/client'
import { normalizeLiteratureSearchTextV1 as normalize } from '../../../shared/literature-search-text'

const literaturePersonalNoteSearchMigration = {
  id: '0052_literature_personal_note_search',
  statements: [
    `ALTER TABLE "LiteratureItem" ADD COLUMN "normalizedPersonalNote" TEXT NOT NULL DEFAULT ''`
  ],
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'LiteratureItem', column: 'normalizedPersonalNote' }
  ] as const
}

// Keep existing notes searchable without changing their content, revision or modification time.
// Read bounded batches so upgrades do not load every note into memory.
const backfillLiteraturePersonalNoteSearch = async (
  client: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>
): Promise<void> => {
  let cursor: string | undefined
  for (;;) {
    const rows = await client.$queryRaw<{ id: string; personalNote: string }[]>(Prisma.sql`
      SELECT id, "personalNote" FROM "LiteratureItem"
      ${cursor === undefined ? Prisma.empty : Prisma.sql`WHERE id > ${cursor}`}
      ORDER BY id LIMIT 500`)
    if (!rows.length) break
    const values = rows.map((row) => ({ id: row.id, text: normalize(row.personalNote) }))
    await client.$executeRaw`UPDATE "LiteratureItem" SET
      "normalizedPersonalNote" = json_extract(data.value, '$.text')
      FROM json_each(${JSON.stringify(values)}) AS data
      WHERE "LiteratureItem".id = json_extract(data.value, '$.id')`
    cursor = rows.at(-1)!.id
  }
}

export { literaturePersonalNoteSearchMigration, backfillLiteraturePersonalNoteSearch }
