import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { UserSkillRepository, parseUserSkillId, toSlug } from './user-skill-repository'
import type { FetchLike } from './github-import'

const makeStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), 'user-skills-'))

// Fake GitHub fetch returning one skill dir (SKILL.md + run.py) with controllable contents.
const fakeFetch =
  (skillMd: string): FetchLike =>
  async (url: string) => {
    if (url.includes('/contents/')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            type: 'file',
            name: 'SKILL.md',
            path: 'pack/foo/SKILL.md',
            download_url: 'https://raw/SKILL.md'
          }
        ],
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    const bytes = new TextEncoder().encode(skillMd)
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
  }

const SKILL_URL = 'https://github.com/acme/skills/tree/main/pack/foo'

// CRC-32 + a minimal valid zip builder so importFromZip is tested against a real byte layout.
const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    let c = (crc ^ buffer[i]) & 0xff
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

const buildZip = (inputs: { path: string; content: Buffer }[]): Buffer => {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const input of inputs) {
    const nameBuf = Buffer.from(input.path, 'utf8')
    const stored = deflateRawSync(input.content)
    const crc = crc32(input.content)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(input.content.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    locals.push(local, stored)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(input.content.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)
    offset += local.length + stored.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(inputs.length, 8)
  eocd.writeUInt16LE(inputs.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

describe('toSlug / parseUserSkillId', () => {
  it('builds safe slugs and round-trips ids', () => {
    expect(toSlug('My Skill!')).toBe('my-skill')
    expect(parseUserSkillId('personal-my-skill')).toEqual({ source: 'personal', slug: 'my-skill' })
    expect(parseUserSkillId('imported-foo')).toEqual({ source: 'imported', slug: 'foo' })
    expect(parseUserSkillId('citation-formatter')).toBeNull()
  })
})

describe('UserSkillRepository', () => {
  it('creates, lists, reads, updates, and deletes a personal skill', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const id = await repo.createPersonal({
      name: 'My Skill',
      description: 'Does a thing.',
      body: '# My Skill\nBody.'
    })
    expect(id).toBe('personal-my-skill')

    const listed = await repo.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: 'personal-my-skill',
      name: 'My Skill',
      description: 'Does a thing.',
      source: 'personal'
    })

    expect(await repo.body(id)).toContain('# My Skill')

    await repo.updatePersonal(id, {
      name: 'My Skill',
      description: 'Updated.',
      body: '# Updated body'
    })
    expect((await repo.list())[0].description).toBe('Updated.')
    expect(await repo.body(id)).toContain('# Updated body')

    await repo.delete(id)
    expect(await repo.list()).toEqual([])
  })

  it('gives colliding names a numeric suffix', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const first = await repo.createPersonal({ name: 'Dup', description: 'a', body: 'x' })
    const second = await repo.createPersonal({ name: 'Dup', description: 'b', body: 'y' })

    expect(first).toBe('personal-dup')
    expect(second).toBe('personal-dup-2')
  })

  it('writes reference files under references/ when creating a skill', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)

    await repo.createPersonal({
      name: 'With Refs',
      description: 'd',
      body: 'x',
      references: [{ path: 'helper.py', dataBase64: Buffer.from('print(1)').toString('base64') }]
    })

    const written = await readFile(
      join(storage, 'skills', 'personal', 'with-refs', 'references', 'helper.py'),
      'utf8'
    )
    expect(written).toBe('print(1)')
  })

  it('honors an explicit slug and rejects collisions, reserved prefixes, and invalid ids', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const id = await repo.createPersonal({ name: 'Anything', description: 'd', body: 'x' }, 'my-id')
    expect(id).toBe('personal-my-id')

    // Colliding with the just-created slug is rejected (no silent suffix).
    await expect(
      repo.createPersonal({ name: 'Other', description: 'd', body: 'y' }, 'my-id')
    ).rejects.toThrow(/already exists/)

    // Reserved built-in / MCP prefixes are rejected.
    await expect(
      repo.createPersonal({ name: 'x', description: 'd', body: 'x' }, 'os-thing')
    ).rejects.toThrow(/os- or mcp-/)
    await expect(
      repo.createPersonal({ name: 'x', description: 'd', body: 'x' }, 'mcp-thing')
    ).rejects.toThrow(/os- or mcp-/)

    // Unsafe characters are rejected.
    await expect(
      repo.createPersonal({ name: 'x', description: 'd', body: 'x' }, 'Bad ID')
    ).rejects.toThrow(/lowercase/)
  })

  it('reconciles references on update: keeps untouched, adds new, deletes removed', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const b64 = (text: string): string => Buffer.from(text).toString('base64')

    const id = await repo.createPersonal({
      name: 'Refs',
      description: 'd',
      body: 'x',
      references: [
        { path: 'keep.py', dataBase64: b64('keep') },
        { path: 'drop.py', dataBase64: b64('drop') }
      ]
    })

    await repo.updatePersonal(id, {
      name: 'Refs',
      description: 'd',
      body: 'x',
      references: [
        { path: 'keep.py' }, // no base64 -> keep the existing file
        { path: 'new.py', dataBase64: b64('new') } // new file
      ]
    })

    const dir = join(storage, 'skills', 'personal', 'refs', 'references')
    expect(await readFile(join(dir, 'keep.py'), 'utf8')).toBe('keep')
    expect(await readFile(join(dir, 'new.py'), 'utf8')).toBe('new')
    await expect(readFile(join(dir, 'drop.py'), 'utf8')).rejects.toThrow()
  })

  it('lists imported skills with their frontmatter metadata', async () => {
    const storage = await makeStorage()
    const dir = join(storage, 'skills', 'imported', 'foo')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      ['---', 'name: Foo', 'description: An imported skill.', 'license: MIT', '---', 'body'].join(
        '\n'
      ),
      'utf8'
    )

    const listed = await new UserSkillRepository(storage).list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: 'imported-foo',
      name: 'Foo',
      source: 'imported',
      license: 'MIT'
    })
  })

  it('returns empty when no user skills exist', async () => {
    expect(await new UserSkillRepository(await makeStorage()).list()).toEqual([])
  })

  it('imports a .zip bundle (SKILL.md + files) and dedups an identical re-import', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const zip = buildZip([
      { path: 'my-bundle/SKILL.md', content: Buffer.from('---\nname: Bundled\n---\nbody') },
      { path: 'my-bundle/scripts/run.py', content: Buffer.from('print(1)') }
    ])

    const first = await repo.importFromZip(zip)
    expect(first).toEqual({ status: 'imported', id: 'imported-bundled' })

    const listed = await repo.list()
    expect(listed.map((skill) => skill.id)).toEqual(['imported-bundled'])
    expect(listed[0]).toMatchObject({ name: 'Bundled', source: 'imported' })

    // The wrapper prefix is stripped, so the script lands under references-free root path.
    const script = await readFile(
      join(storage, 'skills', 'imported', 'bundled', 'scripts', 'run.py'),
      'utf8'
    )
    expect(script).toBe('print(1)')

    // Same content re-imported is a no-op.
    expect((await repo.importFromZip(zip)).status).toBe('unchanged')
  })

  it('rejects a zip bundle without a SKILL.md', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([{ path: 'readme.md', content: Buffer.from('nope') }])
    await expect(repo.importFromZip(zip)).rejects.toThrow(/SKILL\.md/)
    await expect(repo.previewZip(zip)).rejects.toThrow(/SKILL\.md/)
  })

  it('discovers one root for a root-level SKILL.md (subPath "")', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: Root\ndescription: d\n---\nbody') },
      { path: 'run.py', content: Buffer.from('print(1)') }
    ])

    const previews = await repo.previewZip(zip)
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({ name: 'Root', subPath: '' })
    // Root files stay as-is (SKILL.md already at the root).
    expect(previews[0].files).toEqual(['SKILL.md', 'run.py'].sort())
  })

  it('discovers two roots for sibling one-level skill dirs', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'skill-a/SKILL.md', content: Buffer.from('---\nname: A\ndescription: d\n---\nx') },
      { path: 'skill-a/run.py', content: Buffer.from('a') },
      { path: 'skill-b/SKILL.md', content: Buffer.from('---\nname: B\ndescription: d\n---\ny') }
    ])

    const previews = await repo.previewZip(zip)
    expect(previews.map((p) => p.subPath)).toEqual(['skill-a', 'skill-b'])
    // Each root's files are re-based so SKILL.md sits at its root.
    expect(previews[0].files).toEqual(['SKILL.md', 'run.py'].sort())
    expect(previews[1].files).toEqual(['SKILL.md'])
  })

  it('discovers a two-level wrapped skill root (subPath "wrapper/skill-a")', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      {
        path: 'wrapper/skill-a/SKILL.md',
        content: Buffer.from('---\nname: Wrapped\ndescription: d\n---\nx')
      },
      { path: 'wrapper/skill-a/scripts/run.py', content: Buffer.from('a') }
    ])

    const previews = await repo.previewZip(zip)
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({ name: 'Wrapped', subPath: 'wrapper/skill-a' })
    expect(previews[0].files).toEqual(['SKILL.md', 'scripts/run.py'].sort())
  })

  it('drops a SKILL.md nested under a shallower skill root (counts it once)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'a/SKILL.md', content: Buffer.from('---\nname: A\ndescription: d\n---\nx') },
      { path: 'a/b/SKILL.md', content: Buffer.from('---\nname: B\ndescription: d\n---\ny') }
    ])

    const previews = await repo.previewZip(zip)
    expect(previews.map((p) => p.subPath)).toEqual(['a'])
    // The nested SKILL.md is just a file of skill "a", re-based under it.
    expect(previews[0].files).toEqual(['SKILL.md', 'b/SKILL.md'].sort())
  })

  it('imports only the selected sub-skill from a multi-root bundle via subPath', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const zip = buildZip([
      {
        path: 'skill-a/SKILL.md',
        content: Buffer.from('---\nname: Alpha\ndescription: d\n---\nx')
      },
      { path: 'skill-a/run.py', content: Buffer.from('alpha') },
      { path: 'skill-b/SKILL.md', content: Buffer.from('---\nname: Beta\ndescription: d\n---\ny') }
    ])

    const outcome = await repo.importFromZip(zip, { subPath: 'skill-b' })
    expect(outcome).toEqual({ status: 'imported', id: 'imported-beta' })
    // Only Beta was written; Alpha's file must not exist under the imported skill.
    expect((await repo.list()).map((s) => s.id)).toEqual(['imported-beta'])
    const body = await readFile(join(storage, 'skills', 'imported', 'beta', 'SKILL.md'), 'utf8')
    expect(body).toContain('name: Beta')
  })

  it('throws on a multi-root bundle when no subPath is given', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'skill-a/SKILL.md', content: Buffer.from('---\nname: A\ndescription: d\n---\nx') },
      { path: 'skill-b/SKILL.md', content: Buffer.from('---\nname: B\ndescription: d\n---\ny') }
    ])
    await expect(repo.importFromZip(zip)).rejects.toThrow(/multiple skills/)
  })

  it('throws when the requested subPath matches no root', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'skill-a/SKILL.md', content: Buffer.from('---\nname: A\ndescription: d\n---\nx') }
    ])
    await expect(repo.importFromZip(zip, { subPath: 'nope' })).rejects.toThrow(/no skill at/)
  })

  it('still imports a single-root bundle with no subPath (backward compat)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'only/SKILL.md', content: Buffer.from('---\nname: Only\ndescription: d\n---\nx') }
    ])
    expect(await repo.importFromZip(zip)).toEqual({ status: 'imported', id: 'imported-only' })
  })

  it('previews a bundle without writing it, and flags an identical already-imported bundle', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      {
        path: 'my-bundle/SKILL.md',
        content: Buffer.from('---\nname: Bundled\ndescription: A test bundle.\n---\nbody')
      },
      { path: 'my-bundle/scripts/run.py', content: Buffer.from('print(1)') }
    ])

    const preview = await repo.previewZip(zip)
    expect(preview).toEqual([
      {
        name: 'Bundled',
        description: 'A test bundle.',
        files: ['SKILL.md', 'scripts/run.py'],
        alreadyImported: false,
        replaceableId: undefined,
        subPath: 'my-bundle'
      }
    ])
    // Preview writes nothing.
    expect(await repo.list()).toHaveLength(0)

    // After importing, the same bundle previews as already imported.
    await repo.importFromZip(zip)
    expect((await repo.previewZip(zip))[0].alreadyImported).toBe(true)
  })

  it('rejects a preview whose SKILL.md has no name', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'thing/SKILL.md', content: Buffer.from('---\ndescription: no name here\n---\nbody') }
    ])
    await expect(repo.previewZip(zip)).rejects.toThrow(/needs a name/)
  })

  // Builds a one-file bundle named "Shared" with a controllable body (so signatures differ).
  const sharedBundle = (body: string): Buffer =>
    buildZip([
      {
        path: 'pack/SKILL.md',
        content: Buffer.from(`---\nname: Shared\ndescription: d\n---\n${body}`)
      }
    ])

  it('offers a replace target when the name matches one imported skill of different content', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    await repo.importFromZip(sharedBundle('v1'))

    // Same name, different content -> replaceable in place.
    const [preview] = await repo.previewZip(sharedBundle('v2'))
    expect(preview.alreadyImported).toBe(false)
    expect(preview.replaceableId).toBe('imported-shared')

    // The exact same bundle -> a no-op, so no replace is offered.
    const [exact] = await repo.previewZip(sharedBundle('v1'))
    expect(exact.alreadyImported).toBe(true)
    expect(exact.replaceableId).toBeUndefined()
  })

  it('does not offer a replace target when two imported skills share the name (ambiguous)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    await repo.importFromZip(sharedBundle('v1'))
    await repo.importFromZip(sharedBundle('v2')) // second "Shared" -> imported-shared-2

    const [preview] = await repo.previewZip(sharedBundle('v3'))
    expect(preview.replaceableId).toBeUndefined()
  })

  it('replaces an imported skill in place when given a replaceId', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const first = await repo.importFromZip(sharedBundle('original'))
    expect(first).toEqual({ status: 'imported', id: 'imported-shared' })

    const replaced = await repo.importFromZip(sharedBundle('updated'), {
      replaceId: 'imported-shared'
    })
    expect(replaced).toEqual({ status: 'updated', id: 'imported-shared' })

    // No new skill was created and the file content was overwritten in place.
    expect((await repo.list()).map((skill) => skill.id)).toEqual(['imported-shared'])
    expect(await repo.body('imported-shared')).toContain('updated')
  })

  it('rejects a replaceId that is not an existing imported skill', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    await expect(
      repo.importFromZip(sharedBundle('x'), { replaceId: 'imported-missing' })
    ).rejects.toThrow(/Not an imported skill to replace/)
    await expect(
      repo.importFromZip(sharedBundle('x'), { replaceId: 'personal-shared' })
    ).rejects.toThrow(/Not an imported skill to replace/)
  })

  it('imports a GitHub skill and dedups re-imports (unchanged vs updated)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const skillMd = ['---', 'name: Foo', 'description: An imported skill.', '---', 'body'].join(
      '\n'
    )

    const first = await repo.importFromGitHub(SKILL_URL, fakeFetch(skillMd))
    expect(first).toEqual({ status: 'imported', id: 'imported-foo' })

    const listed = await repo.list()
    expect(listed.map((skill) => skill.id)).toEqual(['imported-foo'])
    expect(listed[0]).toMatchObject({ name: 'Foo', source: 'imported' })

    // Re-importing the same URL with identical content is a no-op.
    const again = await repo.importFromGitHub(SKILL_URL, fakeFetch(skillMd))
    expect(again.status).toBe('unchanged')

    // Re-importing after upstream changed refreshes in place.
    const changed = ['---', 'name: Foo', 'description: Now updated.', '---', 'body2'].join('\n')
    const updated = await repo.importFromGitHub(SKILL_URL, fakeFetch(changed))
    expect(updated).toEqual({ status: 'updated', id: 'imported-foo' })
    expect((await repo.list())[0].description).toBe('Now updated.')
  })

  it('rejects an import whose file path escapes the skill dir before any file is written', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    // A malicious GitHub response: a second file whose path climbs out of the skill directory once
    // the root prefix is stripped (`pack/foo/../../../evil` -> `../../../evil`).
    const escaping: FetchLike = async (url: string) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s'
            },
            {
              type: 'file',
              name: 'evil',
              path: 'pack/foo/../../../evil',
              download_url: 'https://raw/e'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      const bytes = new TextEncoder().encode('---\nname: Foo\n---\nx')
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }

    await expect(repo.importFromGitHub(SKILL_URL, escaping)).rejects.toThrow(
      /outside its directory/
    )
    // The gate runs before any disk write, so no partial skill is left behind.
    expect(await repo.list()).toEqual([])
  })

  it('leaves the existing skill intact when a replace import fails the containment gate', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const good = ['---', 'name: Foo', 'description: original.', '---', 'original body'].join('\n')
    const first = await repo.importFromGitHub(SKILL_URL, fakeFetch(good))
    expect(first.status).toBe('imported')

    // Same URL, changed content (so it takes the in-place replace path that deletes first), but now
    // carrying an escaping file. The destructive rm must not run.
    const badReplace: FetchLike = async (url: string) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s2'
            },
            {
              type: 'file',
              name: 'evil',
              path: 'pack/foo/../../../evil',
              download_url: 'https://raw/e2'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      const bytes = new TextEncoder().encode('changed')
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }

    await expect(repo.importFromGitHub(SKILL_URL, badReplace)).rejects.toThrow(
      /outside its directory/
    )
    // The original import survived the failed replace.
    expect(await repo.body(first.id)).toContain('original body')
  })

  it('rejects an ancestor/descendant path conflict, leaving the prior skill intact', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const good = ['---', 'name: Foo', 'description: original.', '---', 'original body'].join('\n')
    const first = await repo.importFromGitHub(SKILL_URL, fakeFetch(good))
    expect(first.status).toBe('imported')

    // `a` (a file) and `a/b` (needs `a` to be a directory) can't both exist. Before the staging fix
    // this failed mid-write and left the old body half-overwritten; now it must be rejected up front.
    const conflicting: FetchLike = async (url: string) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s'
            },
            { type: 'file', name: 'a', path: 'pack/foo/a', download_url: 'https://raw/a' },
            { type: 'file', name: 'b', path: 'pack/foo/a/b', download_url: 'https://raw/ab' }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      const bytes = new TextEncoder().encode('changed')
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }

    await expect(repo.importFromGitHub(SKILL_URL, conflicting)).rejects.toThrow(
      /Conflicting file and directory/
    )
    expect(await repo.body(first.id)).toContain('original body')
  })

  it('rejects an import that contains duplicate file paths', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const duplicate: FetchLike = async (url: string) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s'
            },
            { type: 'file', name: 'dup', path: 'pack/foo/dup.txt', download_url: 'https://raw/d1' },
            { type: 'file', name: 'dup', path: 'pack/foo/dup.txt', download_url: 'https://raw/d2' }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      const bytes = new TextEncoder().encode('x')
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }

    await expect(repo.importFromGitHub(SKILL_URL, duplicate)).rejects.toThrow(/Duplicate file path/)
    expect(await repo.list()).toEqual([])
  })

  it('marks scanned candidates already imported by URL or by same name', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const skillMd = ['---', 'name: Foo', 'description: An imported skill.', '---', 'body'].join(
      '\n'
    )

    // Import a skill from a "foo" folder, then scan a DIFFERENT repo that also has a "foo" folder.
    await repo.importFromGitHub(SKILL_URL, fakeFetch(skillMd))

    const treeFetch: FetchLike = async (url: string) => {
      const body = url.includes('/git/trees/')
        ? {
            tree: [
              { path: 'pack/foo/SKILL.md', type: 'blob' },
              { path: 'bar/SKILL.md', type: 'blob' }
            ]
          }
        : { default_branch: 'main' }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    const scanned = await repo.scanRepo('other/repo', treeFetch)
    const byName = Object.fromEntries(scanned.map((skill) => [skill.name, skill.alreadyImported]))
    // "foo" is a different repo (different URL) but the same folder name -> flagged by name.
    expect(byName).toEqual({ foo: true, bar: false })
  })

  it('writes frontmatter that the reader can parse back', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const id = await repo.createPersonal({ name: 'Round Trip', description: 'desc', body: 'hello' })

    const raw = await readFile(
      join(storage, 'skills', 'personal', 'round-trip', 'SKILL.md'),
      'utf8'
    )
    expect(raw).toContain('name: Round Trip')
    expect(raw).toContain('description: desc')
    expect(await repo.body(id)).toBe('hello')
  })
})
