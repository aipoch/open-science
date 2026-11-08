const sessionDiscussionParentMigration = {
  id: '0055_session_discussion_parent',
  statements: ['ALTER TABLE "Session" ADD COLUMN "parentSessionId" TEXT'] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Session', column: 'parentSessionId' }
  ] as const
}

export { sessionDiscussionParentMigration }
