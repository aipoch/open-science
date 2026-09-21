// Initial PDF annotation schema: file-version ownership, global Tags, and native import receipts.
const pdfAnnotationsMigration = {
  id: '0043_pdf_annotations',
  statements: [
    `CREATE TABLE "pdf_annotations" (
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
      CONSTRAINT "PdfAnnotation_scope_check" CHECK (("projectId" IS NOT NULL AND "sourceKind" <> 'literature-attachment-version') OR ("projectId" IS NULL AND "sessionId" IS NULL AND "sourceKind" = 'literature-attachment-version' AND "sourceSessionId" IS NULL)),
      CONSTRAINT "PdfAnnotation_source_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version', 'literature-attachment-version') AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*'),
      CONSTRAINT "PdfAnnotation_kind_check" CHECK ("kind" IN ('highlight', 'underline', 'squiggly', 'strikethrough', 'area', 'page-note', 'document-note') AND ("color" IS NULL OR "color" IN ('yellow', 'blue', 'green', 'pink', 'purple'))),
      CONSTRAINT "PdfAnnotation_origin_check" CHECK ("origin" IN ('user', 'imported') AND ("origin" = 'imported' OR "externalSubtype" IS NULL) AND ("externalSubtype" IS NULL OR (length(trim("externalSubtype")) > 0 AND length("externalSubtype") <= 64))),
      CONSTRAINT "PdfAnnotation_json_check" CHECK (json_valid("selectorJson") AND json_type("selectorJson") = 'object' AND length("selectorJson") <= 65536),
      CONSTRAINT "PdfAnnotation_content_check" CHECK (length("note") <= 20000)
    )`,
    `CREATE INDEX "pdf_annotations_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("sourceKind", "sourceFileId", "versionId", "createdAt", "id")`,
    `CREATE INDEX "pdf_annotations_projectId_createdAt_id_idx" ON "pdf_annotations"("projectId", "createdAt", "id")`,
    `CREATE INDEX "pdf_annotations_projectId_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceFileId", "versionId", "createdAt", "id")`,
    `CREATE INDEX "pdf_annotations_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceKind", "sourceFileId", "versionId", "createdAt", "id")`,
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
    {
      kind: 'table-exists',
      version: 1,
      table: 'pdf_annotations'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'pdf_annotations',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'pdf_annotation_imports'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'pdf_annotation_imports',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'pdf_annotations_sourceKind_sourceFileId_versionId_createdAt_id_idx',
          sql: 'CREATE INDEX "pdf_annotations_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("sourceKind", "sourceFileId", "versionId", "createdAt", "id")'
        },
        {
          name: 'pdf_annotations_projectId_createdAt_id_idx',
          sql: 'CREATE INDEX "pdf_annotations_projectId_createdAt_id_idx" ON "pdf_annotations"("projectId", "createdAt", "id")'
        },
        {
          name: 'pdf_annotations_projectId_sourceFileId_versionId_createdAt_id_idx',
          sql: 'CREATE INDEX "pdf_annotations_projectId_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceFileId", "versionId", "createdAt", "id")'
        },
        {
          name: 'pdf_annotations_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx',
          sql: 'CREATE INDEX "pdf_annotations_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceKind", "sourceFileId", "versionId", "createdAt", "id")'
        },
        {
          name: 'pdf_annotation_imports_projectId_sessionId_idx',
          sql: 'CREATE INDEX "pdf_annotation_imports_projectId_sessionId_idx" ON "pdf_annotation_imports"("projectId", "sessionId")'
        },
        {
          name: 'pdf_annotation_imports_sourceKind_sourceFileId_versionId_idx',
          sql: 'CREATE INDEX "pdf_annotation_imports_sourceKind_sourceFileId_versionId_idx" ON "pdf_annotation_imports"("sourceKind", "sourceFileId", "versionId")'
        }
      ]
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'pdf_annotations',
          constraints: [
            {
              name: 'PdfAnnotation_identity_check',
              expression:
                'length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sourceFileId")) > 0 AND length(trim("versionId")) > 0 AND length(trim("name")) > 0 AND length(trim("path")) > 0 AND length(trim("sessionId")) > 0'
            },
            {
              name: 'PdfAnnotation_source_check',
              expression:
                "\"sourceKind\" IN ('artifact-version', 'upload-version', 'literature-attachment-version') AND length(\"checksum\") = 64 AND \"checksum\" NOT GLOB '*[^0-9a-f]*'"
            },
            {
              name: 'PdfAnnotation_kind_check',
              expression:
                "\"kind\" IN ('highlight', 'underline', 'squiggly', 'strikethrough', 'area', 'page-note', 'document-note') AND (\"color\" IS NULL OR \"color\" IN ('yellow', 'blue', 'green', 'pink', 'purple'))"
            },
            {
              name: 'PdfAnnotation_origin_check',
              expression:
                '"origin" IN (\'user\', \'imported\') AND ("origin" = \'imported\' OR "externalSubtype" IS NULL) AND ("externalSubtype" IS NULL OR (length(trim("externalSubtype")) > 0 AND length("externalSubtype") <= 64))'
            },
            {
              name: 'PdfAnnotation_json_check',
              expression:
                'json_valid("selectorJson") AND json_type("selectorJson") = \'object\' AND length("selectorJson") <= 65536'
            },
            {
              name: 'PdfAnnotation_content_check',
              expression: 'length("note") <= 20000'
            },
            {
              name: 'PdfAnnotation_scope_check',
              expression:
                '("projectId" IS NOT NULL AND "sourceKind" <> \'literature-attachment-version\') OR ("projectId" IS NULL AND "sessionId" IS NULL AND "sourceKind" = \'literature-attachment-version\' AND "sourceSessionId" IS NULL)'
            }
          ]
        },
        {
          table: 'pdf_annotation_imports',
          constraints: [
            {
              name: 'PdfAnnotationImport_json_check',
              expression: 'json_valid("resultJson")'
            }
          ]
        }
      ]
    }
  ]
} as const
export { pdfAnnotationsMigration }
