const literatureSmartPauseRunMigration = {
  id: '0045_literature_smart_pause_run',
  statements: [
    'ALTER TABLE "LiteratureSmartCollection" ADD COLUMN "automaticPauseRunId" TEXT',
    'ALTER TABLE "LiteratureSmartRun" ADD COLUMN "abandonedAt" DATETIME'
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureSmartCollection',
      column: 'automaticPauseRunId'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureSmartRun',
      column: 'abandonedAt'
    }
  ] as const
}

export { literatureSmartPauseRunMigration }
