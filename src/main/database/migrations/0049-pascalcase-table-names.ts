// Immutable migration snapshot. Keep all records and relationships while adopting Prisma names.
const pascalcaseTableNamesMigration = {
  id: '0049_pascalcase_table_names',
  statements: [
    'PRAGMA legacy_alter_table = OFF',
    'ALTER TABLE "bookmarks" RENAME TO "Bookmark"',
    'ALTER TABLE "pdf_documents" RENAME TO "PdfDocument"',
    'ALTER TABLE "pdf_annotation_documents" RENAME TO "PdfAnnotationDocument"',
    'ALTER TABLE "pdf_annotation_sources" RENAME TO "PdfAnnotationSourceBinding"',
    'ALTER TABLE "pdf_annotation_aliases" RENAME TO "PdfAnnotationAlias"',
    'ALTER TABLE "pdf_annotations" RENAME TO "PdfAnnotation"',
    'ALTER TABLE "pdf_annotation_imports" RENAME TO "PdfAnnotationImport"',
    'DROP INDEX "pdf_documents_checksum_sizeBytes_key"'
  ],
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 2,
      tables: [
        {
          tableName: 'Bookmark',
          canonicalTableDdl:
            'CREATE TABLE IF NOT EXISTS "Bookmark" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "projectId" TEXT NOT NULL,\n    "sessionId" TEXT NOT NULL,\n    "kind" TEXT NOT NULL,\n    "sourceKind" TEXT NOT NULL,\n    "sourceId" TEXT NOT NULL,\n    "sourceJson" TEXT NOT NULL,\n    "selectorJson" TEXT NOT NULL,\n    "quote" TEXT,\n    "note" TEXT NOT NULL DEFAULT \'\',\n    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    "updatedAt" DATETIME NOT NULL,\n    CONSTRAINT "Bookmark_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT "Bookmark_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sessionId")) > 0 AND length(trim("sourceId")) > 0),\n    CONSTRAINT "Bookmark_kind_check" CHECK ("kind" IN (\'text\', \'pdf-text\', \'pdf-region\') AND "sourceKind" IN (\'agent-message\', \'session-item\', \'project-file\', \'artifact-version\', \'upload-version\', \'literature-attachment-version\')),\n    CONSTRAINT "Bookmark_json_check" CHECK (json_valid("sourceJson") AND json_type("sourceJson") = \'object\' AND json_valid("selectorJson") AND json_type("selectorJson") = \'object\' AND length("sourceJson") <= 65536 AND length("selectorJson") <= 65536),\n    CONSTRAINT "Bookmark_content_check" CHECK (length("note") <= 2000 AND ("quote" IS NULL OR length("quote") BETWEEN 1 AND 4000) AND ("kind" != \'text\' OR "quote" IS NOT NULL))\n);',
          columns: [
            'id',
            'projectId',
            'sessionId',
            'kind',
            'sourceKind',
            'sourceId',
            'sourceJson',
            'selectorJson',
            'quote',
            'note',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'PdfAnnotationDocument',
          canonicalTableDdl:
            'CREATE TABLE IF NOT EXISTS "PdfAnnotationDocument" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "pdfDocumentId" TEXT,\n    "checksum" TEXT NOT NULL,\n    "sizeBytes" BIGINT,\n    "revision" INTEGER NOT NULL DEFAULT 0,\n    CONSTRAINT "PdfAnnotationDocument_pdfDocumentId_fkey" FOREIGN KEY ("pdfDocumentId") REFERENCES "PdfDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE\n);',
          columns: ['id', 'pdfDocumentId', 'checksum', 'sizeBytes', 'revision']
        },
        {
          tableName: 'PdfAnnotationSourceBinding',
          canonicalTableDdl:
            'CREATE TABLE IF NOT EXISTS "PdfAnnotationSourceBinding" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "documentId" TEXT NOT NULL,\n    "projectId" TEXT,\n    "sourceSessionId" TEXT,\n    "sourceKind" TEXT NOT NULL,\n    "sourceFileId" TEXT NOT NULL,\n    "versionId" TEXT NOT NULL,\n    "checksum" TEXT NOT NULL,\n    "name" TEXT NOT NULL,\n    "path" TEXT NOT NULL,\n    CONSTRAINT "PdfAnnotationSourceBinding_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PdfAnnotationDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE\n);',
          columns: [
            'id',
            'documentId',
            'projectId',
            'sourceSessionId',
            'sourceKind',
            'sourceFileId',
            'versionId',
            'checksum',
            'name',
            'path'
          ]
        },
        {
          tableName: 'PdfAnnotationAlias',
          canonicalTableDdl:
            'CREATE TABLE IF NOT EXISTS "PdfAnnotationAlias" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "documentId" TEXT NOT NULL,\n    "annotationId" TEXT,\n    CONSTRAINT "PdfAnnotationAlias_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PdfAnnotationDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE\n);',
          columns: ['id', 'documentId', 'annotationId']
        },
        {
          tableName: 'PdfAnnotation',
          canonicalTableDdl:
            'CREATE TABLE IF NOT EXISTS "PdfAnnotation" (\n    "documentId" TEXT NOT NULL,\n    "nativeKey" TEXT,\n    "nativeBaselineJson" TEXT,\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "projectId" TEXT,\n    "sessionId" TEXT,\n    "sourceSessionId" TEXT,\n    "sourceKind" TEXT NOT NULL,\n    "sourceFileId" TEXT NOT NULL,\n    "versionId" TEXT NOT NULL,\n    "checksum" TEXT NOT NULL,\n    "name" TEXT NOT NULL,\n    "path" TEXT NOT NULL,\n    "kind" TEXT NOT NULL,\n    "selectorJson" TEXT NOT NULL,\n    "color" TEXT,\n    "origin" TEXT NOT NULL DEFAULT \'user\',\n    "externalSubtype" TEXT,\n    "note" TEXT NOT NULL DEFAULT \'\',\n    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    "updatedAt" DATETIME NOT NULL,\n    CONSTRAINT "PdfAnnotation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PdfAnnotationDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT "PdfAnnotation_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sourceFileId")) > 0 AND length(trim("versionId")) > 0 AND length(trim("name")) > 0 AND length(trim("path")) > 0 AND length(trim("sessionId")) > 0),\n    CONSTRAINT "PdfAnnotation_source_check" CHECK ("sourceKind" IN (\'artifact-version\', \'upload-version\', \'literature-attachment-version\') AND length("checksum") = 64 AND "checksum" NOT GLOB \'*[^0-9a-f]*\'),\n    CONSTRAINT "PdfAnnotation_kind_check" CHECK ("kind" IN (\'highlight\', \'underline\', \'squiggly\', \'strikethrough\', \'area\', \'page-note\', \'document-note\') AND ("color" IS NULL OR "color" IN (\'yellow\', \'blue\', \'green\', \'pink\', \'purple\'))),\n    CONSTRAINT "PdfAnnotation_origin_check" CHECK ("origin" IN (\'user\', \'imported\') AND ("origin" = \'imported\' OR "externalSubtype" IS NULL) AND ("externalSubtype" IS NULL OR (length(trim("externalSubtype")) > 0 AND length("externalSubtype") <= 64))),\n    CONSTRAINT "PdfAnnotation_json_check" CHECK (json_valid("selectorJson") AND json_type("selectorJson") = \'object\' AND length("selectorJson") <= 65536),\n    CONSTRAINT "PdfAnnotation_content_check" CHECK (length("note") <= 20000),\n    CONSTRAINT "PdfAnnotation_scope_check" CHECK (("projectId" IS NOT NULL AND "sourceKind" <> \'literature-attachment-version\') OR ("projectId" IS NULL AND "sessionId" IS NULL AND "sourceKind" = \'literature-attachment-version\' AND "sourceSessionId" IS NULL))\n);',
          columns: [
            'documentId',
            'nativeKey',
            'nativeBaselineJson',
            'id',
            'projectId',
            'sessionId',
            'sourceSessionId',
            'sourceKind',
            'sourceFileId',
            'versionId',
            'checksum',
            'name',
            'path',
            'kind',
            'selectorJson',
            'color',
            'origin',
            'externalSubtype',
            'note',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'PdfAnnotationImport',
          canonicalTableDdl:
            'CREATE TABLE IF NOT EXISTS "PdfAnnotationImport" (\n    "documentId" TEXT NOT NULL,\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "projectId" TEXT,\n    "sessionId" TEXT,\n    "sourceKind" TEXT NOT NULL,\n    "sourceFileId" TEXT NOT NULL,\n    "versionId" TEXT NOT NULL,\n    "checksum" TEXT NOT NULL,\n    "resultJson" TEXT NOT NULL,\n    CONSTRAINT "PdfAnnotationImport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PdfAnnotationDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,\n    CONSTRAINT "PdfAnnotationImport_json_check" CHECK (json_valid("resultJson"))\n);',
          columns: [
            'documentId',
            'id',
            'projectId',
            'sessionId',
            'sourceKind',
            'sourceFileId',
            'versionId',
            'checksum',
            'resultJson'
          ]
        }
      ],
      dropOrder: [
        'PdfAnnotationSourceBinding',
        'PdfAnnotationAlias',
        'PdfAnnotation',
        'PdfAnnotationImport',
        'PdfAnnotationDocument',
        'Bookmark'
      ],
      indexes: [
        'CREATE INDEX IF NOT EXISTS "Bookmark_projectId_sessionId_createdAt_id_idx" ON "Bookmark"("projectId", "sessionId", "createdAt", "id");',
        'CREATE INDEX IF NOT EXISTS "Bookmark_projectId_sessionId_sourceKind_sourceId_idx" ON "Bookmark"("projectId", "sessionId", "sourceKind", "sourceId");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "PdfDocument_checksum_sizeBytes_key" ON "PdfDocument"("checksum", "sizeBytes");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotationDocument_pdfDocumentId_idx" ON "PdfAnnotationDocument"("pdfDocumentId");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotationSourceBinding_projectId_sourceFileId_versionId_idx" ON "PdfAnnotationSourceBinding"("projectId", "sourceFileId", "versionId");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotationSourceBinding_documentId_idx" ON "PdfAnnotationSourceBinding"("documentId");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotationAlias_annotationId_idx" ON "PdfAnnotationAlias"("annotationId");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotation_projectId_createdAt_id_idx" ON "PdfAnnotation"("projectId", "createdAt", "id");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotation_projectId_sourceFileId_versionId_createdAt_id_idx" ON "PdfAnnotation"("projectId", "sourceFileId", "versionId", "createdAt", "id");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotation_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "PdfAnnotation"("projectId", "sourceKind", "sourceFileId", "versionId", "createdAt", "id");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotation_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "PdfAnnotation"("sourceKind", "sourceFileId", "versionId", "createdAt", "id");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotation_documentId_createdAt_id_idx" ON "PdfAnnotation"("documentId", "createdAt", "id");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "PdfAnnotation_documentId_nativeKey_key" ON "PdfAnnotation"("documentId", "nativeKey");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "PdfAnnotationImport_documentId_key" ON "PdfAnnotationImport"("documentId");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotationImport_projectId_sessionId_idx" ON "PdfAnnotationImport"("projectId", "sessionId");',
        'CREATE INDEX IF NOT EXISTS "PdfAnnotationImport_sourceKind_sourceFileId_versionId_idx" ON "PdfAnnotationImport"("sourceKind", "sourceFileId", "versionId");'
      ]
    }
  ],
  verifiers: [
    {
      kind: 'table-exists',
      version: 1,
      table: 'Bookmark'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'PdfDocument'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'PdfAnnotationDocument'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'PdfAnnotationSourceBinding'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'PdfAnnotationAlias'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'PdfAnnotation'
    },
    {
      kind: 'table-exists',
      version: 1,
      table: 'PdfAnnotationImport'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'Bookmark',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'PdfAnnotationDocument',
      column: 'pdfDocumentId',
      referencedTable: 'PdfDocument',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ContentBlob',
      column: 'pdfDocumentId',
      referencedTable: 'PdfDocument',
      referencedColumn: 'id',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'PdfAnnotationSourceBinding',
      column: 'documentId',
      referencedTable: 'PdfAnnotationDocument',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'PdfAnnotationAlias',
      column: 'documentId',
      referencedTable: 'PdfAnnotationDocument',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'PdfAnnotation',
      column: 'documentId',
      referencedTable: 'PdfAnnotationDocument',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'PdfAnnotationImport',
      column: 'documentId',
      referencedTable: 'PdfAnnotationDocument',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'Bookmark_projectId_sessionId_createdAt_id_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "Bookmark_projectId_sessionId_createdAt_id_idx" ON "Bookmark"("projectId", "sessionId", "createdAt", "id");'
        },
        {
          name: 'Bookmark_projectId_sessionId_sourceKind_sourceId_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "Bookmark_projectId_sessionId_sourceKind_sourceId_idx" ON "Bookmark"("projectId", "sessionId", "sourceKind", "sourceId");'
        },
        {
          name: 'PdfDocument_checksum_sizeBytes_key',
          sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "PdfDocument_checksum_sizeBytes_key" ON "PdfDocument"("checksum", "sizeBytes");'
        },
        {
          name: 'PdfAnnotationDocument_pdfDocumentId_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotationDocument_pdfDocumentId_idx" ON "PdfAnnotationDocument"("pdfDocumentId");'
        },
        {
          name: 'PdfAnnotationSourceBinding_projectId_sourceFileId_versionId_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotationSourceBinding_projectId_sourceFileId_versionId_idx" ON "PdfAnnotationSourceBinding"("projectId", "sourceFileId", "versionId");'
        },
        {
          name: 'PdfAnnotationSourceBinding_documentId_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotationSourceBinding_documentId_idx" ON "PdfAnnotationSourceBinding"("documentId");'
        },
        {
          name: 'PdfAnnotationAlias_annotationId_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotationAlias_annotationId_idx" ON "PdfAnnotationAlias"("annotationId");'
        },
        {
          name: 'PdfAnnotation_projectId_createdAt_id_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotation_projectId_createdAt_id_idx" ON "PdfAnnotation"("projectId", "createdAt", "id");'
        },
        {
          name: 'PdfAnnotation_projectId_sourceFileId_versionId_createdAt_id_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotation_projectId_sourceFileId_versionId_createdAt_id_idx" ON "PdfAnnotation"("projectId", "sourceFileId", "versionId", "createdAt", "id");'
        },
        {
          name: 'PdfAnnotation_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotation_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "PdfAnnotation"("projectId", "sourceKind", "sourceFileId", "versionId", "createdAt", "id");'
        },
        {
          name: 'PdfAnnotation_sourceKind_sourceFileId_versionId_createdAt_id_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotation_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "PdfAnnotation"("sourceKind", "sourceFileId", "versionId", "createdAt", "id");'
        },
        {
          name: 'PdfAnnotation_documentId_createdAt_id_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotation_documentId_createdAt_id_idx" ON "PdfAnnotation"("documentId", "createdAt", "id");'
        },
        {
          name: 'PdfAnnotation_documentId_nativeKey_key',
          sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "PdfAnnotation_documentId_nativeKey_key" ON "PdfAnnotation"("documentId", "nativeKey");'
        },
        {
          name: 'PdfAnnotationImport_documentId_key',
          sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "PdfAnnotationImport_documentId_key" ON "PdfAnnotationImport"("documentId");'
        },
        {
          name: 'PdfAnnotationImport_projectId_sessionId_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotationImport_projectId_sessionId_idx" ON "PdfAnnotationImport"("projectId", "sessionId");'
        },
        {
          name: 'PdfAnnotationImport_sourceKind_sourceFileId_versionId_idx',
          sql: 'CREATE INDEX IF NOT EXISTS "PdfAnnotationImport_sourceKind_sourceFileId_versionId_idx" ON "PdfAnnotationImport"("sourceKind", "sourceFileId", "versionId");'
        }
      ]
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'Bookmark',
          constraints: [
            {
              name: 'Bookmark_identity_check',
              expression:
                'length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sessionId")) > 0 AND length(trim("sourceId")) > 0'
            },
            {
              name: 'Bookmark_kind_check',
              expression:
                "\"kind\" IN ('text', 'pdf-text', 'pdf-region') AND \"sourceKind\" IN ('agent-message', 'session-item', 'project-file', 'artifact-version', 'upload-version', 'literature-attachment-version')"
            },
            {
              name: 'Bookmark_json_check',
              expression:
                'json_valid("sourceJson") AND json_type("sourceJson") = \'object\' AND json_valid("selectorJson") AND json_type("selectorJson") = \'object\' AND length("sourceJson") <= 65536 AND length("selectorJson") <= 65536'
            },
            {
              name: 'Bookmark_content_check',
              expression:
                'length("note") <= 2000 AND ("quote" IS NULL OR length("quote") BETWEEN 1 AND 4000) AND ("kind" != \'text\' OR "quote" IS NOT NULL)'
            }
          ]
        },
        {
          table: 'PdfAnnotation',
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
          table: 'PdfAnnotationImport',
          constraints: [
            {
              name: 'PdfAnnotationImport_json_check',
              expression: 'json_valid("resultJson")'
            }
          ]
        }
      ]
    },
    {
      kind: 'foreign-key-integrity',
      version: 1
    }
  ]
} as const

export { pascalcaseTableNamesMigration }
