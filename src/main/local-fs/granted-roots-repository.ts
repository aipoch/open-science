import type { GrantedLocalRoot as PrismaGrantedLocalRoot, PrismaClient } from '@prisma/client'

import type { GrantedLocalRoot, GrantedLocalRootAccess } from '../../shared/local-fs'

// Only the grantedLocalRoot delegate is needed; typing to this subset keeps the repository
// testable against any client that provides it (aligns with the compute and projects repositories).
type GrantedLocalRootClient = Pick<PrismaClient, 'grantedLocalRoot'>

// Resolves the Prisma client on demand so a failed schema-ensure initialization is not held
// forever (see projects/repository.ts).
type GrantedLocalRootClientProvider = () => Promise<GrantedLocalRootClient>

// The legacy settings.json slice, read once for the one-time import into the GrantedLocalRoot
// table. Mirrors the StoredComputeGrant → PermissionGrant migration lifecycle (see
// compute/permission-grant-adapter.ts): settings.json remains the retry source until the complete
// batch has landed in the DB, and only then is the field removed.
type LegacyGrantedLocalRootsStore = {
  getGrantedLocalRoots: () => Promise<GrantedLocalRoot[]>
  clearGrantedLocalRoots: () => Promise<void>
}

// Narrows the free-text access column back to the domain union, defaulting unknown values to 'ro'
// so a corrupt row degrades to the least-privileged level rather than crashing.
const asAccess = (value: string): GrantedLocalRootAccess => (value === 'rw' ? 'rw' : 'ro')

const toRoot = (row: PrismaGrantedLocalRoot): GrantedLocalRoot => ({
  id: row.id,
  path: row.path,
  name: row.name,
  access: asAccess(row.access)
})

// Owns GrantedLocalRoot reads/writes ("Grant folder access"). The client is resolved lazily per
// call so schema-ensure failures can recover. The optional legacy store triggers a one-time
// settings.json import on first use; without it (tests, fresh installs after cleanup) the
// repository is a plain table wrapper.
class GrantedLocalRootsRepository {
  private migration: Promise<void> | undefined

  constructor(
    private readonly getClient: GrantedLocalRootClientProvider,
    private readonly legacy?: LegacyGrantedLocalRootsStore
  ) {}

  // Imports any legacy settings.json granted roots into the DB (path-unique upsert: existing rows
  // win, so a retried import never clobbers an access change made after a partial earlier run),
  // then removes the settings field. Runs at most once per process; a failure clears the cached
  // promise so the next call retries, and settings.json is left intact as the retry source.
  private migrateLegacy(): Promise<void> {
    const legacy = this.legacy
    if (!legacy) return Promise.resolve()
    if (this.migration) return this.migration

    const attempt = (async () => {
      const roots = await legacy.getGrantedLocalRoots()
      // Sanitize drops empty arrays from settings.json, so an empty list means the field is
      // already gone — skip the clear to avoid a pointless settings write on every first use.
      if (roots.length === 0) return

      const client = await this.getClient()
      for (const root of roots) {
        await client.grantedLocalRoot.upsert({
          where: { path: root.path },
          create: { id: root.id, path: root.path, name: root.name, access: root.access },
          update: {}
        })
      }
      // Clear only after every source row has a successful upsert; the additive import is
      // idempotent, so a failure simply replays on the next call.
      await legacy.clearGrantedLocalRoots()
    })()
    this.migration = attempt
    void attempt.catch(() => {
      if (this.migration === attempt) this.migration = undefined
    })
    return attempt
  }

  // Lists granted roots in grant order (oldest first), matching the settings-list ordering the
  // renderer was built against.
  async list(): Promise<GrantedLocalRoot[]> {
    await this.migrateLegacy()
    const client = await this.getClient()
    const rows = await client.grantedLocalRoot.findMany({ orderBy: { createdAt: 'asc' } })

    return rows.map(toRoot)
  }

  // Inserts a new grant, or updates the access of the existing row with the same resolved path
  // (grant de-dupe: re-granting keeps the original id). Returns the stored row.
  async upsertByPath(root: GrantedLocalRoot): Promise<GrantedLocalRoot> {
    await this.migrateLegacy()
    const client = await this.getClient()
    const row = await client.grantedLocalRoot.upsert({
      where: { path: root.path },
      create: { id: root.id, path: root.path, name: root.name, access: root.access },
      update: { access: root.access, name: root.name }
    })

    return toRoot(row)
  }

  // Changes the access level of one granted root. Callers verify the id exists first (the service
  // throws a readable error for unknown ids).
  async setAccess(id: string, access: GrantedLocalRootAccess): Promise<void> {
    await this.migrateLegacy()
    const client = await this.getClient()

    await client.grantedLocalRoot.update({ where: { id }, data: { access } })
  }

  // Revokes one granted root. deleteMany keeps a repeated remove of the same id a no-op.
  async remove(id: string): Promise<void> {
    await this.migrateLegacy()
    const client = await this.getClient()

    await client.grantedLocalRoot.deleteMany({ where: { id } })
  }
}

export { GrantedLocalRootsRepository, toRoot }
export type { GrantedLocalRootClient, GrantedLocalRootClientProvider, LegacyGrantedLocalRootsStore }
