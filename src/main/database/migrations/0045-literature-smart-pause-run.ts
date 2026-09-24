/* Associate a durable automatic pause with the run that created it. */
const literatureSmartPauseRunMigration = {
  id: '0045_literature_smart_pause_run',
  statements: [
    'ALTER TABLE "LiteratureSmartCollection" ADD COLUMN "automaticPauseRunId" TEXT'
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureSmartCollection',
      column: 'automaticPauseRunId'
    }
  ] as const
}

export { literatureSmartPauseRunMigration }
