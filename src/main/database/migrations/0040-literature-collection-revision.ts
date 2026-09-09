/* Immutable collection edit concurrency migration. */
const literatureCollectionRevisionMigration = {
  id: '0040_literature_collection_revision',
  statements: [
    'ALTER TABLE "LiteratureCollection" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1'
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'LiteratureCollection', column: 'revision' }
  ] as const
}

export { literatureCollectionRevisionMigration }
