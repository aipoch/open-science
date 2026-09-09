import { Prisma } from '@prisma/client'
import { normalizeLiteratureSearchTextV1 as normalize } from '../../../shared/literature-search-text'

const literatureSearchTextMigration = {
  id: '0038_literature_search_text',
  statements: [
    `-- Backfill v1: NFKC, trim, collapse Unicode whitespace, Unicode lowercase; preserve timestamps and revisions.
ALTER TABLE "LiteratureItem" ADD COLUMN "normalizedTitle" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "LiteratureItem" ADD COLUMN "normalizedAbstract" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "LiteratureItem" ADD COLUMN "normalizedContainerTitle" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "LiteratureCreator" ADD COLUMN "normalizedDisplayName" TEXT NOT NULL DEFAULT ''`
  ],
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'LiteratureItem', column: 'normalizedTitle' },
    { kind: 'column-exists', version: 1, table: 'LiteratureItem', column: 'normalizedAbstract' },
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureItem',
      column: 'normalizedContainerTitle'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureCreator',
      column: 'normalizedDisplayName'
    }
  ] as const
}

// Run inside the migration transaction, including adoption of a pre-ledger current schema.
// JSON batches bind data without interpolating user text or exceeding SQLite's parameter limit.
type ItemText = { id: string; title: string; abstract: string; containerTitle: string }
type CreatorText = {
  id: string
  nameMode: string
  givenName: string
  familyName: string
  literalName: string
}

const backfillLiteratureSearchText = async (client: Prisma.TransactionClient): Promise<void> => {
  let cursor: string | undefined
  for (;;) {
    const rows: ItemText[] = await client.$queryRaw<ItemText[]>(Prisma.sql`
      SELECT id, title, abstract, "containerTitle" FROM "LiteratureItem"
      ${cursor === undefined ? Prisma.empty : Prisma.sql`WHERE id > ${cursor}`} ORDER BY id LIMIT 500`)
    if (!rows.length) break
    const values = rows.map((row) => ({
      id: row.id,
      title: normalize(row.title),
      abstract: normalize(row.abstract),
      containerTitle: normalize(row.containerTitle)
    }))
    await client.$executeRaw`UPDATE "LiteratureItem" SET
      "normalizedTitle" = json_extract(data.value, '$.title'),
      "normalizedAbstract" = json_extract(data.value, '$.abstract'),
      "normalizedContainerTitle" = json_extract(data.value, '$.containerTitle')
      FROM json_each(${JSON.stringify(values)}) AS data WHERE "LiteratureItem".id = json_extract(data.value, '$.id')`
    cursor = rows.at(-1)!.id
  }
  cursor = undefined
  for (;;) {
    const rows: CreatorText[] = await client.$queryRaw<CreatorText[]>(Prisma.sql`
      SELECT id, "nameMode", "givenName", "familyName", "literalName" FROM "LiteratureCreator"
      ${cursor === undefined ? Prisma.empty : Prisma.sql`WHERE id > ${cursor}`} ORDER BY id LIMIT 500`)
    if (!rows.length) break
    const values = rows.map((row) => ({
      id: row.id,
      name: normalize(
        row.nameMode === 'organization' ? row.literalName : `${row.familyName} ${row.givenName}`
      ),
      display: normalize(
        row.nameMode === 'organization' ? row.literalName : `${row.givenName} ${row.familyName}`
      )
    }))
    await client.$executeRaw`UPDATE "LiteratureCreator" SET
      "normalizedName" = json_extract(data.value, '$.name'),
      "normalizedDisplayName" = json_extract(data.value, '$.display')
      FROM json_each(${JSON.stringify(values)}) AS data WHERE "LiteratureCreator".id = json_extract(data.value, '$.id')`
    cursor = rows.at(-1)!.id
  }
}

export { literatureSearchTextMigration, backfillLiteratureSearchText }
