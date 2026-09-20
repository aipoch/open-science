/* Immutable 0035 migration snapshot. Do not regenerate after release. */
const literaturePdfProvenanceMigration = {
  id: '0035_literature_pdf_provenance',
  statements: [
    'ALTER TABLE "LiteratureAttachmentVersion" ADD COLUMN "provenanceJson" TEXT',
    'ALTER TABLE "LiteratureInboxPdf" ADD COLUMN "provenanceJson" TEXT'
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureAttachmentVersion',
      column: 'provenanceJson'
    },
    { kind: 'column-exists', version: 1, table: 'LiteratureInboxPdf', column: 'provenanceJson' }
  ] as const
}
export { literaturePdfProvenanceMigration }
