/* Immutable 0003 migration snapshot. Do not regenerate after release. */

// Granted local roots ("Grant folder access"): pure-additive table plus the unique path index the
// Prisma model expects. IF NOT EXISTS keeps both statements safe for installations where a
// pre-migration build already created them via the legacy ensure-schema path.
const grantedLocalRootsMigration = {
  id: '0003_granted_local_roots',
  statements: [
    `CREATE TABLE IF NOT EXISTS "GrantedLocalRoot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GrantedLocalRoot_path_key" ON "GrantedLocalRoot"("path")`
  ] as const,
  verifiers: [
    {
      kind: 'table-exists',
      version: 1,
      table: 'GrantedLocalRoot'
    }
  ] as const
}

export { grantedLocalRootsMigration }
