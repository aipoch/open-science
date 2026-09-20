// Keep native PDF annotations distinguishable from marks created in Open Science without
// introducing a second annotation table. Existing test rows have no reliable native provenance and default to user.
const pdfAnnotationOriginMigration = {
  id: '0045_pdf_annotation_origin',
  statements: [
    `CREATE TABLE "pdf_annotations_next" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT,
      "sessionId" TEXT,
      "sourceSessionId" TEXT,
      "sourceKind" TEXT NOT NULL,
      "sourceFileId" TEXT NOT NULL,
      "versionId" TEXT NOT NULL,
      "checksum" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "selectorJson" TEXT NOT NULL,
      "color" TEXT,
      "origin" TEXT NOT NULL DEFAULT 'user',
      "externalSubtype" TEXT,
      "note" TEXT NOT NULL DEFAULT '',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "pdf_annotations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "PdfAnnotation_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sourceFileId")) > 0 AND length(trim("versionId")) > 0 AND length(trim("name")) > 0 AND length(trim("path")) > 0 AND length(trim("sessionId")) > 0),
      CONSTRAINT "PdfAnnotation_scope_check" CHECK (("projectId" IS NOT NULL AND "sessionId" IS NOT NULL) OR ("projectId" IS NULL AND "sessionId" IS NULL AND "sourceKind" = 'literature-attachment-version' AND "sourceSessionId" IS NULL)),
      CONSTRAINT "PdfAnnotation_source_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version', 'literature-attachment-version') AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*'),
      CONSTRAINT "PdfAnnotation_kind_check" CHECK ("kind" IN ('highlight', 'underline', 'squiggly', 'strikethrough', 'area', 'page-note', 'document-note') AND ("color" IS NULL OR "color" IN ('yellow', 'blue', 'green', 'pink', 'purple'))),
      CONSTRAINT "PdfAnnotation_origin_check" CHECK ("origin" IN ('user', 'imported') AND ("origin" = 'imported' OR "externalSubtype" IS NULL) AND ("externalSubtype" IS NULL OR (length(trim("externalSubtype")) > 0 AND length("externalSubtype") <= 64))),
      CONSTRAINT "PdfAnnotation_json_check" CHECK (json_valid("selectorJson") AND json_type("selectorJson") = 'object' AND length("selectorJson") <= 65536),
      CONSTRAINT "PdfAnnotation_content_check" CHECK (length("note") <= 20000)
    )`,
    `INSERT INTO "pdf_annotations_next" ("id", "projectId", "sessionId", "sourceSessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "name", "path", "kind", "selectorJson", "color", "origin", "externalSubtype", "note", "createdAt", "updatedAt") SELECT "id", "projectId", "sessionId", "sourceSessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "name", "path", "kind", "selectorJson", "color", 'user', NULL, "note", "createdAt", "updatedAt" FROM "pdf_annotations"`,
    `DROP TABLE "pdf_annotations"`,
    `ALTER TABLE "pdf_annotations_next" RENAME TO "pdf_annotations"`,
    `CREATE INDEX "pdf_annotations_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("sourceKind", "sourceFileId", "versionId", "createdAt", "id")`,
    `CREATE INDEX "pdf_annotations_projectId_sessionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sessionId", "createdAt", "id")`,
    `CREATE INDEX "pdf_annotations_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceKind", "sourceFileId", "versionId", "createdAt", "id")`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'pdf_annotations',
          constraints: [
            {
              name: 'PdfAnnotation_origin_check',
              expression:
                '"origin" IN (\'user\', \'imported\') AND ("origin" = \'imported\' OR "externalSubtype" IS NULL) AND ("externalSubtype" IS NULL OR (length(trim("externalSubtype")) > 0 AND length("externalSubtype") <= 64))'
            }
          ]
        }
      ]
    }
  ] as const
} as const

export { pdfAnnotationOriginMigration }
