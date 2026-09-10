// Visibility belongs to the logical file, so it survives new Versions and index reconciliation.
const artifactHiddenMigration = {
  id: '0041_artifact_hidden',
  statements: ['ALTER TABLE "ArtifactLineage" ADD COLUMN "hiddenAt" DATETIME'] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ArtifactLineage', column: 'hiddenAt' }
  ] as const
}

export { artifactHiddenMigration }
