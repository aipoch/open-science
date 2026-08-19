const tagOrderingMigration = {
  id: '0012_tag_ordering',
  statements: [
    `ALTER TABLE "Tag" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0`,
    `UPDATE "Tag" AS current
      SET "sortOrder" = CASE
        WHEN current."systemKey" = 'favorite' THEN 0
        ELSE 1 + (
          SELECT COUNT(*)
          FROM "Tag" AS earlier
          WHERE earlier."systemKey" IS NULL
            AND (
              earlier."nameKey" < current."nameKey"
              OR (earlier."nameKey" = current."nameKey" AND earlier."id" < current."id")
            )
        )
      END`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Tag_sortOrder_key" ON "Tag"("sortOrder")`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Tag', column: 'sortOrder' },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'Tag_sortOrder_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "Tag_sortOrder_key" ON "Tag"("sortOrder")`
        }
      ]
    }
  ] as const
}

export { tagOrderingMigration }
