export const pdfAnnotationImportReceiptMigration = {
  id: '0046_pdf_annotation_import_receipt',
  statements: [
    `CREATE TABLE "pdf_annotation_imports" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT,
      "sessionId" TEXT,
      "sourceKind" TEXT NOT NULL,
      "sourceFileId" TEXT NOT NULL,
      "versionId" TEXT NOT NULL,
      "checksum" TEXT NOT NULL,
      "resultJson" TEXT NOT NULL,
      CONSTRAINT "pdf_annotation_imports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "PdfAnnotationImport_json_check" CHECK (json_valid("resultJson"))
    )`,
    `CREATE INDEX "pdf_annotation_imports_projectId_sessionId_idx" ON "pdf_annotation_imports"("projectId", "sessionId")`,
    `CREATE INDEX "pdf_annotation_imports_sourceKind_sourceFileId_versionId_idx" ON "pdf_annotation_imports"("sourceKind", "sourceFileId", "versionId")`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'pdf_annotation_imports' },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'pdf_annotation_imports',
          constraints: [
            { name: 'PdfAnnotationImport_json_check', expression: 'json_valid("resultJson")' }
          ]
        }
      ]
    }
  ] as const
} as const
