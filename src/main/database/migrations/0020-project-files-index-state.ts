const projectFilesIndexStateMigration = {
  id: '0020_project_files_index_state',
  statements: [
    `CREATE TABLE IF NOT EXISTS "ManagedFileIndexState" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "isReconciliationComplete" BOOLEAN NOT NULL DEFAULT true,
      CONSTRAINT "ManagedFileIndexState_identity_check" CHECK ("id" = 'project-files-index' AND "isReconciliationComplete" IN (false, true))
    )`,
    `INSERT OR IGNORE INTO "ManagedFileIndexState" ("id", "isReconciliationComplete")
      VALUES ('project-files-index', true)`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'ManagedFileIndexState' },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ManagedFileIndexState',
          constraints: [
            {
              name: 'ManagedFileIndexState_identity_check',
              expression:
                '"id" = \'project-files-index\' AND "isReconciliationComplete" IN (false, true)'
            }
          ]
        }
      ]
    },
    {
      kind: 'table-value-equals',
      version: 1,
      table: 'ManagedFileIndexState',
      keyColumn: 'id',
      keyValue: 'project-files-index',
      valueColumn: 'id',
      expectedValue: 'project-files-index'
    }
  ] as const
}

export { projectFilesIndexStateMigration }
