// Immutable migration snapshot. Legacy notes are reconciled only after content verification.
const pdfAnnotationSharingMigration = {
  id: '0048_pdf_annotation_sharing',
  statements: [
    'CREATE TABLE IF NOT EXISTS "pdf_documents" ("id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL, "sizeBytes" BIGINT NOT NULL);',
    'CREATE UNIQUE INDEX IF NOT EXISTS "pdf_documents_checksum_sizeBytes_key" ON "pdf_documents"("checksum", "sizeBytes");',
    'CREATE TABLE IF NOT EXISTS "ContentBlob_pdf_identity" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "pdfDocumentId" TEXT,\n    "checksum" TEXT NOT NULL,\n    "storageKey" TEXT NOT NULL,\n    "sizeBytes" BIGINT NOT NULL,\n    "contentType" TEXT,\n    "state" TEXT NOT NULL DEFAULT \'staging\',\n    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    "verifiedAt" DATETIME,\n    "lastVerificationFailure" TEXT,\n    "lastVerificationAttemptAt" DATETIME,\n    CONSTRAINT "ContentBlob_pdfDocumentId_fkey" FOREIGN KEY ("pdfDocumentId") REFERENCES "pdf_documents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,\n    CONSTRAINT "ContentBlob_state_check" CHECK ("state" IN (\'staging\', \'available\', \'quarantined\')),\n    CONSTRAINT "ContentBlob_sizeBytes_check" CHECK ("sizeBytes" >= 0)\n);',
    'INSERT INTO "ContentBlob_pdf_identity" ("id", "checksum", "storageKey", "sizeBytes", "contentType", "state", "createdAt", "verifiedAt", "lastVerificationFailure", "lastVerificationAttemptAt") SELECT "id", "checksum", "storageKey", "sizeBytes", "contentType", "state", "createdAt", "verifiedAt", "lastVerificationFailure", "lastVerificationAttemptAt" FROM "ContentBlob"',
    'DROP TABLE "ContentBlob"',
    'ALTER TABLE "ContentBlob_pdf_identity" RENAME TO "ContentBlob"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "ContentBlob_storageKey_key" ON "ContentBlob"("storageKey");',
    'CREATE INDEX IF NOT EXISTS "ContentBlob_checksum_sizeBytes_idx" ON "ContentBlob"("checksum", "sizeBytes");',
    'CREATE INDEX IF NOT EXISTS "ContentBlob_state_createdAt_idx" ON "ContentBlob"("state", "createdAt");',
    'CREATE INDEX IF NOT EXISTS "ContentBlob_pdfDocumentId_idx" ON "ContentBlob"("pdfDocumentId");',
    'CREATE TABLE IF NOT EXISTS "pdf_annotation_documents" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "pdfDocumentId" TEXT,\n    "checksum" TEXT NOT NULL,\n    "sizeBytes" BIGINT,\n    "revision" INTEGER NOT NULL DEFAULT 0,\n    CONSTRAINT "pdf_annotation_documents_pdfDocumentId_fkey" FOREIGN KEY ("pdfDocumentId") REFERENCES "pdf_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE\n);',
    'CREATE INDEX IF NOT EXISTS "pdf_annotation_documents_pdfDocumentId_idx" ON "pdf_annotation_documents"("pdfDocumentId");',
    'CREATE TABLE IF NOT EXISTS "pdf_annotation_sources" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "documentId" TEXT NOT NULL,\n    "projectId" TEXT,\n    "sourceSessionId" TEXT,\n    "sourceKind" TEXT NOT NULL,\n    "sourceFileId" TEXT NOT NULL,\n    "versionId" TEXT NOT NULL,\n    "checksum" TEXT NOT NULL,\n    "name" TEXT NOT NULL,\n    "path" TEXT NOT NULL,\n    CONSTRAINT "pdf_annotation_sources_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "pdf_annotation_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE\n);',
    'CREATE TABLE IF NOT EXISTS "pdf_annotation_aliases" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "documentId" TEXT NOT NULL,\n    "annotationId" TEXT,\n    CONSTRAINT "pdf_annotation_aliases_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "pdf_annotation_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE\n);',
    'INSERT OR IGNORE INTO "pdf_annotation_documents" (id, checksum) SELECT json_array("projectId", "sourceKind", "sourceFileId", "versionId", "checksum"), checksum FROM "pdf_annotations"',
    'INSERT OR IGNORE INTO "pdf_annotation_documents" (id, checksum) SELECT json_array("projectId", "sourceKind", "sourceFileId", "versionId", "checksum"), checksum FROM "pdf_annotation_imports"',
    'INSERT OR IGNORE INTO "pdf_annotation_sources" (id, documentId, projectId, sourceSessionId, sourceKind, sourceFileId, versionId, checksum, name, path) SELECT json_array("projectId", "sourceKind", "sourceFileId", "versionId"), json_array("projectId", "sourceKind", "sourceFileId", "versionId", "checksum"), projectId, sourceSessionId, sourceKind, sourceFileId, versionId, checksum, name, path FROM pdf_annotations',
    'INSERT OR IGNORE INTO "pdf_annotation_sources" (id, documentId, projectId, sourceKind, sourceFileId, versionId, checksum, name, path) SELECT json_array("projectId", "sourceKind", "sourceFileId", "versionId"), json_array("projectId", "sourceKind", "sourceFileId", "versionId", "checksum"), projectId, sourceKind, sourceFileId, versionId, checksum, \'PDF\', CASE WHEN sourceKind = \'literature-attachment-version\' THEN \'literature-attachment-version:\' ELSE \'upload-version:\' END || versionId FROM pdf_annotation_imports',
    'ALTER TABLE "pdf_annotations" RENAME TO "pdf_annotations_legacy_sharing"',
    'CREATE TABLE IF NOT EXISTS "pdf_annotations" (\n    "documentId" TEXT NOT NULL,\n    "nativeKey" TEXT,\n    "nativeBaselineJson" TEXT,\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "projectId" TEXT,\n    "sessionId" TEXT,\n    "sourceSessionId" TEXT,\n    "sourceKind" TEXT NOT NULL,\n    "sourceFileId" TEXT NOT NULL,\n    "versionId" TEXT NOT NULL,\n    "checksum" TEXT NOT NULL,\n    "name" TEXT NOT NULL,\n    "path" TEXT NOT NULL,\n    "kind" TEXT NOT NULL,\n    "selectorJson" TEXT NOT NULL,\n    "color" TEXT,\n    "origin" TEXT NOT NULL DEFAULT \'user\',\n    "externalSubtype" TEXT,\n    "note" TEXT NOT NULL DEFAULT \'\',\n    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    "updatedAt" DATETIME NOT NULL,\n    CONSTRAINT "pdf_annotations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "pdf_annotation_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT "PdfAnnotation_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sourceFileId")) > 0 AND length(trim("versionId")) > 0 AND length(trim("name")) > 0 AND length(trim("path")) > 0 AND length(trim("sessionId")) > 0),\n    CONSTRAINT "PdfAnnotation_source_check" CHECK ("sourceKind" IN (\'artifact-version\', \'upload-version\', \'literature-attachment-version\') AND length("checksum") = 64 AND "checksum" NOT GLOB \'*[^0-9a-f]*\'),\n    CONSTRAINT "PdfAnnotation_kind_check" CHECK ("kind" IN (\'highlight\', \'underline\', \'squiggly\', \'strikethrough\', \'area\', \'page-note\', \'document-note\') AND ("color" IS NULL OR "color" IN (\'yellow\', \'blue\', \'green\', \'pink\', \'purple\'))),\n    CONSTRAINT "PdfAnnotation_origin_check" CHECK ("origin" IN (\'user\', \'imported\') AND ("origin" = \'imported\' OR "externalSubtype" IS NULL) AND ("externalSubtype" IS NULL OR (length(trim("externalSubtype")) > 0 AND length("externalSubtype") <= 64))),\n    CONSTRAINT "PdfAnnotation_json_check" CHECK (json_valid("selectorJson") AND json_type("selectorJson") = \'object\' AND length("selectorJson") <= 65536),\n    CONSTRAINT "PdfAnnotation_content_check" CHECK (length("note") <= 20000),\n    CONSTRAINT "PdfAnnotation_scope_check" CHECK (("projectId" IS NOT NULL AND "sourceKind" <> \'literature-attachment-version\') OR ("projectId" IS NULL AND "sessionId" IS NULL AND "sourceKind" = \'literature-attachment-version\' AND "sourceSessionId" IS NULL))\n);',
    'INSERT INTO "pdf_annotations" ("documentId", "id", "projectId", "sessionId", "sourceSessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "name", "path", "kind", "selectorJson", "color", "origin", "externalSubtype", "note", "createdAt", "updatedAt") SELECT json_array("projectId", "sourceKind", "sourceFileId", "versionId", "checksum"), "id", "projectId", "sessionId", "sourceSessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "name", "path", "kind", "selectorJson", "color", "origin", "externalSubtype", "note", "createdAt", "updatedAt" FROM "pdf_annotations_legacy_sharing"',
    'DROP TABLE "pdf_annotations_legacy_sharing"',
    'ALTER TABLE "pdf_annotation_imports" RENAME TO "pdf_annotation_imports_legacy_sharing"',
    'CREATE TABLE IF NOT EXISTS "pdf_annotation_imports" (\n    "documentId" TEXT NOT NULL,\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "projectId" TEXT,\n    "sessionId" TEXT,\n    "sourceKind" TEXT NOT NULL,\n    "sourceFileId" TEXT NOT NULL,\n    "versionId" TEXT NOT NULL,\n    "checksum" TEXT NOT NULL,\n    "resultJson" TEXT NOT NULL,\n    CONSTRAINT "pdf_annotation_imports_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "pdf_annotation_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT "PdfAnnotationImport_json_check" CHECK (json_valid("resultJson"))\n);',
    'INSERT INTO "pdf_annotation_imports" ("documentId", "id", "projectId", "sessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "resultJson") SELECT json_array("projectId", "sourceKind", "sourceFileId", "versionId", "checksum"), "id", "projectId", "sessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "resultJson" FROM "pdf_annotation_imports_legacy_sharing"',
    'DROP TABLE "pdf_annotation_imports_legacy_sharing"',
    'CREATE INDEX IF NOT EXISTS "pdf_annotation_sources_projectId_sourceFileId_versionId_idx" ON "pdf_annotation_sources"("projectId", "sourceFileId", "versionId");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotation_sources_documentId_idx" ON "pdf_annotation_sources"("documentId");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotation_aliases_annotationId_idx" ON "pdf_annotation_aliases"("annotationId");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotations_projectId_createdAt_id_idx" ON "pdf_annotations"("projectId", "createdAt", "id");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotations_projectId_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceFileId", "versionId", "createdAt", "id");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotations_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceKind", "sourceFileId", "versionId", "createdAt", "id");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotations_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("sourceKind", "sourceFileId", "versionId", "createdAt", "id");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotations_documentId_createdAt_id_idx" ON "pdf_annotations"("documentId", "createdAt", "id");',
    'CREATE UNIQUE INDEX IF NOT EXISTS "pdf_annotations_documentId_nativeKey_key" ON "pdf_annotations"("documentId", "nativeKey");',
    'CREATE UNIQUE INDEX IF NOT EXISTS "pdf_annotation_imports_documentId_key" ON "pdf_annotation_imports"("documentId");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotation_imports_projectId_sessionId_idx" ON "pdf_annotation_imports"("projectId", "sessionId");',
    'CREATE INDEX IF NOT EXISTS "pdf_annotation_imports_sourceKind_sourceFileId_versionId_idx" ON "pdf_annotation_imports"("sourceKind", "sourceFileId", "versionId");'
  ],
  operations: [],
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'pdf_documents' },
    { kind: 'column-exists', version: 1, table: 'ContentBlob', column: 'pdfDocumentId' },
    {
      kind: 'column-exists',
      version: 1,
      table: 'pdf_annotation_documents',
      column: 'pdfDocumentId'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'pdf_annotation_documents'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'pdf_annotation_sources'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'pdf_annotation_aliases'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'pdf_annotations',
      column: 'documentId'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'pdf_annotation_imports',
      column: 'documentId'
    }
  ]
} as const
export { pdfAnnotationSharingMigration }
