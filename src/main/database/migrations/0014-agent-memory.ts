const MEMORY_ENTRY_FTS_TABLE = 'MemoryEntryFts'

const MEMORY_ENTRY_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS "MemoryEntryFts"
  USING fts5("content", content='MemoryEntry', content_rowid='rowid', tokenize='trigram')`

const MEMORY_ENTRY_FTS_INSERT_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS "MemoryEntry_fts_insert"
  AFTER INSERT ON "MemoryEntry"
  BEGIN
    INSERT INTO "MemoryEntryFts"("rowid", "content") VALUES (NEW."rowid", NEW."content");
  END`

const MEMORY_ENTRY_FTS_DELETE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS "MemoryEntry_fts_delete"
  BEFORE DELETE ON "MemoryEntry"
  BEGIN
    DELETE FROM "MemoryEntryFts" WHERE "rowid" = OLD."rowid";
  END`

const MEMORY_ENTRY_FTS_UPDATE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS "MemoryEntry_fts_update"
  BEFORE UPDATE OF "content" ON "MemoryEntry"
  BEGIN
    DELETE FROM "MemoryEntryFts" WHERE "rowid" = OLD."rowid";
    INSERT INTO "MemoryEntryFts"("rowid", "content") VALUES (NEW."rowid", NEW."content");
  END`

const MEMORY_CATEGORY_CUSTOM_LIMIT_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS "MemoryCategory_custom_limit"
  BEFORE INSERT ON "MemoryCategory"
  WHEN NEW."systemKey" IS NULL AND (SELECT COUNT(*) FROM "MemoryCategory" WHERE "systemKey" IS NULL) >= 10
  BEGIN
    SELECT RAISE(ABORT, 'Memory custom category limit reached');
  END`

const MEMORY_CATEGORY_ABOUT_YOU_DELETE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS "MemoryCategory_about_you_delete"
  BEFORE DELETE ON "MemoryCategory"
  WHEN OLD."systemKey" = 'about-you'
  BEGIN
    SELECT RAISE(ABORT, 'About you category cannot be deleted');
  END`

const MEMORY_CATEGORY_ABOUT_YOU_UPDATE_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS "MemoryCategory_about_you_update"
  BEFORE UPDATE ON "MemoryCategory"
  WHEN OLD."systemKey" = 'about-you' AND (
    NEW."id" IS NOT OLD."id" OR
    NEW."systemKey" IS NOT OLD."systemKey" OR
    NEW."name" IS NOT OLD."name" OR
    NEW."nameKey" IS NOT OLD."nameKey" OR
    NEW."guidance" IS NOT OLD."guidance" OR
    NEW."autoRecall" IS NOT OLD."autoRecall"
  )
  BEGIN
    SELECT RAISE(ABORT, 'About you category cannot be edited');
  END`

const MEMORY_ENTRY_FTS_TRIGGER_DDLS = [
  MEMORY_ENTRY_FTS_INSERT_TRIGGER_DDL,
  MEMORY_ENTRY_FTS_DELETE_TRIGGER_DDL,
  MEMORY_ENTRY_FTS_UPDATE_TRIGGER_DDL
] as const

const MEMORY_CATEGORY_TRIGGER_DDLS = [
  MEMORY_CATEGORY_CUSTOM_LIMIT_TRIGGER_DDL,
  MEMORY_CATEGORY_ABOUT_YOU_DELETE_TRIGGER_DDL,
  MEMORY_CATEGORY_ABOUT_YOU_UPDATE_TRIGGER_DDL
] as const

const MEMORY_AUXILIARY_TABLE_NAMES = [
  MEMORY_ENTRY_FTS_TABLE,
  'MemoryEntryFts_config',
  'MemoryEntryFts_data',
  'MemoryEntryFts_docsize',
  'MemoryEntryFts_idx'
] as const

const MEMORY_AUXILIARY_SCHEMA_OBJECTS = [
  { type: 'table', name: MEMORY_ENTRY_FTS_TABLE, sql: MEMORY_ENTRY_FTS_DDL },
  ...MEMORY_ENTRY_FTS_TRIGGER_DDLS.map((sql) => ({
    type: 'trigger' as const,
    name: sql.match(/TRIGGER IF NOT EXISTS "([^"]+)"/)![1]!,
    sql
  })),
  ...MEMORY_CATEGORY_TRIGGER_DDLS.map((sql) => ({
    type: 'trigger' as const,
    name: sql.match(/TRIGGER IF NOT EXISTS "([^"]+)"/)![1]!,
    sql
  }))
] as const

const settingsIdExpression = `"id" = 'memory-settings'`
const settingsEnabledExpression = `"enabled" IN (false, true)`
const settingsRevisionExpression = `"revision" >= 0`
const categoryShapeExpression = `(("systemKey" = 'about-you' AND "name" IS NULL AND "nameKey" IS NULL AND "guidance" = '' AND "autoRecall" = true) OR ("systemKey" IS NULL AND "name" IS NOT NULL AND "nameKey" IS NOT NULL))`
const categoryNameExpression = `"name" IS NULL OR length(trim("name")) BETWEEN 1 AND 64`
const categoryNameKeyExpression = `"nameKey" IS NULL OR length("nameKey") BETWEEN 1 AND 64`
const categoryGuidanceExpression = `length("guidance") <= 1000`
const categoryAutoRecallExpression = `"autoRecall" IN (false, true)`
const categoryRevisionExpression = `"revision" >= 1`
const entryContentExpression = `length(trim("content")) BETWEEN 1 AND 4000`
const entryContentKeyExpression = `length("contentKey") BETWEEN 1 AND 4000`
const entryOriginExpression = `"origin" IN ('user', 'agent')`
const entrySourceExpression = `("origin" = 'user' AND "sourceSessionId" IS NULL AND "sourceAgentId" IS NULL) OR ("origin" = 'agent' AND "sourceSessionId" IS NOT NULL)`
const entryRevisionExpression = `"revision" >= 1`

const agentMemoryMigration = {
  id: '0014_agent_memory',
  statements: [
    `CREATE TABLE IF NOT EXISTS "MemorySettings" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "enabled" BOOLEAN NOT NULL DEFAULT false,
      "revision" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "MemorySettings_id_check" CHECK (${settingsIdExpression}),
      CONSTRAINT "MemorySettings_enabled_check" CHECK (${settingsEnabledExpression}),
      CONSTRAINT "MemorySettings_revision_check" CHECK (${settingsRevisionExpression})
    )`,
    `CREATE TABLE IF NOT EXISTS "MemoryCategory" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "systemKey" TEXT,
      "name" TEXT,
      "nameKey" TEXT,
      "guidance" TEXT NOT NULL DEFAULT '',
      "autoRecall" BOOLEAN NOT NULL DEFAULT false,
      "revision" INTEGER NOT NULL DEFAULT 1,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "MemoryCategory_shape_check" CHECK (${categoryShapeExpression}),
      CONSTRAINT "MemoryCategory_name_check" CHECK (${categoryNameExpression}),
      CONSTRAINT "MemoryCategory_nameKey_check" CHECK (${categoryNameKeyExpression}),
      CONSTRAINT "MemoryCategory_guidance_check" CHECK (${categoryGuidanceExpression}),
      CONSTRAINT "MemoryCategory_autoRecall_check" CHECK (${categoryAutoRecallExpression}),
      CONSTRAINT "MemoryCategory_revision_check" CHECK (${categoryRevisionExpression})
    )`,
    `CREATE TABLE IF NOT EXISTS "MemoryEntry" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "categoryId" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "contentKey" TEXT NOT NULL,
      "origin" TEXT NOT NULL,
      "sourceSessionId" TEXT,
      "sourceAgentId" TEXT,
      "revision" INTEGER NOT NULL DEFAULT 1,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "MemoryEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MemoryCategory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "MemoryEntry_content_check" CHECK (${entryContentExpression}),
      CONSTRAINT "MemoryEntry_contentKey_check" CHECK (${entryContentKeyExpression}),
      CONSTRAINT "MemoryEntry_origin_check" CHECK (${entryOriginExpression}),
      CONSTRAINT "MemoryEntry_source_check" CHECK (${entrySourceExpression}),
      CONSTRAINT "MemoryEntry_revision_check" CHECK (${entryRevisionExpression})
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "MemoryCategory_systemKey_key" ON "MemoryCategory"("systemKey")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "MemoryCategory_nameKey_key" ON "MemoryCategory"("nameKey")`,
    `CREATE INDEX IF NOT EXISTS "MemoryEntry_categoryId_updatedAt_idx" ON "MemoryEntry"("categoryId", "updatedAt")`,
    MEMORY_ENTRY_FTS_DDL,
    ...MEMORY_ENTRY_FTS_TRIGGER_DDLS,
    ...MEMORY_CATEGORY_TRIGGER_DDLS,
    `INSERT INTO "MemoryEntryFts"("MemoryEntryFts", "rank") VALUES('secure-delete', 1)`,
    `INSERT OR IGNORE INTO "MemorySettings" ("id", "enabled", "revision", "createdAt", "updatedAt") VALUES ('memory-settings', false, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    `INSERT OR IGNORE INTO "MemoryCategory" ("id", "systemKey", "guidance", "autoRecall", "revision", "createdAt", "updatedAt") VALUES ('memory-category-about-you', 'about-you', '', true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    `INSERT INTO "MemoryEntryFts"("MemoryEntryFts") VALUES('rebuild')`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'MemorySettings' },
    { kind: 'table-exists', version: 1, table: 'MemoryCategory' },
    { kind: 'table-exists', version: 1, table: 'MemoryEntry' },
    { kind: 'table-exists', version: 1, table: 'MemoryEntryFts' },
    {
      kind: 'sqlite-schema-objects-exist',
      version: 1,
      objects: MEMORY_AUXILIARY_SCHEMA_OBJECTS
    },
    {
      kind: 'table-value-equals',
      version: 1,
      table: 'MemoryEntryFts_config',
      keyColumn: 'k',
      keyValue: 'secure-delete',
      valueColumn: 'v',
      expectedValue: 1
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'MemoryEntry',
      column: 'categoryId',
      referencedTable: 'MemoryCategory',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'MemorySettings',
          constraints: [
            { name: 'MemorySettings_id_check', expression: settingsIdExpression },
            { name: 'MemorySettings_enabled_check', expression: settingsEnabledExpression },
            { name: 'MemorySettings_revision_check', expression: settingsRevisionExpression }
          ]
        },
        {
          table: 'MemoryCategory',
          constraints: [
            { name: 'MemoryCategory_shape_check', expression: categoryShapeExpression },
            { name: 'MemoryCategory_name_check', expression: categoryNameExpression },
            { name: 'MemoryCategory_nameKey_check', expression: categoryNameKeyExpression },
            { name: 'MemoryCategory_guidance_check', expression: categoryGuidanceExpression },
            { name: 'MemoryCategory_autoRecall_check', expression: categoryAutoRecallExpression },
            { name: 'MemoryCategory_revision_check', expression: categoryRevisionExpression }
          ]
        },
        {
          table: 'MemoryEntry',
          constraints: [
            { name: 'MemoryEntry_content_check', expression: entryContentExpression },
            { name: 'MemoryEntry_contentKey_check', expression: entryContentKeyExpression },
            { name: 'MemoryEntry_origin_check', expression: entryOriginExpression },
            { name: 'MemoryEntry_source_check', expression: entrySourceExpression },
            { name: 'MemoryEntry_revision_check', expression: entryRevisionExpression }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'MemoryCategory_systemKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "MemoryCategory_systemKey_key" ON "MemoryCategory"("systemKey")`
        },
        {
          name: 'MemoryCategory_nameKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "MemoryCategory_nameKey_key" ON "MemoryCategory"("nameKey")`
        },
        {
          name: 'MemoryEntry_categoryId_updatedAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "MemoryEntry_categoryId_updatedAt_idx" ON "MemoryEntry"("categoryId", "updatedAt")`
        }
      ]
    }
  ] as const
}

export {
  agentMemoryMigration,
  MEMORY_AUXILIARY_SCHEMA_OBJECTS,
  MEMORY_AUXILIARY_TABLE_NAMES,
  MEMORY_CATEGORY_TRIGGER_DDLS,
  MEMORY_ENTRY_FTS_DDL,
  MEMORY_ENTRY_FTS_TABLE,
  MEMORY_ENTRY_FTS_TRIGGER_DDLS
}
