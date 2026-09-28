/* Immutable journal identity and attribute dataset storage. */
const journalAttributesMigration = {
  id: '0046_journal_attributes',
  statements: [
    `CREATE TABLE "Journal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "issnsJson" TEXT NOT NULL DEFAULT '[]',
    "externalIdsJson" TEXT NOT NULL DEFAULT '[]'
);`,
    `CREATE TABLE "JournalDataset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "source" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "fieldsJson" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`,
    `CREATE TABLE "JournalDatasetEntry" (
    "datasetId" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "valuesJson" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,

    PRIMARY KEY ("datasetId", "journalId"),
    CONSTRAINT "JournalDatasetEntry_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "JournalDataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JournalDatasetEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE INDEX "Journal_normalizedName_idx" ON "Journal"("normalizedName");`,
    `CREATE UNIQUE INDEX "JournalDataset_source_year_key" ON "JournalDataset"("source", "year");`,
    `CREATE INDEX "JournalDatasetEntry_journalId_idx" ON "JournalDatasetEntry"("journalId");`,
    `CREATE TABLE "JournalItemBinding" (
    "itemId" TEXT NOT NULL PRIMARY KEY,
    "journalId" TEXT NOT NULL,
    "identityFingerprint" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    CONSTRAINT "JournalItemBinding_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JournalItemBinding_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE INDEX "JournalItemBinding_journalId_idx" ON "JournalItemBinding"("journalId");`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'Journal' },
    { kind: 'table-exists', version: 1, table: 'JournalDataset' },
    { kind: 'table-exists', version: 1, table: 'JournalDatasetEntry' },
    { kind: 'table-exists', version: 1, table: 'JournalItemBinding' },
    { kind: 'column-exists', version: 1, table: 'Journal', column: 'externalIdsJson' },
    { kind: 'column-exists', version: 1, table: 'JournalDataset', column: 'name' }
  ] as const
}

export { journalAttributesMigration }
