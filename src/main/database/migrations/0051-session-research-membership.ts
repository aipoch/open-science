// Immutable migration: these columns are a disposable projection of Session JSON.
const sessionResearchMembershipMigration = {
  id: '0051_session_research_membership',
  statements: [
    `ALTER TABLE "Session" ADD COLUMN "researchMembershipJson" TEXT`,
    `ALTER TABLE "Session" ADD COLUMN "importedResearchId" TEXT`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Session', column: 'researchMembershipJson' },
    { kind: 'column-exists', version: 1, table: 'Session', column: 'importedResearchId' }
  ] as const
}
export { sessionResearchMembershipMigration }
