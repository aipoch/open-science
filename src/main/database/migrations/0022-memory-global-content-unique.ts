const memoryGlobalContentUniqueIndexDdl = `CREATE UNIQUE INDEX IF NOT EXISTS "MemoryEntry_global_contentKey_key" ON "MemoryEntry"("contentKey") WHERE "projectId" IS NULL`

const memoryGlobalContentUniqueMigration = {
  id: '0022_memory_global_content_unique',
  statements: [memoryGlobalContentUniqueIndexDdl] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'MemoryEntry_global_contentKey_key',
          sql: memoryGlobalContentUniqueIndexDdl
        }
      ]
    }
  ] as const
}

export { memoryGlobalContentUniqueMigration }
