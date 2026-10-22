// Conversation cache receipts survive provider/context restoration and application restarts.
const authorizedDirectoryDiscoveryMigration = {
  id: '0051_authorized_directory_discovery',
  statements: [
    `CREATE TABLE IF NOT EXISTS "AuthorizedDirectoryDiscovery" (
    "sessionId" TEXT NOT NULL PRIMARY KEY,
    "initialRevision" TEXT NOT NULL,
    "queriedRevision" TEXT,
    "notifiedRevision" TEXT
);`
  ],
  verifiers: [{ kind: 'table-exists', version: 1, table: 'AuthorizedDirectoryDiscovery' }]
} as const

export { authorizedDirectoryDiscoveryMigration }
