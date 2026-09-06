/* Immutable 0031 migration snapshot. Do not regenerate after release. */

const projectArchiveRevisionMigration = {
  id: '0031_project_archive_revision',
  statements: [
    `ALTER TABLE "Project" ADD COLUMN "archiveRevision" INTEGER NOT NULL DEFAULT 0`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Project', column: 'archiveRevision' }
  ] as const
}

export { projectArchiveRevisionMigration }
