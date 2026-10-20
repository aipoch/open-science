import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { UserSkillRepository } from './user-skill-repository'
import type { SkillReleasePackage, SkillReleasePolicy } from './skill-release'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const receipt = z
  .object({
    id: z.string(),
    version: z.string().regex(/^edition-\d+$/),
    contentSha256: z.string(),
    descriptorSha256: z.string(),
    publisherNote: z.string()
  })
  .strict()
// A fictional source has its own wire digest, version grammar and receipt metadata.
const policy: SkillReleasePolicy = {
  metadataKey: 'local-releases',
  diffLabel: 'Local release',
  parseRelease: (v) => receipt.parse(v),
  parseReceipt: (v) => receipt.extend({ installedContentSha256: z.string() }).parse(v),
  contentDigest: (files) =>
    createHash('sha256')
      .update(
        JSON.stringify(files.map((f) => [f.relativePath, f.content.toString('base64')]).sort())
      )
      .digest('hex'),
  isNewerVersion: (a, b) => Number(a.slice(8)) > Number(b.slice(8))
}
function release(edition = 1): SkillReleasePackage {
  const files = [
    {
      relativePath: 'SKILL.md',
      content: Buffer.from(`---\nname: example\ndescription: Example\n---\nEdition ${edition}`)
    }
  ]
  return {
    files,
    receipt: {
      id: 'example',
      version: `edition-${edition}`,
      contentSha256: policy.contentDigest(files),
      descriptorSha256: `descriptor-${edition}`,
      publisherNote: 'local source'
    }
  }
}
async function fixture(): Promise<{ root: string; repo: UserSkillRepository }> {
  const root = await mkdtemp(join(tmpdir(), 'skill-release-'))
  roots.push(root)
  return { root, repo: new UserSkillRepository(root) }
}
it('installs an independent source, preserves opaque receipt fields and recovers its identity after restart', async () => {
  const { root, repo } = await fixture()
  expect(await repo.installRelease(policy, release(), null, [])).toEqual({
    id: 'imported-example',
    status: 'imported'
  })
  const saved = JSON.parse(
    await readFile(join(root, 'skills/imported/example/.source.json'), 'utf8')
  )
  expect(saved[policy.metadataKey]).toEqual({
    ...release().receipt,
    installedContentSha256: policy.contentDigest([
      {
        relativePath: 'SKILL.md',
        content: await readFile(join(root, 'skills/imported/example/SKILL.md'))
      }
    ])
  })
  const restarted = new UserSkillRepository(root)
  expect(await restarted.releaseInstallation(policy, 'example', 'edition-2', [])).toEqual({
    kind: 'installed',
    version: 'edition-1',
    canUpdate: true
  })
  expect(await restarted.installRelease(policy, release(), null, [])).toEqual({
    id: 'imported-example',
    status: 'unchanged'
  })
  expect(await restarted.installRelease(policy, release(2), 'edition-1', [])).toEqual({
    id: 'imported-example',
    status: 'updated'
  })
})
it('keeps release policy out of ordinary editing and rejects collisions and reserved metadata namespaces', async () => {
  const { repo } = await fixture()
  await repo.createPersonal({ name: 'example', description: 'Personal', body: 'Keep' })
  await expect(repo.installRelease(policy, release(), null, [])).rejects.toThrow()
  for (const metadataKey of ['url', 'signature', 'agentHome', '__proto__', '../source'])
    await expect(
      repo.installRelease({ ...policy, metadataKey }, release(), null, [])
    ).rejects.toThrow('metadata key')
  expect(await repo.body('personal-example')).toContain('Keep')
})
it('does not accept a receipt or confirmation issued for another source', async () => {
  const { repo } = await fixture()
  await repo.installRelease(policy, release(), null, [])
  const preview = await repo.previewReleaseUpdate(policy, release(2), [])
  const other = { ...policy, metadataKey: 'another-source' }
  expect(await repo.releaseInstallation(other, 'example', 'edition-2', [])).toMatchObject({
    kind: 'conflict'
  })
  await expect(
    repo.installRelease(other, release(2), 'edition-1', [], preview.token)
  ).rejects.toThrow()
})
it('rejects local edits, stale versions, mutable releases and malformed source receipts', async () => {
  const { root, repo } = await fixture()
  await repo.installRelease(policy, release(), null, [])
  await expect(repo.installRelease(policy, release(2), 'edition-0', [])).rejects.toThrow()
  const mutable = release()
  mutable.receipt.descriptorSha256 = 'changed'
  await expect(repo.installRelease(policy, mutable, 'edition-1', [])).rejects.toThrow()
  await writeFile(join(root, 'skills/imported/example/SKILL.md'), 'Local edit')
  await expect(repo.installRelease(policy, release(2), 'edition-1', [])).rejects.toThrow()
  await writeFile(
    join(root, 'skills/imported/example/.source.json'),
    JSON.stringify({ [policy.metadataKey]: { id: 'example' } })
  )
  await expect(repo.installRelease(policy, release(2), 'edition-1', [])).rejects.toThrow()
})
it('revalidates source bytes and usage revision while holding the caller lock', async () => {
  const { repo } = await fixture()
  await repo.installRelease(policy, release(), null, [])
  let usage = 'before'
  let locked = false
  const preview = await repo.previewReleaseUpdate(policy, release(2), [], async () => usage)
  await expect(
    repo.installRelease(
      policy,
      release(2),
      'edition-1',
      [],
      preview.token,
      async () => {
        expect(locked).toBe(true)
        return usage
      },
      async (write) => {
        locked = true
        usage = 'after'
        try {
          return await write()
        } finally {
          locked = false
        }
      }
    )
  ).rejects.toThrow()
  const next = await repo.previewReleaseUpdate(policy, release(2), [])
  const changed = release(2)
  changed.files[0].content = Buffer.from('Changed after preview')
  await expect(repo.installRelease(policy, changed, 'edition-1', [], next.token)).rejects.toThrow()
  expect(await repo.body('imported-example')).toContain('Edition 1')
})
it('serializes concurrent deliveries and rolls back package and receipt together', async () => {
  const { root, repo } = await fixture()
  await repo.installRelease(policy, release(), null, [])
  const failing = new UserSkillRepository(root, {
    validatePromotion: async () => {
      throw new Error('reject promotion')
    }
  })
  await expect(failing.installRelease(policy, release(2), 'edition-1', [])).rejects.toThrow(
    'restored'
  )
  expect(await repo.releaseInstallation(policy, 'example', 'edition-2', [])).toMatchObject({
    version: 'edition-1'
  })
  const results = await Promise.all(
    [repo, new UserSkillRepository(root)].map((r) =>
      r.installRelease(policy, release(2), 'edition-1', [])
    )
  )
  expect(results.map((r) => r.status).sort()).toEqual(['unchanged', 'updated'])
})

it('confirms an in-place personal replacement and preserves shared ownership through restart', async () => {
  const { root, repo } = await fixture()
  await repo.createPersonal({ name: 'example', description: 'Shared', body: 'original' })
  const dir = join(root, 'skills/personal/example')
  const metadata = {
    id: 'personal-example',
    version: 'edition-0',
    contentHash: 'd'.repeat(64),
    standalone: false,
    ownerIds: ['owner-one', 'owner-two']
  }
  await writeFile(join(dir, '.specialist-package.json'), JSON.stringify(metadata))
  await writeFile(join(dir, 'old.txt'), 'keep until confirmation')
  const usage = async (_id: string, owners: readonly string[]): Promise<string> => {
    expect(owners).toEqual(metadata.ownerIds)
    return 'stable-usage'
  }
  const preview = await repo.previewReleaseUpdate(policy, release(), [], usage)
  expect(preview.removed).toEqual(['old.txt'])
  expect(preview.differences.some((d) => d.patch?.includes('Local release'))).toBe(true)
  expect(await readFile(join(dir, 'old.txt'), 'utf8')).toContain('confirmation')
  expect(await repo.installRelease(policy, release(), null, [], preview.token, usage)).toEqual({
    id: 'personal-example',
    status: 'updated'
  })
  expect(await repo.installRelease(policy, release(), null, [], preview.token, usage)).toEqual({
    id: 'personal-example',
    status: 'unchanged'
  })
  expect(JSON.parse(await readFile(join(dir, '.specialist-package.json'), 'utf8'))).toMatchObject({
    ...metadata,
    version: 'edition-1',
    contentHash: expect.not.stringContaining('dddddddd')
  })
  expect(
    await new UserSkillRepository(root).releaseInstallation(policy, 'example', 'edition-2', [])
  ).toMatchObject({
    kind: 'installed',
    localSkillId: 'personal-example',
    version: 'edition-1',
    protected: true
  })
})
it('invalidates a reviewed replacement after ownership changes or preview expiration', async () => {
  const { root, repo } = await fixture()
  await repo.createPersonal({ name: 'example', description: 'Personal', body: 'original' })
  const preview = await repo.previewReleaseUpdate(policy, release(), [])
  await writeFile(
    join(root, 'skills/personal/example/.specialist-package.json'),
    JSON.stringify({
      id: 'personal-example',
      version: 'edition-0',
      contentHash: 'd'.repeat(64),
      standalone: false,
      ownerIds: ['new-owner']
    })
  )
  await expect(
    repo.installRelease(policy, release(), null, [], preview.token)
  ).rejects.toMatchObject({ reason: 'version-changed' })
  const fresh = await repo.previewReleaseUpdate(policy, release(), [])
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
  try {
    await expect(
      repo.installRelease(policy, release(), null, [], fresh.token)
    ).rejects.toMatchObject({ reason: 'version-changed' })
  } finally {
    clock.mockRestore()
  }
})
it('rolls back confirmed personal replacement without leaving a new source receipt', async () => {
  const { root, repo } = await fixture()
  await repo.createPersonal({ name: 'example', description: 'Personal', body: 'original' })
  const failing = new UserSkillRepository(root, {
    validatePromotion: async () => {
      throw new Error('reject replacement')
    }
  })
  const preview = await failing.previewReleaseUpdate(policy, release(), [])
  await expect(failing.installRelease(policy, release(), null, [], preview.token)).rejects.toThrow(
    'restored'
  )
  expect(await repo.body('personal-example')).toContain('original')
  await expect(readFile(join(root, 'skills/personal/example/.source.json'))).rejects.toThrow()
})
