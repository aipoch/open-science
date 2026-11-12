/* Immutable migration snapshot: preserve existing notification identities and read state. */
const researchFilmNotificationsMigration = {
  id: '0058_research_film_notifications',
  statements: [],
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'NotificationInboxItem',
          canonicalTableDdl:
            'CREATE TABLE IF NOT EXISTS "NotificationInboxItem" (\n    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,\n    "id" TEXT NOT NULL,\n    "dedupeKey" TEXT NOT NULL,\n    "kind" TEXT NOT NULL,\n    "source" TEXT,\n    "attentionReason" TEXT,\n    "projectId" TEXT,\n    "sessionId" TEXT,\n    "branchId" TEXT,\n    "originId" TEXT NOT NULL,\n    "title" TEXT NOT NULL,\n    "summary" TEXT NOT NULL,\n    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    "readAt" DATETIME,\n    "actionState" TEXT,\n    "settledAt" DATETIME,\n    "targetInvalidatedAt" DATETIME,\n    CONSTRAINT "NotificationInboxItem_source_check" CHECK ("source" IS NULL OR "source" IN (\'agent-tool\', \'agent-question\', \'agent-runtime\', \'connector\', \'compute\', \'skill-import\', \'session-plan\', \'research-film\')),\n    CONSTRAINT "NotificationInboxItem_attentionReason_check" CHECK ("attentionReason" IS NULL OR "attentionReason" IN (\'waiting-for-user\', \'waiting-permission\', \'waiting-plan-approval\', \'task-max-tokens\', \'task-max-turn-requests\', \'task-refusal\', \'task-unclean-stop\')),\n    CONSTRAINT "NotificationInboxItem_kind_check" CHECK ("kind" IN (\'task.completed\', \'task.needs-attention\', \'task.failed\', \'authorization.required\')),\n    CONSTRAINT "NotificationInboxItem_actionState_check" CHECK ("actionState" IS NULL OR "actionState" IN (\'pending\', \'resolved\', \'rejected\', \'expired\', \'cancelled\')),\n    CONSTRAINT "NotificationInboxItem_actionLifecycle_check" CHECK ((("actionState" IS NULL AND "settledAt" IS NULL) OR ("actionState" IS NOT NULL AND (("actionState" = \'pending\' AND "settledAt" IS NULL) OR ("actionState" IN (\'resolved\', \'rejected\', \'expired\', \'cancelled\') AND "settledAt" IS NOT NULL))))),\n    CONSTRAINT "NotificationInboxItem_actionKind_check" CHECK ("actionState" IS NULL OR "kind" IN (\'task.needs-attention\', \'authorization.required\')),\n    CONSTRAINT "NotificationInboxItem_targetInvalidated_check" CHECK ("targetInvalidatedAt" IS NULL OR ("sessionId" IS NOT NULL AND "readAt" IS NOT NULL))\n);',
          columns: [
            'sequence',
            'id',
            'dedupeKey',
            'kind',
            'source',
            'attentionReason',
            'projectId',
            'sessionId',
            'originId',
            'title',
            'summary',
            'createdAt',
            'readAt',
            'actionState',
            'settledAt',
            'targetInvalidatedAt'
          ]
        }
      ],
      dropOrder: ['NotificationInboxItem'],
      indexes: [
        'CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_id_key" ON "NotificationInboxItem"("id");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_dedupeKey_key" ON "NotificationInboxItem"("dedupeKey");',
        'CREATE INDEX IF NOT EXISTS "NotificationInboxItem_readAt_sequence_idx" ON "NotificationInboxItem"("readAt", "sequence");',
        'CREATE INDEX IF NOT EXISTS "NotificationInboxItem_sessionId_idx" ON "NotificationInboxItem"("sessionId");',
        'CREATE INDEX IF NOT EXISTS "NotificationInboxItem_projectId_idx" ON "NotificationInboxItem"("projectId");'
      ]
    }
  ],
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'NotificationInboxItem',
      column: 'branchId'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'NotificationInboxItem',
          constraints: [
            {
              name: 'NotificationInboxItem_source_check',
              expression:
                "\"source\" IS NULL OR \"source\" IN ('agent-tool', 'agent-question', 'agent-runtime', 'connector', 'compute', 'skill-import', 'session-plan', 'research-film')"
            }
          ]
        }
      ]
    }
  ]
} as const

export { researchFilmNotificationsMigration }
