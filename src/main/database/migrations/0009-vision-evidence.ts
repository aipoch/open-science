/* Immutable 0009 migration snapshot. Do not regenerate after release. */

const VISION_EVIDENCE_DDL = `CREATE TABLE IF NOT EXISTS "VisionEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "uploadVersionId" TEXT,
    "sourceMessageId" TEXT,
    "sourceImageId" TEXT,
    "imageChecksum" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extractorFingerprint" TEXT NOT NULL,
    "evidenceSchemaVersion" INTEGER NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VisionEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VisionEvidence_uploadVersionId_fkey" FOREIGN KEY ("uploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VisionEvidence_sourceKind_check" CHECK ("sourceKind" IN ('upload-version', 'message-image')),
    CONSTRAINT "VisionEvidence_sourceIdentity_check" CHECK ((("sourceKind" = 'upload-version' AND "uploadVersionId" IS NOT NULL AND "sourceMessageId" IS NULL AND "sourceImageId" IS NULL) OR ("sourceKind" = 'message-image' AND "uploadVersionId" IS NULL AND "sourceMessageId" IS NOT NULL AND "sourceImageId" IS NOT NULL))),
    CONSTRAINT "VisionEvidence_schemaVersion_check" CHECK ("evidenceSchemaVersion" >= 1),
    CONSTRAINT "VisionEvidence_imageChecksum_check" CHECK (length("imageChecksum") = 64 AND "imageChecksum" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_extractorFingerprint_check" CHECK (length("extractorFingerprint") = 64 AND "extractorFingerprint" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_evidenceChecksum_check" CHECK (length("evidenceChecksum") = 64 AND "evidenceChecksum" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_evidenceJson_check" CHECK (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object')
);`

const VISION_EVIDENCE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "VisionEvidence_projectId_sessionId_idx" ON "VisionEvidence"("projectId", "sessionId");`,
  `CREATE INDEX IF NOT EXISTS "VisionEvidence_sessionId_idx" ON "VisionEvidence"("sessionId");`,
  `CREATE INDEX IF NOT EXISTS "VisionEvidence_uploadVersionId_idx" ON "VisionEvidence"("uploadVersionId");`
] as const

const visionEvidenceMigration = {
  id: '0009_vision_evidence',
  statements: [VISION_EVIDENCE_DDL, ...VISION_EVIDENCE_INDEXES] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'VisionEvidence',
          canonicalTableDdl: VISION_EVIDENCE_DDL,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'sourceKind',
            'uploadVersionId',
            'sourceMessageId',
            'sourceImageId',
            'imageChecksum',
            'mimeType',
            'extractorFingerprint',
            'evidenceSchemaVersion',
            'evidenceJson',
            'evidenceChecksum',
            'createdAt',
            'updatedAt'
          ]
        }
      ],
      dropOrder: ['VisionEvidence'],
      indexes: VISION_EVIDENCE_INDEXES
    }
  ] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'VisionEvidence' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'VisionEvidence',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'VisionEvidence',
      column: 'uploadVersionId',
      referencedTable: 'UploadVersion',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'VisionEvidence',
          constraints: [
            {
              name: 'VisionEvidence_sourceKind_check',
              expression: `"sourceKind" IN ('upload-version', 'message-image')`
            },
            {
              name: 'VisionEvidence_sourceIdentity_check',
              expression: `(("sourceKind" = 'upload-version' AND "uploadVersionId" IS NOT NULL AND "sourceMessageId" IS NULL AND "sourceImageId" IS NULL) OR ("sourceKind" = 'message-image' AND "uploadVersionId" IS NULL AND "sourceMessageId" IS NOT NULL AND "sourceImageId" IS NOT NULL))`
            },
            {
              name: 'VisionEvidence_schemaVersion_check',
              expression: `"evidenceSchemaVersion" >= 1`
            },
            {
              name: 'VisionEvidence_imageChecksum_check',
              expression: `length("imageChecksum") = 64 AND "imageChecksum" NOT GLOB '*[^0-9a-f]*'`
            },
            {
              name: 'VisionEvidence_extractorFingerprint_check',
              expression: `length("extractorFingerprint") = 64 AND "extractorFingerprint" NOT GLOB '*[^0-9a-f]*'`
            },
            {
              name: 'VisionEvidence_evidenceChecksum_check',
              expression: `length("evidenceChecksum") = 64 AND "evidenceChecksum" NOT GLOB '*[^0-9a-f]*'`
            },
            {
              name: 'VisionEvidence_evidenceJson_check',
              expression: `json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'`
            }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'VisionEvidence_projectId_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "VisionEvidence_projectId_sessionId_idx" ON "VisionEvidence"("projectId", "sessionId");`
        },
        {
          name: 'VisionEvidence_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "VisionEvidence_sessionId_idx" ON "VisionEvidence"("sessionId");`
        },
        {
          name: 'VisionEvidence_uploadVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "VisionEvidence_uploadVersionId_idx" ON "VisionEvidence"("uploadVersionId");`
        }
      ]
    }
  ] as const
}

export { visionEvidenceMigration }
