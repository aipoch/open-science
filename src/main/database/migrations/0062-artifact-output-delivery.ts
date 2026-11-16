// The portable Artifact index includes this association with its owning lineage.
const artifactOutputDeliveryMigration = {
  id: '0062_artifact_output_delivery',
  statements: [`ALTER TABLE "ArtifactLineage" ADD COLUMN "outputDeliveryJson" TEXT`] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ArtifactLineage', column: 'outputDeliveryJson' }
  ] as const
}

export { artifactOutputDeliveryMigration }
