const reviewQueryIndexes = [
  {
    name: 'Review_projectId_sessionId_createdAt_idx',
    sql: `CREATE INDEX IF NOT EXISTS "Review_projectId_sessionId_createdAt_idx" ON "Review"("projectId", "sessionId", "createdAt")`
  },
  {
    name: 'Review_sessionId_idx',
    sql: `CREATE INDEX IF NOT EXISTS "Review_sessionId_idx" ON "Review"("sessionId")`
  },
  {
    name: 'Finding_reviewId_idx',
    sql: `CREATE INDEX IF NOT EXISTS "Finding_reviewId_idx" ON "Finding"("reviewId")`
  }
] as const

const reviewQueryIndexesMigration = {
  id: '0014_review_query_indexes',
  statements: reviewQueryIndexes.map(({ sql }) => sql),
  operations: [] as const,
  verifiers: [
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: reviewQueryIndexes
    }
  ] as const
}

export { reviewQueryIndexesMigration }
