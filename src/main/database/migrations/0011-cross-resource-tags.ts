const tagShapeExpression = `(("systemKey" IS NOT NULL AND "name" IS NULL AND "nameKey" IS NULL AND "iconKey" IS NULL AND "colorKey" IS NULL) OR ("systemKey" IS NULL AND "name" IS NOT NULL AND "nameKey" IS NOT NULL AND "iconKey" IS NOT NULL AND "colorKey" IS NOT NULL))`
const tagSystemKeyExpression = `"systemKey" IS NULL OR "systemKey" = 'favorite'`
const tagNameExpression = `"name" IS NULL OR (length(trim("name")) BETWEEN 1 AND 64)`
const tagNameKeyExpression = `"nameKey" IS NULL OR (length("nameKey") BETWEEN 1 AND 64)`
const tagIconKeyExpression = `"iconKey" IS NULL OR "iconKey" IN ('tag', 'star', 'bookmark', 'flask-conical', 'book-open', 'database', 'code-2', 'bot')`
const tagColorKeyExpression = `"colorKey" IS NULL OR "colorKey" IN ('gray', 'red', 'orange', 'amber', 'green', 'blue', 'purple', 'pink')`
const tagResourceIdExpression = `length(trim("resourceId")) BETWEEN 1 AND 256`

const crossResourceTagsMigration = {
  id: '0011_cross_resource_tags',
  statements: [
    `CREATE TABLE IF NOT EXISTS "Tag" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "systemKey" TEXT,
      "name" TEXT,
      "nameKey" TEXT,
      "iconKey" TEXT,
      "colorKey" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "Tag_shape_check" CHECK (${tagShapeExpression}),
      CONSTRAINT "Tag_systemKey_check" CHECK (${tagSystemKeyExpression}),
      CONSTRAINT "Tag_name_check" CHECK (${tagNameExpression}),
      CONSTRAINT "Tag_nameKey_check" CHECK (${tagNameKeyExpression}),
      CONSTRAINT "Tag_iconKey_check" CHECK (${tagIconKeyExpression}),
      CONSTRAINT "Tag_colorKey_check" CHECK (${tagColorKeyExpression})
    )`,
    `CREATE TABLE IF NOT EXISTS "TagAssignment" (
      "tagId" TEXT NOT NULL,
      "resourceType" TEXT NOT NULL,
      "resourceId" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("tagId", "resourceType", "resourceId"),
      CONSTRAINT "TagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "TagAssignment_resourceId_check" CHECK (${tagResourceIdExpression})
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Tag_systemKey_key" ON "Tag"("systemKey")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Tag_nameKey_key" ON "Tag"("nameKey")`,
    `CREATE INDEX IF NOT EXISTS "TagAssignment_resourceType_resourceId_idx" ON "TagAssignment"("resourceType", "resourceId")`,
    `INSERT OR IGNORE INTO "Tag" ("id", "systemKey", "createdAt", "updatedAt") VALUES ('tag-favorite', 'favorite', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'Tag' },
    { kind: 'table-exists', version: 1, table: 'TagAssignment' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'TagAssignment',
      column: 'tagId',
      referencedTable: 'Tag',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'Tag',
          constraints: [
            { name: 'Tag_shape_check', expression: tagShapeExpression },
            { name: 'Tag_systemKey_check', expression: tagSystemKeyExpression },
            { name: 'Tag_name_check', expression: tagNameExpression },
            { name: 'Tag_nameKey_check', expression: tagNameKeyExpression },
            { name: 'Tag_iconKey_check', expression: tagIconKeyExpression },
            { name: 'Tag_colorKey_check', expression: tagColorKeyExpression }
          ]
        },
        {
          table: 'TagAssignment',
          constraints: [
            { name: 'TagAssignment_resourceId_check', expression: tagResourceIdExpression }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'Tag_systemKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "Tag_systemKey_key" ON "Tag"("systemKey")`
        },
        {
          name: 'Tag_nameKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "Tag_nameKey_key" ON "Tag"("nameKey")`
        },
        {
          name: 'TagAssignment_resourceType_resourceId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "TagAssignment_resourceType_resourceId_idx" ON "TagAssignment"("resourceType", "resourceId")`
        }
      ]
    }
  ] as const
}

export { crossResourceTagsMigration }
