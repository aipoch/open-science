const literatureReadingStatusMigration = {
  id: '0051_literature_reading_status',
  statements: [
    'ALTER TABLE "LiteratureItem" ADD COLUMN "readingStatus" TEXT NOT NULL DEFAULT \'unread\''
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'LiteratureItem', column: 'readingStatus' }
  ] as const
}

export { literatureReadingStatusMigration }
