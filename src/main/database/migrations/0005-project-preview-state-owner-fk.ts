/* Immutable 0005 migration snapshot. Do not regenerate after release. */

// ProjectPreviewState used to be an unowned derived table, so a delayed renderer save could recreate
// it after Project deletion. Rebuild the table with an owner FK, preserve valid rows, and deliberately
// discard legacy rows whose Project is already absent.
const projectPreviewStateOwnerFkMigration = {
  id: '0005_project_preview_state_owner_fk',
  statements: [
    `ALTER TABLE "ProjectPreviewState" RENAME TO "_ProjectPreviewState_without_project_fk"`,
    `CREATE TABLE "ProjectPreviewState" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "panelState" TEXT NOT NULL,
    "activeItemId" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectPreviewState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
    `INSERT INTO "ProjectPreviewState" ("projectId", "panelState", "activeItemId", "items", "updatedAt")
SELECT "preview"."projectId", "preview"."panelState", "preview"."activeItemId", "preview"."items", "preview"."updatedAt"
FROM "_ProjectPreviewState_without_project_fk" AS "preview"
INNER JOIN "Project" AS "project" ON "project"."id" = "preview"."projectId"`,
    `DROP TABLE "_ProjectPreviewState_without_project_fk"`
  ] as const,
  verifiers: [
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ProjectPreviewState',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    }
  ] as const
}

export { projectPreviewStateOwnerFkMigration }
