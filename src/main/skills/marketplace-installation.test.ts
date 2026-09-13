import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { UserSkillRepository } from './user-skill-repository'
import {
  marketplaceContentDigest,
  marketplaceReceiptSchema,
  verifyMarketplacePackage,
  type MarketplacePackage
} from './marketplace-package'
import { sha256 } from './marketplace-protocol'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function repository(): Promise<{ repo: UserSkillRepository; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-install-test-'))
  roots.push(root)
  return { root, repo: new UserSkillRepository(root) }
}
function pkg(version = '1.0.0'): MarketplacePackage {
  const files = [
    {
      relativePath: 'SKILL.md',
      content: Buffer.from(`---\nname: example\ndescription: Example\n---\nVersion ${version}\n`)
    },
    { relativePath: 'references/参考.md', content: Buffer.from(`reference ${version}`) }
  ]
  return {
    files,
    receipt: {
      marketplace: 'openscience-skills',
      id: 'example',
      version,
      snapshotId: 'a'.repeat(64),
      revision: 'b'.repeat(64),
      descriptorSha256: sha256(Buffer.from(version)),
      artifactSha256: 'c'.repeat(64),
      contentSha256: marketplaceContentDigest(files)
    }
  }
}
function zip(files = pkg().files): Buffer {
  return Buffer.from(
    zipSync(Object.fromEntries(files.map((file) => [`example/${file.relativePath}`, file.content])))
  )
}
function verify(bytes: Buffer, files = pkg().files): ReturnType<typeof verifyMarketplacePackage> {
  return verifyMarketplacePackage(
    bytes,
    'example',
    { sha256: sha256(bytes), bytes: bytes.length, skill_path: 'example' },
    {
      contentSha256: marketplaceContentDigest(files),
      fileCount: files.length,
      uncompressedBytes: files.reduce((sum, file) => sum + file.content.length, 0)
    }
  )
}

describe('Marketplace package boundary', () => {
  it('accepts revision receipts and rejects obsolete Git-commit snapshot identities', () => {
    const receipt = { ...pkg().receipt, installedContentSha256: 'd'.repeat(64) }
    expect(marketplaceReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(
      marketplaceReceiptSchema.safeParse({ ...receipt, snapshotId: 'a'.repeat(40) }).success
    ).toBe(false)
  })
  it('verifies publisher-format ZIP and the exact Unicode path/content digest', () => {
    expect(verify(zip())).toEqual(pkg().files)
    expect(marketplaceContentDigest([...pkg().files].reverse())).toBe(pkg().receipt.contentSha256)
    expect(() => verify(zip(), pkg('1.1.0').files)).toThrow()
  })
  it.each([
    '../outside',
    'CON.txt',
    'dir\\file',
    'references/../bad',
    '.source.json',
    'SKILL.MD',
    'references/skill.md',
    'references'
  ])('rejects unsafe, reserved and colliding entries: %s', (path) => {
    const files = [...pkg().files, { relativePath: path, content: Buffer.from('bad') }]
    expect(() => verify(zip(files), files)).toThrow()
  })
  it.each(['link', 'encryption', 'huge-size', 'local-name', 'truncated-central', 'trailing-data'])(
    'rejects %s without extracting partial content',
    (fault) => {
      let bytes = zip()
      const end = bytes.length - 22
      const central = bytes.readUInt32LE(end + 16)
      if (fault === 'link') {
        bytes.writeUInt16LE(3 << 8, central + 4)
        bytes.writeUInt32LE((0o120777 * 65536) >>> 0, central + 38)
      }
      if (fault === 'encryption') bytes.writeUInt16LE(1, central + 8)
      if (fault === 'huge-size') bytes.writeUInt32LE(0x7fffffff, central + 24)
      if (fault === 'local-name') bytes[30] = 0
      if (fault === 'truncated-central') bytes.writeUInt16LE(1234, end + 10)
      if (fault === 'trailing-data') bytes = Buffer.concat([bytes, Buffer.from('trailing')])
      expect(() => verify(bytes)).toThrow()
    }
  )
})

describe('Marketplace installation transactions', () => {
  it.each(['1.0.0-beta.1', '2.0.0-rc.1+build'])(
    'rejects prerelease %s without writing or offering an update',
    async (version) => {
      const { repo } = await repository()
      await expect(repo.installMarketplace(pkg(version), null, [])).rejects.toThrow()
      expect(await repo.list()).toEqual([])
      await repo.installMarketplace(pkg('1.0.0'), null, [])
      expect(await repo.marketplaceInstallation('example', version, [])).toMatchObject({
        kind: 'installed',
        version: '1.0.0',
        canUpdate: false
      })
      await expect(repo.installMarketplace(pkg(version), '1.0.0', [])).rejects.toThrow()
      expect(await repo.marketplaceInstallation('example', '1.0.0', [])).toMatchObject({
        kind: 'installed',
        version: '1.0.0',
        canUpdate: false
      })
    }
  )

  it('accepts stable build metadata containing hyphens', async () => {
    const { repo } = await repository()
    await expect(repo.installMarketplace(pkg('1.0.0+build-1'), null, [])).resolves.toMatchObject({
      status: 'imported'
    })
    expect(await repo.marketplaceInstallation('example', '1.1.0+build-2', [])).toMatchObject({
      canUpdate: true
    })
  })

  it.each(['a'.repeat(65), 'os-example', 'mcp-example'])(
    'rejects names that cannot appear in the local Skill catalog: %s',
    async (id) => {
      const { repo, root } = await repository()
      const invalid = pkg()
      invalid.receipt.id = id
      expect(await repo.marketplaceInstallation(id, '1.0.0', [])).toEqual({ kind: 'conflict' })
      await expect(repo.installMarketplace(invalid, null, [])).rejects.toThrow('local name rules')
      await expect(readFile(join(root, 'skills', 'imported', id, '.source.json'))).rejects.toThrow()
      expect(await repo.list()).toEqual([])
    }
  )
  it('installs, survives restart, updates in place and deduplicates repeated delivery', async () => {
    const { repo, root } = await repository()
    expect(await repo.marketplaceInstallation('example', '1.0.0', [])).toEqual({
      kind: 'not-installed'
    })
    expect(await repo.installMarketplace(pkg(), null, [])).toEqual({
      id: 'imported-example',
      status: 'imported'
    })
    const restarted = new UserSkillRepository(root)
    expect(await restarted.marketplaceInstallation('example', '1.1.0', [])).toEqual({
      kind: 'installed',
      version: '1.0.0',
      canUpdate: true
    })
    expect(await restarted.installMarketplace(pkg('1.1.0'), '1.0.0', [])).toEqual({
      id: 'imported-example',
      status: 'updated'
    })
    expect(await restarted.installMarketplace(pkg('1.1.0'), '1.0.0', [])).toEqual({
      id: 'imported-example',
      status: 'unchanged'
    })
    expect((await restarted.list()).map((skill) => skill.id)).toEqual(['imported-example'])
    const receipt = JSON.parse(
      await readFile(join(root, 'skills/imported/example/.source.json'), 'utf8')
    )
    expect(receipt.marketplace).toMatchObject({
      version: '1.1.0',
      installedContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    await restarted.delete('imported-example')
    expect(await restarted.marketplaceInstallation('example', '1.1.0', [])).toEqual({
      kind: 'not-installed'
    })
  })
  it('does not adopt old ZIP imports or overwrite personal/bundled names', async () => {
    const { repo } = await repository()
    await repo.importFromZip(zip())
    expect(await repo.marketplaceInstallation('example', '1.0.0', [])).toEqual({ kind: 'conflict' })
    await expect(repo.installMarketplace(pkg(), null, [])).rejects.toThrow('conflict')
    await repo.delete('imported-example')
    await expect(repo.installMarketplace(pkg(), null, ['example'])).rejects.toThrow('conflict')
    await repo.createPersonal({ name: 'example', description: 'Mine', body: 'keep me' })
    await expect(repo.installMarketplace(pkg(), null, [])).rejects.toThrow('conflict')
    expect(await repo.body('personal-example')).toContain('keep me')
  })
  it('protects local edits, stale update confirmations, downgrades and mutable releases', async () => {
    const { repo, root } = await repository()
    await repo.installMarketplace(pkg('2.0.0'), null, [])
    await expect(repo.installMarketplace(pkg('1.0.0'), '2.0.0', [])).rejects.toThrow('conflict')
    await expect(repo.installMarketplace(pkg('3.0.0'), '1.0.0', [])).rejects.toThrow('conflict')
    const changed = pkg('2.0.0')
    changed.receipt.descriptorSha256 = 'f'.repeat(64)
    await expect(repo.installMarketplace(changed, '2.0.0', [])).rejects.toThrow('conflict')
    const path = join(root, 'skills/imported/example/references/参考.md')
    await writeFile(path, 'my local edits')
    expect(await repo.marketplaceInstallation('example', '3.0.0', [])).toEqual({ kind: 'conflict' })
    await expect(repo.installMarketplace(pkg('3.0.0'), '2.0.0', [])).rejects.toThrow('conflict')
    expect(await readFile(path, 'utf8')).toBe('my local edits')
  })
  it('serializes concurrent updates and rolls back package and receipt together on promotion failure', async () => {
    const { repo, root } = await repository()
    await repo.installMarketplace(pkg(), null, [])
    const competing = await Promise.all([
      repo.installMarketplace(pkg('1.1.0'), '1.0.0', []),
      repo.installMarketplace(pkg('1.1.0'), '1.0.0', [])
    ])
    expect(competing.map((result) => result.status).sort()).toEqual(['unchanged', 'updated'])
    const failing = new UserSkillRepository(root, undefined, async () => {
      throw new Error('promotion rejected')
    })
    await expect(failing.installMarketplace(pkg('1.2.0'), '1.1.0', [])).rejects.toThrow(
      'promotion rejected'
    )
    expect(await repo.marketplaceInstallation('example', '1.2.0', [])).toEqual({
      kind: 'installed',
      version: '1.1.0',
      canUpdate: true
    })
    expect(await repo.body('imported-example')).toContain('1.1.0')
  })
  it('drops Marketplace provenance on explicit ordinary replacement and refuses corrupt receipts', async () => {
    const { repo, root } = await repository()
    await repo.installMarketplace(pkg(), null, [])
    await repo.importFromZip(zip(pkg('1.1.0').files), { replaceId: 'imported-example' })
    expect(await repo.marketplaceInstallation('example', '1.1.0', [])).toEqual({ kind: 'conflict' })
    await writeFile(
      join(root, 'skills/imported/example/.source.json'),
      JSON.stringify({ marketplace: { id: 'example', version: '1.0.0' } })
    )
    await expect(repo.installMarketplace(pkg('1.1.0'), '1.0.0', [])).rejects.toThrow('conflict')
  })
})
