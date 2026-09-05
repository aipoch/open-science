const literatureFoundationIndexes = [
  {
    name: 'LiteratureInboxPdf_candidateId_checksum_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureInboxPdf_candidateId_checksum_key" ON "LiteratureInboxPdf"("candidateId", "checksum")'
  },
  {
    name: 'LiteratureInboxPdf_contentBlobId_idx',
    sql: 'CREATE INDEX "LiteratureInboxPdf_contentBlobId_idx" ON "LiteratureInboxPdf"("contentBlobId")'
  },
  {
    name: 'LiteratureCollection_root_nameKey_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureCollection_root_nameKey_key" ON "LiteratureCollection"("nameKey") WHERE "parentId" IS NULL'
  },
  {
    name: 'ContentBlob_storageKey_key',
    sql: 'CREATE UNIQUE INDEX "ContentBlob_storageKey_key" ON "ContentBlob"("storageKey")'
  },
  {
    name: 'ContentBlob_checksum_sizeBytes_idx',
    sql: 'CREATE INDEX "ContentBlob_checksum_sizeBytes_idx" ON "ContentBlob"("checksum", "sizeBytes")'
  },
  {
    name: 'ContentBlob_state_createdAt_idx',
    sql: 'CREATE INDEX "ContentBlob_state_createdAt_idx" ON "ContentBlob"("state", "createdAt")'
  },
  {
    name: 'UploadVersion_contentBlobId_idx',
    sql: 'CREATE INDEX "UploadVersion_contentBlobId_idx" ON "UploadVersion"("contentBlobId")'
  },
  {
    name: 'ArtifactVersion_contentBlobId_idx',
    sql: 'CREATE INDEX "ArtifactVersion_contentBlobId_idx" ON "ArtifactVersion"("contentBlobId")'
  },
  {
    name: 'LiteratureItem_deletedAt_updatedAt_idx',
    sql: 'CREATE INDEX "LiteratureItem_deletedAt_updatedAt_idx" ON "LiteratureItem"("deletedAt", "updatedAt")'
  },
  {
    name: 'LiteratureItem_mergedIntoItemId_idx',
    sql: 'CREATE INDEX "LiteratureItem_mergedIntoItemId_idx" ON "LiteratureItem"("mergedIntoItemId")'
  },
  {
    name: 'LiteratureItem_itemType_issuedYear_idx',
    sql: 'CREATE INDEX "LiteratureItem_itemType_issuedYear_idx" ON "LiteratureItem"("itemType", "issuedYear")'
  },
  {
    name: 'LiteratureItem_title_idx',
    sql: 'CREATE INDEX "LiteratureItem_title_idx" ON "LiteratureItem"("title")'
  },
  {
    name: 'LiteratureItem_citationKey_idx',
    sql: 'CREATE INDEX "LiteratureItem_citationKey_idx" ON "LiteratureItem"("citationKey")'
  },
  {
    name: 'LiteratureAttachment_itemId_sortOrder_idx',
    sql: 'CREATE INDEX "LiteratureAttachment_itemId_sortOrder_idx" ON "LiteratureAttachment"("itemId", "sortOrder")'
  },
  {
    name: 'LiteratureAttachmentVersion_attachmentId_versionNumber_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureAttachmentVersion_attachmentId_versionNumber_key" ON "LiteratureAttachmentVersion"("attachmentId", "versionNumber")'
  },
  {
    name: 'LiteratureAttachmentVersion_attachmentId_checksum_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureAttachmentVersion_attachmentId_checksum_key" ON "LiteratureAttachmentVersion"("attachmentId", "checksum")'
  },
  {
    name: 'LiteratureAttachmentVersion_contentBlobId_idx',
    sql: 'CREATE INDEX "LiteratureAttachmentVersion_contentBlobId_idx" ON "LiteratureAttachmentVersion"("contentBlobId")'
  },
  {
    name: 'LiteratureCreator_normalizedName_idx',
    sql: 'CREATE INDEX "LiteratureCreator_normalizedName_idx" ON "LiteratureCreator"("normalizedName")'
  },
  {
    name: 'LiteratureItemCreator_creatorId_idx',
    sql: 'CREATE INDEX "LiteratureItemCreator_creatorId_idx" ON "LiteratureItemCreator"("creatorId")'
  },
  {
    name: 'LiteratureItemCreator_itemId_creatorType_idx',
    sql: 'CREATE INDEX "LiteratureItemCreator_itemId_creatorType_idx" ON "LiteratureItemCreator"("itemId", "creatorType")'
  },
  {
    name: 'LiteratureIdentifier_itemId_scheme_normalizedValue_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureIdentifier_itemId_scheme_normalizedValue_key" ON "LiteratureIdentifier"("itemId", "scheme", "normalizedValue")'
  },
  {
    name: 'LiteratureIdentifier_scheme_normalizedValue_idx',
    sql: 'CREATE INDEX "LiteratureIdentifier_scheme_normalizedValue_idx" ON "LiteratureIdentifier"("scheme", "normalizedValue")'
  },
  {
    name: 'LiteratureIdentifier_itemId_isPrimary_idx',
    sql: 'CREATE INDEX "LiteratureIdentifier_itemId_isPrimary_idx" ON "LiteratureIdentifier"("itemId", "isPrimary")'
  },
  {
    name: 'LiteratureInboxCandidate_dedupeKey_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureInboxCandidate_dedupeKey_key" ON "LiteratureInboxCandidate"("dedupeKey")'
  },
  {
    name: 'LiteratureInboxCandidate_state_createdAt_idx',
    sql: 'CREATE INDEX "LiteratureInboxCandidate_state_createdAt_idx" ON "LiteratureInboxCandidate"("state", "createdAt")'
  },
  {
    name: 'LiteratureInboxCandidate_sourceProjectId_sourceSessionId_idx',
    sql: 'CREATE INDEX "LiteratureInboxCandidate_sourceProjectId_sourceSessionId_idx" ON "LiteratureInboxCandidate"("sourceProjectId", "sourceSessionId")'
  },
  {
    name: 'LiteratureInboxCandidate_acceptedItemId_idx',
    sql: 'CREATE INDEX "LiteratureInboxCandidate_acceptedItemId_idx" ON "LiteratureInboxCandidate"("acceptedItemId")'
  },
  {
    name: 'LiteratureSourceRecord_provider_externalId_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureSourceRecord_provider_externalId_key" ON "LiteratureSourceRecord"("provider", "externalId")'
  },
  {
    name: 'LiteratureSourceRecord_itemId_provider_idx',
    sql: 'CREATE INDEX "LiteratureSourceRecord_itemId_provider_idx" ON "LiteratureSourceRecord"("itemId", "provider")'
  },
  {
    name: 'LiteratureSourceRecord_inboxCandidateId_provider_idx',
    sql: 'CREATE INDEX "LiteratureSourceRecord_inboxCandidateId_provider_idx" ON "LiteratureSourceRecord"("inboxCandidateId", "provider")'
  },
  {
    name: 'LiteratureCollection_parentId_nameKey_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureCollection_parentId_nameKey_key" ON "LiteratureCollection"("parentId", "nameKey")'
  },
  {
    name: 'LiteratureCollection_parentId_sortOrder_idx',
    sql: 'CREATE INDEX "LiteratureCollection_parentId_sortOrder_idx" ON "LiteratureCollection"("parentId", "sortOrder")'
  },
  {
    name: 'LiteratureCollectionItem_itemId_idx',
    sql: 'CREATE INDEX "LiteratureCollectionItem_itemId_idx" ON "LiteratureCollectionItem"("itemId")'
  },
  {
    name: 'LiteratureCollectionItem_collectionId_sortOrder_idx',
    sql: 'CREATE INDEX "LiteratureCollectionItem_collectionId_sortOrder_idx" ON "LiteratureCollectionItem"("collectionId", "sortOrder")'
  },
  {
    name: 'ProjectLiterature_itemId_idx',
    sql: 'CREATE INDEX "ProjectLiterature_itemId_idx" ON "ProjectLiterature"("itemId")'
  },
  {
    name: 'ProjectLiterature_projectId_addedAt_idx',
    sql: 'CREATE INDEX "ProjectLiterature_projectId_addedAt_idx" ON "ProjectLiterature"("projectId", "addedAt")'
  }
] as const

// Used by both fresh migration and current-schema adoption. Existing bindings remain authoritative.
// A conflicting deterministic blob ID fails the transaction instead of replacing stored content.
const literatureContentBlobBackfillStatements = [
  `INSERT INTO "ContentBlob" (
      "id", "checksum", "storageKey", "sizeBytes", "contentType", "state", "createdAt", "verifiedAt"
    )
    SELECT
      'upload-version:' || "id",
      "checksum",
      "contentStorageKey",
      "sizeBytes",
      "contentType",
      CASE WHEN "state" = 'ready' THEN 'available' ELSE 'staging' END,
      COALESCE("createdAt", "registeredAt"),
      CASE WHEN "state" = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END
    FROM "UploadVersion" WHERE "contentBlobId" IS NULL`,
  `UPDATE "UploadVersion"
      SET "contentBlobId" = 'upload-version:' || "id" WHERE "contentBlobId" IS NULL`,
  `INSERT INTO "ContentBlob" (
      "id", "checksum", "storageKey", "sizeBytes", "contentType", "state", "createdAt", "verifiedAt"
    )
    SELECT
      'artifact-version:' || "id",
      "checksum",
      "contentStorageKey",
      "sizeBytes",
      "contentType",
      CASE WHEN "state" = 'staging' THEN 'staging' ELSE 'available' END,
      "createdAt",
      CASE WHEN "state" = 'staging' THEN NULL ELSE CURRENT_TIMESTAMP END
    FROM "ArtifactVersion" WHERE "contentBlobId" IS NULL`,
  `UPDATE "ArtifactVersion"
      SET "contentBlobId" = 'artifact-version:' || "id" WHERE "contentBlobId" IS NULL`
] as const

const literatureFoundationMigration = {
  id: '0030_literature_foundation',
  statements: [
    `CREATE TABLE "ContentBlob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "storageKey" TEXT NOT NULL,
      "sizeBytes" BIGINT NOT NULL,
      "contentType" TEXT,
      "state" TEXT NOT NULL DEFAULT 'staging',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "verifiedAt" DATETIME,
      CONSTRAINT "ContentBlob_state_check"
        CHECK ("state" IN ('staging', 'available', 'quarantined')),
      CONSTRAINT "ContentBlob_sizeBytes_check" CHECK ("sizeBytes" >= 0)
    )`,
    `ALTER TABLE "UploadVersion" ADD COLUMN "contentBlobId" TEXT`,
    `ALTER TABLE "ArtifactVersion" ADD COLUMN "contentBlobId" TEXT`,
    ...literatureContentBlobBackfillStatements,
    `CREATE TABLE "LiteratureItem" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "itemType" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "abstract" TEXT NOT NULL DEFAULT '',
      "issuedText" TEXT NOT NULL DEFAULT '',
      "issuedYear" INTEGER,
      "containerTitle" TEXT NOT NULL DEFAULT '',
      "shortTitle" TEXT NOT NULL DEFAULT '',
      "language" TEXT NOT NULL DEFAULT '',
      "rights" TEXT NOT NULL DEFAULT '',
      "url" TEXT NOT NULL DEFAULT '',
      "accessedAt" DATETIME,
      "citationKey" TEXT,
      "extra" TEXT NOT NULL DEFAULT '',
      "rating" INTEGER NOT NULL DEFAULT 0,
      "personalNote" TEXT NOT NULL DEFAULT '',
      "typeFieldsJson" TEXT NOT NULL DEFAULT '{}',
      "metadataRevision" INTEGER NOT NULL DEFAULT 1,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      "deletedAt" DATETIME,
      "mergedIntoItemId" TEXT,
      CONSTRAINT "LiteratureItem_mergedIntoItemId_fkey" FOREIGN KEY ("mergedIntoItemId") REFERENCES "LiteratureItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "LiteratureItem_identity_check" CHECK (length(trim("itemType")) > 0 AND length(trim("title")) > 0 AND "metadataRevision" >= 1 AND "rating" BETWEEN 0 AND 5 AND ("issuedYear" IS NULL OR "issuedYear" BETWEEN 0 AND 9999)),
      CONSTRAINT "LiteratureItem_merge_check" CHECK ("mergedIntoItemId" IS NULL OR ("mergedIntoItemId" <> "id" AND "deletedAt" IS NOT NULL)),
      CONSTRAINT "LiteratureItem_typeFieldsJson_check" CHECK (json_valid("typeFieldsJson") AND json_type("typeFieldsJson") = 'object')
    )`,
    `CREATE TABLE "LiteratureAttachment" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "itemId" TEXT NOT NULL,
      "kind" TEXT NOT NULL DEFAULT 'fullText',
      "title" TEXT NOT NULL DEFAULT '',
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "LiteratureAttachment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureAttachment_shape_check" CHECK (length(trim("kind")) > 0 AND "sortOrder" >= 0)
    )`,
    `CREATE TABLE "LiteratureAttachmentVersion" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "attachmentId" TEXT NOT NULL,
      "contentBlobId" TEXT NOT NULL,
      "versionNumber" INTEGER NOT NULL,
      "filename" TEXT NOT NULL,
      "contentType" TEXT NOT NULL,
      "sizeBytes" BIGINT NOT NULL,
      "checksum" TEXT NOT NULL,
      "pageCount" INTEGER,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LiteratureAttachmentVersion_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "LiteratureAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureAttachmentVersion_contentBlobId_fkey" FOREIGN KEY ("contentBlobId") REFERENCES "ContentBlob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "LiteratureAttachmentVersion_shape_check" CHECK ("versionNumber" >= 1 AND length(trim("filename")) > 0 AND length(trim("contentType")) > 0 AND "sizeBytes" >= 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*' AND ("pageCount" IS NULL OR "pageCount" >= 1))
    )`,
    `CREATE TABLE "LiteratureCreator" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "nameMode" TEXT NOT NULL,
      "givenName" TEXT NOT NULL DEFAULT '',
      "familyName" TEXT NOT NULL DEFAULT '',
      "literalName" TEXT NOT NULL DEFAULT '',
      "normalizedName" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "LiteratureCreator_shape_check" CHECK (length(trim("normalizedName")) > 0 AND (("nameMode" = 'person' AND length(trim("literalName")) = 0 AND (length(trim("givenName")) > 0 OR length(trim("familyName")) > 0)) OR ("nameMode" = 'organization' AND length(trim("literalName")) > 0 AND length(trim("givenName")) = 0 AND length(trim("familyName")) = 0)))
    )`,
    `CREATE TABLE "LiteratureItemCreator" (
      "itemId" TEXT NOT NULL,
      "creatorId" TEXT NOT NULL,
      "creatorType" TEXT NOT NULL,
      "ordinal" INTEGER NOT NULL,
      PRIMARY KEY ("itemId", "ordinal"),
      CONSTRAINT "LiteratureItemCreator_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureItemCreator_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "LiteratureCreator" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "LiteratureItemCreator_shape_check" CHECK (length(trim("creatorType")) > 0 AND "ordinal" >= 0)
    )`,
    `CREATE TABLE "LiteratureIdentifier" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "itemId" TEXT NOT NULL,
      "scheme" TEXT NOT NULL,
      "rawValue" TEXT NOT NULL,
      "normalizedValue" TEXT NOT NULL,
      "isPrimary" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LiteratureIdentifier_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureIdentifier_shape_check" CHECK (length(trim("scheme")) > 0 AND length(trim("rawValue")) > 0 AND length(trim("normalizedValue")) > 0)
    )`,
    `CREATE TABLE "LiteratureInboxCandidate" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "dedupeKey" TEXT NOT NULL,
      "state" TEXT NOT NULL DEFAULT 'pending',
      "itemType" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "abstract" TEXT NOT NULL DEFAULT '',
      "issuedYear" INTEGER,
      "candidateJson" TEXT NOT NULL,
      "metadataChecksum" TEXT NOT NULL,
      "origin" TEXT NOT NULL,
      "sourceProjectId" TEXT,
      "sourceSessionId" TEXT,
      "acceptedItemId" TEXT,
      "settledAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "LiteratureInboxCandidate_acceptedItemId_fkey" FOREIGN KEY ("acceptedItemId") REFERENCES "LiteratureItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "LiteratureInboxCandidate_shape_check" CHECK (length(trim("dedupeKey")) > 0 AND length(trim("itemType")) > 0 AND length(trim("title")) > 0 AND length(trim("metadataChecksum")) > 0 AND length(trim("origin")) > 0 AND ("issuedYear" IS NULL OR "issuedYear" BETWEEN 0 AND 9999) AND json_valid("candidateJson") AND json_type("candidateJson") = 'object'),
      CONSTRAINT "LiteratureInboxCandidate_lifecycle_check" CHECK (("state" = 'pending' AND "acceptedItemId" IS NULL AND "settledAt" IS NULL) OR ("state" = 'accepted' AND "acceptedItemId" IS NOT NULL AND "settledAt" IS NOT NULL) OR ("state" = 'dismissed' AND "acceptedItemId" IS NULL AND "settledAt" IS NOT NULL))
    )`,
    `CREATE TABLE "LiteratureSourceRecord" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "itemId" TEXT,
      "inboxCandidateId" TEXT,
      "provider" TEXT NOT NULL,
      "externalId" TEXT,
      "sourceUrl" TEXT,
      "rawMetadataJson" TEXT NOT NULL,
      "metadataChecksum" TEXT NOT NULL,
      "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LiteratureSourceRecord_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureSourceRecord_inboxCandidateId_fkey" FOREIGN KEY ("inboxCandidateId") REFERENCES "LiteratureInboxCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureSourceRecord_shape_check" CHECK ((("itemId" IS NOT NULL AND "inboxCandidateId" IS NULL) OR ("itemId" IS NULL AND "inboxCandidateId" IS NOT NULL)) AND length(trim("provider")) > 0 AND ("externalId" IS NULL OR length(trim("externalId")) > 0) AND ("sourceUrl" IS NULL OR length(trim("sourceUrl")) > 0) AND length(trim("metadataChecksum")) > 0 AND json_valid("rawMetadataJson") AND json_type("rawMetadataJson") = 'object')
    )`,
    `CREATE TABLE "LiteratureCollection" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "nameKey" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "parentId" TEXT,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "LiteratureCollection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LiteratureCollection" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "LiteratureCollection_shape_check" CHECK (length(trim("name")) > 0 AND length(trim("nameKey")) > 0 AND ("parentId" IS NULL OR "parentId" <> "id") AND "sortOrder" >= 0)
    )`,
    `CREATE TABLE "LiteratureCollectionItem" (
      "collectionId" TEXT NOT NULL,
      "itemId" TEXT NOT NULL,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("collectionId", "itemId"),
      CONSTRAINT "LiteratureCollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "LiteratureCollection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureCollectionItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureCollectionItem_sortOrder_check" CHECK ("sortOrder" >= 0)
    )`,
    `CREATE TABLE "ProjectLiterature" (
      "projectId" TEXT NOT NULL,
      "itemId" TEXT NOT NULL,
      "source" TEXT NOT NULL,
      "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("projectId", "itemId"),
      CONSTRAINT "ProjectLiterature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ProjectLiterature_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ProjectLiterature_source_check" CHECK (length(trim("source")) > 0)
    )`,
    `CREATE TABLE "ArtifactLiteratureManifest" (
      "artifactVersionId" TEXT NOT NULL PRIMARY KEY,
      "schemaVersion" INTEGER NOT NULL DEFAULT 1,
      "styleId" TEXT NOT NULL,
      "locale" TEXT NOT NULL,
      "manifestJson" TEXT NOT NULL,
      "checksum" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ArtifactLiteratureManifest_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ArtifactLiteratureManifest_shape_check" CHECK ("schemaVersion" = 1 AND length(trim("styleId")) > 0 AND length(trim("locale")) > 0 AND json_valid("manifestJson") AND json_type("manifestJson") = 'object' AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
    )`,
    `CREATE TABLE "LiteratureInboxPdf" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "candidateId" TEXT NOT NULL,
      "contentBlobId" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "sizeBytes" BIGINT NOT NULL,
      "checksum" TEXT NOT NULL,
      "pageCount" INTEGER NOT NULL,
      "sourceUrl" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LiteratureInboxPdf_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "LiteratureInboxCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "LiteratureInboxPdf_contentBlobId_fkey" FOREIGN KEY ("contentBlobId") REFERENCES "ContentBlob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
    )`,
    ...literatureFoundationIndexes.map(({ sql }) => sql)
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'ContentBlob' },
    { kind: 'column-exists', version: 1, table: 'UploadVersion', column: 'contentBlobId' },
    { kind: 'column-exists', version: 1, table: 'ArtifactVersion', column: 'contentBlobId' },
    { kind: 'table-exists', version: 1, table: 'LiteratureItem' },
    { kind: 'table-exists', version: 1, table: 'LiteratureAttachment' },
    { kind: 'table-exists', version: 1, table: 'LiteratureAttachmentVersion' },
    { kind: 'table-exists', version: 1, table: 'LiteratureInboxCandidate' },
    { kind: 'table-exists', version: 1, table: 'LiteratureInboxPdf' },
    { kind: 'indexes-absent', version: 1, names: ['LiteratureIdentifier_identity_key'] },
    { kind: 'table-exists', version: 1, table: 'LiteratureCollection' },
    { kind: 'column-exists', version: 1, table: 'LiteratureCollection', column: 'description' },
    { kind: 'table-exists', version: 1, table: 'ProjectLiterature' },
    { kind: 'table-exists', version: 1, table: 'ArtifactLiteratureManifest' },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ArtifactLiteratureManifest',
          constraints: [
            {
              name: 'ArtifactLiteratureManifest_shape_check',
              expression: `"schemaVersion" = 1 AND length(trim("styleId")) > 0 AND length(trim("locale")) > 0 AND json_valid("manifestJson") AND json_type("manifestJson") = 'object' AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*'`
            }
          ]
        }
      ]
    },
    { kind: 'indexes-exist', version: 1, indexes: literatureFoundationIndexes }
  ] as const
}

// A pre-ledger database can already contain this table when 0025 rebuilds ArtifactVersion.
// SQLite then rewrites the child FK to 0025's temporary table name, so recreate only this
// projection after the managed-file rebuild while preserving its stored manifests.
const artifactLiteratureManifestReferenceRepairStatements = [
  `ALTER TABLE "ArtifactLiteratureManifest" RENAME TO "_0026_old_ArtifactLiteratureManifest";`,
  `CREATE TABLE "ArtifactLiteratureManifest" (
    "artifactVersionId" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "styleId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "manifestJson" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArtifactLiteratureManifest_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactLiteratureManifest_shape_check" CHECK ("schemaVersion" = 1 AND length(trim("styleId")) > 0 AND length(trim("locale")) > 0 AND json_valid("manifestJson") AND json_type("manifestJson") = 'object' AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
  );`,
  `INSERT INTO "ArtifactLiteratureManifest" SELECT * FROM "_0026_old_ArtifactLiteratureManifest";`,
  `DROP TABLE "_0026_old_ArtifactLiteratureManifest";`
] as const

export {
  artifactLiteratureManifestReferenceRepairStatements,
  literatureContentBlobBackfillStatements,
  literatureFoundationMigration
}
