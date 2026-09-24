/* Associate a durable automatic pause with the run that created it. */
const literatureSmartPauseRunMigration = {
  id: '0045_literature_smart_pause_run',
  statements: [
    'ALTER TABLE "LiteratureSmartCollection" ADD COLUMN "automaticPauseRunId" TEXT',
    'ALTER TABLE "LiteratureSmartRun" ADD COLUMN "abandonedAt" DATETIME',
    `UPDATE "LiteratureSmartCollection"
     SET "automaticPauseRunId" = (
       SELECT candidate.id
       FROM "LiteratureSmartRun" candidate
       WHERE candidate."collectionId" = "LiteratureSmartCollection"."collectionId"
         AND (candidate."state" = 'interrupted'
           OR ("LiteratureSmartCollection"."automaticPauseReason" = 'storage-error' AND candidate."state" = 'failed'))
         AND (
           SELECT COUNT(*)
           FROM "LiteratureSmartRun" same_collection
           WHERE same_collection."collectionId" = "LiteratureSmartCollection"."collectionId"
             AND (same_collection."state" = 'interrupted'
               OR ("LiteratureSmartCollection"."automaticPauseReason" = 'storage-error' AND same_collection."state" = 'failed'))
         ) = 1
       LIMIT 1
     )
     WHERE "automaticPauseRunId" IS NULL
       AND "automaticPauseReason" IS NOT NULL`
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
