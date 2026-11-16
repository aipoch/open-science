const indexes = [
  {
    name: 'SessionSchedule_projectId_sessionId_idx',
    sql: 'CREATE INDEX "SessionSchedule_projectId_sessionId_idx" ON "SessionSchedule"("projectId", "sessionId")'
  },
  {
    name: 'SessionSchedule_nextDueAt_idx',
    sql: 'CREATE INDEX "SessionSchedule_nextDueAt_idx" ON "SessionSchedule"("nextDueAt")'
  },
  {
    name: 'ScheduleOccurrence_promptMessageId_key',
    sql: 'CREATE UNIQUE INDEX "ScheduleOccurrence_promptMessageId_key" ON "ScheduleOccurrence"("promptMessageId")'
  },
  {
    name: 'ScheduleOccurrence_phase_nextAttemptAt_idx',
    sql: 'CREATE INDEX "ScheduleOccurrence_phase_nextAttemptAt_idx" ON "ScheduleOccurrence"("phase", "nextAttemptAt")'
  },
  {
    name: 'ScheduleOccurrence_scheduleId_scheduledAt_key',
    sql: 'CREATE UNIQUE INDEX "ScheduleOccurrence_scheduleId_scheduledAt_key" ON "ScheduleOccurrence"("scheduleId", "scheduledAt")'
  },
  {
    name: 'ScheduleMutationReceipt_expiresAt_idx',
    sql: 'CREATE INDEX "ScheduleMutationReceipt_expiresAt_idx" ON "ScheduleMutationReceipt"("expiresAt")'
  },
  {
    name: 'ScheduleOccurrence_unresolved_key',
    sql: 'CREATE UNIQUE INDEX "ScheduleOccurrence_unresolved_key" ON "ScheduleOccurrence"("scheduleId") WHERE "phase" <> \'settled\''
  }
] as const

const sessionSchedulesMigration = {
  id: '0058_session_schedules',
  statements: [
    `CREATE TABLE "SessionSchedule" (
    "originPromptId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "agentFrameId" TEXT,
    "messageBranchId" TEXT,
    "name" TEXT NOT NULL,
    "actionJson" TEXT NOT NULL,
    "permissionProfile" TEXT,
    "ruleJson" TEXT NOT NULL,
    "nextDueAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "pausedAt" DATETIME,
    "pauseReason" TEXT,
    "finishedAt" DATETIME,
    "finishReason" TEXT,
    "endAt" DATETIME,
    "maxRuns" INTEGER,
    "admittedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionSchedule_values_check" CHECK (("finishReason" IS NULL OR ("finishedAt" IS NOT NULL AND "finishReason" IN ('completed', 'cancelled'))) AND "revision" >= 1 AND "admittedCount" >= 0 AND ("maxRuns" IS NULL OR "maxRuns" > 0) AND ("permissionProfile" IS NULL OR ("sessionId" IS NULL AND "permissionProfile" IN ('ask', 'auto', 'full'))) AND json_valid("actionJson") AND json_valid("ruleJson") AND (("sessionId" IS NOT NULL AND "agentFrameId" IS NOT NULL AND "messageBranchId" IS NOT NULL) OR ("sessionId" IS NULL AND "agentFrameId" IS NULL AND "messageBranchId" IS NULL AND json_extract("actionJson", '$.kind') IS 'send_session_message')))
)`,
    `CREATE TABLE "ScheduleOccurrence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "scheduleRevision" INTEGER NOT NULL,
    "scheduledAt" DATETIME NOT NULL,
    "actionSnapshot" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "dispatchAuthorizedAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "promptMessageId" TEXT,
    "runSessionId" TEXT,
    "scriptRunId" TEXT,
    "reason" TEXT,
    "outcome" TEXT,
    "admittedAt" DATETIME,
    "settledAt" DATETIME,
    CONSTRAINT "ScheduleOccurrence_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "SessionSchedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScheduleOccurrence_values_check" CHECK ("phase" IN ('dispatching', 'admitted', 'settled') AND "attemptCount" > 0 AND "scheduleRevision" > 0 AND json_valid("actionSnapshot") AND (("phase" = 'settled') = ("settledAt" IS NOT NULL)))
)`,
    `CREATE TABLE "ScheduleMutationReceipt" (
    "requestKey" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
)`,
    ...indexes.map(({ sql }) => sql)
  ],
  operations: [] as const,
  verifiers: [
    {
      kind: 'table-exists',
      version: 1,
      table: 'SessionSchedule'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'ScheduleOccurrence'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'ScheduleMutationReceipt'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'SessionSchedule',
          constraints: [
            {
              name: 'SessionSchedule_values_check',
              expression:
                '("finishReason" IS NULL OR ("finishedAt" IS NOT NULL AND "finishReason" IN (\'completed\', \'cancelled\'))) AND "revision" >= 1 AND "admittedCount" >= 0 AND ("maxRuns" IS NULL OR "maxRuns" > 0) AND ("permissionProfile" IS NULL OR ("sessionId" IS NULL AND "permissionProfile" IN (\'ask\', \'auto\', \'full\'))) AND json_valid("actionJson") AND json_valid("ruleJson") AND (("sessionId" IS NOT NULL AND "agentFrameId" IS NOT NULL AND "messageBranchId" IS NOT NULL) OR ("sessionId" IS NULL AND "agentFrameId" IS NULL AND "messageBranchId" IS NULL AND json_extract("actionJson", \'$.kind\') IS \'send_session_message\'))'
            }
          ]
        },
        {
          table: 'ScheduleOccurrence',
          constraints: [
            {
              name: 'ScheduleOccurrence_values_check',
              expression:
                '"phase" IN (\'dispatching\', \'admitted\', \'settled\') AND "attemptCount" > 0 AND "scheduleRevision" > 0 AND json_valid("actionSnapshot") AND (("phase" = \'settled\') = ("settledAt" IS NOT NULL))'
            }
          ]
        }
      ]
    },
    { kind: 'indexes-exist', version: 1, indexes }
  ] as const
}

export { sessionSchedulesMigration }
