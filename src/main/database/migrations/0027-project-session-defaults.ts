/* Immutable 0027 migration snapshot. Do not regenerate after release. */

const projectSessionDefaultsMigration = {
  id: '0027_project_session_defaults',
  statements: [
    `ALTER TABLE "Project" ADD COLUMN "sessionDefaults" TEXT NOT NULL DEFAULT '{}'`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'Project',
      column: 'sessionDefaults'
    }
  ] as const
}

export { projectSessionDefaultsMigration }
