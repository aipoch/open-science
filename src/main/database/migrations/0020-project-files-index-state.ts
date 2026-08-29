const projectFilesIndexStateMigration = {
  id: '0020_project_files_index_state',
  statements: [
    `CREATE TABLE "ManagedFileIndexState" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "isReconciliationComplete" BOOLEAN NOT NULL DEFAULT true,
      CONSTRAINT "ManagedFileIndexState_identity_check" CHECK ("id" = 'project-files-index' AND "isReconciliationComplete" IN (false, true))
    )`,
    `INSERT INTO "ManagedFileIndexState" ("id", "isReconciliationComplete")
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
    }
  ] as const
}

export { projectFilesIndexStateMigration }
