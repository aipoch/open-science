/* Immutable 0002 migration snapshot. Do not regenerate after release. */

// Existing installations created their Project table before Agent Context existed. The migration is
// additive: the empty-string default keeps every stored Project unchanged.
const projectAgentContextMigration = {
  id: '0002_project_agent_context',
  statements: [`ALTER TABLE "Project" ADD COLUMN "agentContext" TEXT NOT NULL DEFAULT ''`] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'Project',
      column: 'agentContext'
    }
  ] as const
}

export { projectAgentContextMigration }
