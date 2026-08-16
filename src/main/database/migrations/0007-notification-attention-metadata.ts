/* Immutable 0007 migration snapshot. Do not regenerate after release. */

const notificationAttentionMetadataMigration = {
  id: '0007_notification_attention_metadata',
  statements: [] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'NotificationInboxItem',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "NotificationInboxItem" (
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT,
    "attentionReason" TEXT,
    "projectId" TEXT,
    "sessionId" TEXT,
    "originId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "actionState" TEXT,
    "settledAt" DATETIME,
    "targetInvalidatedAt" DATETIME,
    CONSTRAINT "NotificationInboxItem_source_check" CHECK ("source" IS NULL OR "source" IN ('agent-tool', 'agent-question', 'agent-runtime', 'connector', 'compute', 'skill-import', 'session-plan')),
    CONSTRAINT "NotificationInboxItem_attentionReason_check" CHECK ("attentionReason" IS NULL OR "attentionReason" IN ('waiting-for-user', 'waiting-permission', 'waiting-plan-approval', 'task-max-tokens', 'task-max-turn-requests', 'task-refusal', 'task-unclean-stop'))
);`,
          columns: [
            'sequence',
            'id',
            'dedupeKey',
            'kind',
            'source',
            'projectId',
            'sessionId',
            'originId',
            'title',
            'summary',
            'createdAt',
            'readAt',
            'actionState',
            'settledAt'
          ]
        }
      ],
      dropOrder: ['NotificationInboxItem'],
      indexes: [
        `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_id_key" ON "NotificationInboxItem"("id");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_dedupeKey_key" ON "NotificationInboxItem"("dedupeKey");`,
        `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_readAt_sequence_idx" ON "NotificationInboxItem"("readAt", "sequence");`,
        `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_sessionId_idx" ON "NotificationInboxItem"("sessionId");`,
        `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_projectId_idx" ON "NotificationInboxItem"("projectId");`
      ]
    }
  ] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'NotificationInboxItem',
      column: 'attentionReason'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'NotificationInboxItem',
      column: 'targetInvalidatedAt'
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
              expression: `"source" IS NULL OR "source" IN ('agent-tool', 'agent-question', 'agent-runtime', 'connector', 'compute', 'skill-import', 'session-plan')`
            },
            {
              name: 'NotificationInboxItem_attentionReason_check',
              expression: `"attentionReason" IS NULL OR "attentionReason" IN ('waiting-for-user', 'waiting-permission', 'waiting-plan-approval', 'task-max-tokens', 'task-max-turn-requests', 'task-refusal', 'task-unclean-stop')`
            }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'NotificationInboxItem_id_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_id_key" ON "NotificationInboxItem"("id");`
        },
        {
          name: 'NotificationInboxItem_dedupeKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_dedupeKey_key" ON "NotificationInboxItem"("dedupeKey");`
        },
        {
          name: 'NotificationInboxItem_readAt_sequence_idx',
          sql: `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_readAt_sequence_idx" ON "NotificationInboxItem"("readAt", "sequence");`
        },
        {
          name: 'NotificationInboxItem_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_sessionId_idx" ON "NotificationInboxItem"("sessionId");`
        },
        {
          name: 'NotificationInboxItem_projectId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_projectId_idx" ON "NotificationInboxItem"("projectId");`
        }
      ]
    }
  ] as const
}

export { notificationAttentionMetadataMigration }
