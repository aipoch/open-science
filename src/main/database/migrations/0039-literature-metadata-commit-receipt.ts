/* Immutable 0039 migration snapshot. Do not regenerate after release. */
const literatureMetadataCommitReceiptMigration = {
  id: '0039_literature_metadata_commit_receipt',
  statements: [
    `CREATE TABLE "LiteratureMetadataCommitReceipt" (
      "operationId" TEXT NOT NULL PRIMARY KEY,
      "itemId" TEXT NOT NULL,
      "expectedMetadataRevision" INTEGER NOT NULL,
      "committedMetadataRevision" INTEGER NOT NULL,
      CONSTRAINT "LiteratureMetadataCommitReceipt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    'CREATE INDEX "LiteratureMetadataCommitReceipt_itemId_idx" ON "LiteratureMetadataCommitReceipt"("itemId")'
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'LiteratureMetadataCommitReceipt' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'LiteratureMetadataCommitReceipt',
      column: 'itemId',
      referencedTable: 'LiteratureItem',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'LiteratureMetadataCommitReceipt_itemId_idx',
          sql: 'CREATE INDEX "LiteratureMetadataCommitReceipt_itemId_idx" ON "LiteratureMetadataCommitReceipt"("itemId")'
        }
      ]
    }
  ] as const
}
export { literatureMetadataCommitReceiptMigration }
