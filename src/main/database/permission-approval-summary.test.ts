import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import {
  capabilityFromLegacyCategory,
  commandPrefixPermissionCategory
} from '../permission-grants/capability'
import { migrateApplicationDatabase } from './migration-service'

it('upgrades historical permissions without inferring descriptions or changing authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'permission-summary-migration-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    const capability = capabilityFromLegacyCategory(
      commandPrefixPermissionCategory(['git', 'status'])!
    )!
    const grant = await registry.remember({ capability, scope: { kind: 'global' } })
    await client.$executeRawUnsafe('ALTER TABLE "PermissionGrant" DROP COLUMN "approvalSummary"')
    await client.$executeRawUnsafe('DROP TABLE IF EXISTS "LiteratureMetadataCommitReceipt"')
    await client.$executeRawUnsafe(
      "DELETE FROM \"_open_science_migrations\" WHERE id IN ('0032_permission_approval_summary', '0033_compute_job_harvest_retry', '0034_background_result_delivery', '0035_literature_pdf_provenance', '0036_content_verification_observation', '0037_literature_inbox_integrity', '0038_literature_search_text', '0039_literature_metadata_commit_receipt')"
    )
    const before = await client.$queryRawUnsafe(
      'SELECT id, capabilityKind, capabilityKey, qualifierMode, qualifierValue, scopeKind, projectId, sessionId, fingerprint, revision, createdAt FROM "PermissionGrant"'
    )
    await expect(
      migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    ).resolves.toMatchObject({
      applied: [
        '0032_permission_approval_summary',
        '0033_compute_job_harvest_retry',
        '0034_background_result_delivery',
        '0035_literature_pdf_provenance',
        '0036_content_verification_observation',
        '0037_literature_inbox_integrity',
        '0038_literature_search_text',
        '0039_literature_metadata_commit_receipt'
      ]
    })
    const after = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT * FROM "PermissionGrant"'
    )
    expect(
      after.map(({ approvalSummary, ...row }) => {
        expect(approvalSummary).toBeNull()
        return row
      })
    ).toEqual(before)
    const reopened = await createPermissionGrantRegistry({ getClient: async () => client })
    expect((await reopened.resolve(capability, {}))?.grant.id).toBe(grant.id)
    // Remembering an existing grant must not silently backfill or reapprove it.
    expect(await reopened.remember({ capability, scope: { kind: 'global' } })).not.toHaveProperty(
      'approvalSummary'
    )
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
