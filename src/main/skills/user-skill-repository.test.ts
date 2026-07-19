import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'

import {
  UserSkillRepository,
  parseUserSkillId,
  toSlug,
  frontmatterBlock
} from './user-skill-repository'
import { parseFrontmatter } from './frontmatter'
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

describe('frontmatterBlock', () => {
  // Reads the block back with a conformant YAML parser and asserts each field is byte-identical to
  // the input — the property that actually matters (Claude Code parses SKILL.md with real YAML).
  const roundTrip = (name: string, description: string): { name: unknown; description: unknown } =>
    loadYaml(frontmatterBlock({ name, description })) as { name: unknown; description: unknown }

  it('round-trips ordinary values as strings', () => {
    const out = roundTrip('My Skill', 'Does a thing.')
    expect(out).toEqual({ name: 'My Skill', description: 'Does a thing.' })
  })

  it('keeps YAML-typed tokens as strings (never bool/null/number)', () => {
    for (const value of ['true', 'false', 'null', 'yes', 'no', '~', '123', '3.14', '+1', '0x1f']) {
      const out = roundTrip('X', value)
      expect(out.description).toBe(value)
      expect(typeof out.description).toBe('string')
    }
  })

  it('losslessly round-trips trailing newlines and leading spaces', () => {
    for (const value of [
      'line one\n', // trailing newline preserved
      'a\n\nb\n\n', // multiple trailing newlines
      '  indented', // leading spaces
      '  keep\n    me  \n' // leading + trailing whitespace across lines
    ]) {
      expect(roundTrip('X', value).description).toBe(value)
    }
  })

  it('round-trips values that would otherwise break the frontmatter (--- fence, key: line)', () => {
    expect(roundTrip('X', 'a\n---\nb').description).toBe('a\n---\nb')
    expect(roundTrip('X', 'not: a-key').description).toBe('not: a-key')
  })

  it('round-trips an empty value as an empty string (not null)', () => {
    expect(roundTrip('X', '').description).toBe('')
  })

  it('round-trips losslessly through the app frontmatter reader too', () => {
    // Not just a standard parser — the app's own parseFrontmatter must recover the exact value,
    // including a trailing newline and leading spaces (it no longer trims).
    for (const value of ['line one\n', '  indented', 'plain text', 'true', '2026-07-17']) {
      const doc = `---\n${frontmatterBlock({ name: 'X', description: value })}---\nbody`
      expect(parseFrontmatter(doc).fields.description).toBe(value)
    }
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

  it('round-trips a description with newlines and YAML fences without corrupting the body', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    // A description that, interpolated raw, would prematurely close the frontmatter (`---`) and inject
    // a bogus field (`not: a-key`). It must survive intact and leave the body untouched.
    const description = 'First line\n---\nnot: a-key\nSecond line'
    const id = await repo.createPersonal({
      name: 'Tricky',
      description,
      body: '# Real body\nkeep me'
    })

    const listed = await repo.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].description).toBe(description)

    const body = await repo.body(id)
    expect(body).toContain('# Real body')
    expect(body).toContain('keep me')
    // The injected fence/field must not have leaked into the body.
    expect(body).not.toContain('not: a-key')
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
    // Preview no longer throws: it returns nothing importable so the UI can say "no skills found".
    expect(await repo.previewZip(zip)).toEqual({ previews: [], skipped: [] })
  })

  it('discovers one root for a root-level SKILL.md (subPath "")', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: Root\ndescription: d\n---\nbody') },
      { path: 'run.py', content: Buffer.from('print(1)') }
    ])

    const { previews } = await repo.previewZip(zip)
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

    const { previews } = await repo.previewZip(zip)
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

    const { previews } = await repo.previewZip(zip)
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

    const { previews } = await repo.previewZip(zip)
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
    expect(preview).toEqual({
      previews: [
        {
          name: 'Bundled',
          description: 'A test bundle.',
          files: ['SKILL.md', 'scripts/run.py'],
          alreadyImported: false,
          replaceableId: undefined,
          subPath: 'my-bundle'
        }
      ],
      skipped: []
    })
    // Preview writes nothing.
    expect(await repo.list()).toHaveLength(0)

    // After importing, the same bundle previews as already imported.
    await repo.importFromZip(zip)
    expect((await repo.previewZip(zip)).previews[0].alreadyImported).toBe(true)
  })

  it('skips a preview whose SKILL.md has no name (instead of failing the bundle)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'thing/SKILL.md', content: Buffer.from('---\ndescription: no name here\n---\nbody') }
    ])
    const { previews, skipped } = await repo.previewZip(zip)
    expect(previews).toHaveLength(0)
    expect(skipped).toEqual([{ source: 'thing', reason: 'SKILL.md has no name' }])
  })

  // A bundle of nested .zip bundles (one archive per skill) — the "export all my skills" shape.
  const innerBundle = (name: string, dir = name.toLowerCase()): Buffer =>
    buildZip([
      {
        path: `${dir}/SKILL.md`,
        content: Buffer.from(`---\nname: ${name}\ndescription: d\n---\nbody`)
      }
    ])

  it('discovers a skill in each nested .zip of a zip-of-zips, namespaced by archive name', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const outer = buildZip([
      { path: 'alpha-111.zip', content: innerBundle('Alpha') },
      { path: 'beta-222.zip', content: innerBundle('Beta') }
    ])

    const { previews, skipped } = await repo.previewZip(outer)
    expect(skipped).toEqual([])
    expect(previews.map((p) => p.name)).toEqual(['Alpha', 'Beta'])
    // Each inner root's subPath is namespaced by the archive base name (+ inner dir).
    expect(previews.map((p) => p.subPath)).toEqual(['alpha-111.zip/alpha', 'beta-222.zip/beta'])
  })

  it('namespaces a root-level SKILL.md inside a nested archive by the archive name alone', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const inner = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: Gamma\ndescription: d\n---\nx') }
    ])
    const outer = buildZip([{ path: 'gamma-333.zip', content: inner }])

    const { previews } = await repo.previewZip(outer)
    expect(previews).toEqual([expect.objectContaining({ name: 'Gamma', subPath: 'gamma-333.zip' })])
  })

  it('keeps the good nested skills and skips a nested archive with no SKILL.md', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const junk = buildZip([{ path: 'readme.md', content: Buffer.from('nope') }])
    const outer = buildZip([
      { path: 'good.zip', content: innerBundle('Alpha') },
      { path: 'bad.zip', content: junk }
    ])

    const { previews, skipped } = await repo.previewZip(outer)
    expect(previews.map((p) => p.name)).toEqual(['Alpha'])
    expect(skipped).toEqual([{ source: 'bad.zip', reason: 'no SKILL.md found' }])
  })

  it('skips a nested entry that is not a valid ZIP, importing the rest', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const outer = buildZip([
      { path: 'good.zip', content: innerBundle('Alpha') },
      { path: 'corrupt.zip', content: Buffer.from('not a zip at all') }
    ])

    const { previews, skipped } = await repo.previewZip(outer)
    expect(previews.map((p) => p.name)).toEqual(['Alpha'])
    expect(skipped.map((s) => s.source)).toEqual(['corrupt.zip'])
    expect(skipped[0].reason).toMatch(/valid ZIP/i)
  })

  it('batch-imports every selected nested skill in one pass', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const outer = buildZip([
      { path: 'alpha-111.zip', content: innerBundle('Alpha') },
      { path: 'beta-222.zip', content: innerBundle('Beta') }
    ])

    const { previews } = await repo.previewZip(outer)
    const results = await repo.importFromZipBatch(
      outer,
      previews.map((p) => ({ subPath: p.subPath }))
    )
    expect(results.map((r) => r.outcome?.status)).toEqual(['imported', 'imported'])
    expect((await repo.list()).map((s) => s.name).sort()).toEqual(['Alpha', 'Beta'])
  })

  it('reports a per-item error in a batch without aborting the other items', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const outer = buildZip([{ path: 'alpha-111.zip', content: innerBundle('Alpha') }])

    const results = await repo.importFromZipBatch(outer, [
      { subPath: 'alpha-111.zip/alpha' },
      { subPath: 'does/not/exist' }
    ])
    expect(results[0].outcome?.status).toBe('imported')
    expect(results[1].error).toMatch(/no skill at/)
    expect((await repo.list()).map((s) => s.name)).toEqual(['Alpha'])
  })

  it('skips a loose single-skill root whose file exceeds the per-skill cap', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // 6 MiB file: within the bundle-wide walk cap but over the 5 MiB per-skill file cap.
    const zip = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: Big\ndescription: d\n---\nx') },
      { path: 'blob.bin', content: Buffer.alloc(6 * 1024 * 1024, 7) }
    ])

    const { previews, skipped } = await repo.previewZip(zip)
    expect(previews).toHaveLength(0)
    expect(skipped[0].reason).toMatch(/over 5 MB/)
  })

  it('skips a loose root whose oversized file the lenient walk dropped (no partial import)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // 9 MiB file exceeds the nested-archive/entry cap, so the outer walk drops it; the root that owns
    // it must be skipped rather than imported without it.
    const zip = buildZip([
      { path: 'pack/SKILL.md', content: Buffer.from('---\nname: Pack\ndescription: d\n---\nx') },
      { path: 'pack/huge.bin', content: Buffer.alloc(9 * 1024 * 1024, 7) }
    ])

    const { previews, skipped } = await repo.previewZip(zip)
    expect(previews).toHaveLength(0)
    expect(skipped.some((s) => s.source === 'pack' && /too large/.test(s.reason))).toBe(true)
  })

  it('does not alias a loose dir and a nested archive that share a stem', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const nested = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: FromArchive\ndescription: d\n---\ny') }
    ])
    const outer = buildZip([
      {
        path: 'alpha/SKILL.md',
        content: Buffer.from('---\nname: FromDir\ndescription: d\n---\nx')
      },
      { path: 'alpha.zip', content: nested }
    ])

    const { previews } = await repo.previewZip(outer)
    // Both skills survive under distinct subPaths — selecting one can't import the other.
    expect(previews.map((p) => p.subPath)).toEqual(['alpha', 'alpha.zip'])
    expect(previews.map((p) => p.name).sort()).toEqual(['FromArchive', 'FromDir'])
    expect(new Set(previews.map((p) => p.subPath)).size).toBe(2)
  })

  it('folds a .zip living under a loose skill root into that skill, not a separate one', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'tool/SKILL.md', content: Buffer.from('---\nname: Tool\ndescription: d\n---\nx') },
      { path: 'tool/references/data.zip', content: Buffer.from('opaque archive bytes') }
    ])

    const { previews, skipped } = await repo.previewZip(zip)
    // One skill (Tool) that keeps its bundled archive as a resource — no spurious separate skill and
    // no "no SKILL.md" skip for the inner archive.
    expect(previews).toHaveLength(1)
    expect(previews[0].name).toBe('Tool')
    expect(previews[0].files).toContain('references/data.zip')
    expect(skipped).toEqual([])
  })

  it('imports the bundled-archive resource to disk as part of the skill', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const zip = buildZip([
      { path: 'tool/SKILL.md', content: Buffer.from('---\nname: Tool\ndescription: d\n---\nx') },
      { path: 'tool/references/data.zip', content: Buffer.from('opaque archive bytes') }
    ])

    expect((await repo.importFromZip(zip)).status).toBe('imported')
    const written = await readFile(
      join(storage, 'skills', 'imported', 'tool', 'references', 'data.zip'),
      'utf8'
    )
    expect(written).toBe('opaque archive bytes')
  })

  it('parses a CRLF-authored SKILL.md the same on preview and import', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // A bundle authored on Windows: every line ends with \r\n.
    const skill = ['---', 'name: Winreader', 'description: A CRLF bundle.', '---', 'body'].join(
      '\r\n'
    )
    const zip = buildZip([{ path: 'win/SKILL.md', content: Buffer.from(skill) }])

    const [preview] = (await repo.previewZip(zip)).previews
    expect(preview.name).toBe('Winreader')
    expect(preview.description).toBe('A CRLF bundle.')

    // Import must derive the slug from the name, not fall back to 'imported-skill'.
    expect(await repo.importFromZip(zip)).toEqual({ status: 'imported', id: 'imported-winreader' })
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
    const [preview] = (await repo.previewZip(sharedBundle('v2'))).previews
    expect(preview.alreadyImported).toBe(false)
    expect(preview.replaceableId).toBe('imported-shared')

    // The exact same bundle -> a no-op, so no replace is offered.
    const [exact] = (await repo.previewZip(sharedBundle('v1'))).previews
    expect(exact.alreadyImported).toBe(true)
    expect(exact.replaceableId).toBeUndefined()
  })

  it('does not offer a replace target when two imported skills share the name (ambiguous)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    await repo.importFromZip(sharedBundle('v1'))
    await repo.importFromZip(sharedBundle('v2')) // second "Shared" -> imported-shared-2

    const [preview] = (await repo.previewZip(sharedBundle('v3'))).previews
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

  it('rejects an import that includes the reserved .source.json manifest path', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const withManifest: FetchLike = async (url: string) => {
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
              name: '.source.json',
              path: 'pack/foo/.source.json',
              download_url: 'https://raw/m'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      const bytes = new TextEncoder().encode('{}')
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }

    await expect(repo.importFromGitHub(SKILL_URL, withManifest)).rejects.toThrow(/reserved/)
    expect(await repo.list()).toEqual([])
  })

  it('rejects a filesystem-equivalent path collision on case-insensitive volumes', async () => {
    const storage = await makeStorage()

    // Only meaningful where the filesystem folds case (macOS/Windows default). On a case-sensitive
    // volume SKILL.md and skill.md are distinct files and coexist, so there is nothing to reject.
    const probe = join(storage, 'CaseProbe')
    await writeFile(probe, 'x')
    const caseInsensitive = await stat(join(storage, 'caseprobe')).then(
      () => true,
      () => false
    )
    await rm(probe, { force: true })
    if (!caseInsensitive) return

    const repo = new UserSkillRepository(storage)
    const collide: FetchLike = async (url: string) => {
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
              name: 'skill.md',
              path: 'pack/foo/skill.md',
              download_url: 'https://raw/s2'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      const bytes = new TextEncoder().encode('---\nname: Foo\n---\nbody')
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }

    await expect(repo.importFromGitHub(SKILL_URL, collide)).rejects.toThrow(
      /[Cc]ollision|Conflicting/
    )
    expect(await repo.list()).toEqual([])
  })

  it('recovers the previous skill after a crash between the two swap renames', async () => {
    const root = await makeStorage()
    const repo = new UserSkillRepository(root)
    const first = await repo.importFromGitHub(SKILL_URL, fakeFetch('---\nname: Foo\n---\nold body'))
    expect(first.id).toBe('imported-foo')

    // Reproduce the durable on-disk state if the process died after `rename(live, backup)` and before
    // `rename(staging, live)`: the live dir is gone and only a hidden backup remains.
    const importedDir = join(root, 'skills', 'imported')
    await rename(join(importedDir, 'foo'), join(importedDir, '.foo.backup-simulated-crash'))

    // A fresh instance (simulating a restart) must restore the previous skill on its first use.
    const restarted = new UserSkillRepository(root)
    expect(await restarted.body(first.id)).toContain('old body')
    expect((await restarted.list()).map((skill) => skill.id)).toEqual(['imported-foo'])
  })

  it('ignores a leftover backup dir when the live skill is present (no bogus ids)', async () => {
    const root = await makeStorage()
    const repo = new UserSkillRepository(root)
    await repo.importFromGitHub(SKILL_URL, fakeFetch('---\nname: Foo\n---\nbody'))

    // A stray backup left next to a healthy live dir (e.g. a crash after the swap, before cleanup).
    const importedDir = join(root, 'skills', 'imported')
    await mkdir(join(importedDir, '.foo.backup-stale'), { recursive: true })
    await writeFile(join(importedDir, '.foo.backup-stale', 'SKILL.md'), '---\nname: Foo\n---\nx')

    // list() recovers (removes) the leftover and never surfaces it as a skill id.
    const listed = await new UserSkillRepository(root).list()
    expect(listed.map((skill) => skill.id)).toEqual(['imported-foo'])
  })

  it('does not resurrect a crashed imported skill after the user deletes it', async () => {
    const root = await makeStorage()
    const repo = new UserSkillRepository(root)
    const first = await repo.importFromGitHub(SKILL_URL, fakeFetch('---\nname: Foo\n---\nold body'))

    // Crash state: live dir gone, only a hidden backup remains.
    const importedDir = join(root, 'skills', 'imported')
    await rename(join(importedDir, 'foo'), join(importedDir, '.foo.backup-simulated-crash'))

    // delete() must recover-then-remove, so a later list() can't resurrect the deleted skill.
    const restarted = new UserSkillRepository(root)
    await restarted.delete(first.id)
    expect(await restarted.list()).toEqual([])
    expect(await new UserSkillRepository(root).list()).toEqual([])
  })

  it('discards a stale staged (.import-) dir on the next operation', async () => {
    const root = await makeStorage()
    const importedDir = join(root, 'skills', 'imported')
    await mkdir(join(importedDir, '.foo.import-stale'), { recursive: true })
    await writeFile(join(importedDir, '.foo.import-stale', 'SKILL.md'), '---\nname: Foo\n---\nx')

    const listed = await new UserSkillRepository(root).list()
    expect(listed).toEqual([])
    // The uncommitted staging dir was cleaned up, not left lingering.
    expect(await readdir(importedDir)).toEqual([])
  })

  it('serializes concurrent fresh imports so they get distinct slugs (no clobber)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // Two different source URLs whose folder name slugifies to the same base ("foo"). Run at once:
    // slug allocation + swap share one critical section, so the second is suffixed rather than
    // overwriting the first (which would leave both reporting imported-foo).
    const [a, b] = await Promise.all([
      repo.importFromGitHub(
        'https://github.com/acme/one/tree/main/pack/foo',
        fakeFetch('---\nname: Foo\n---\nfrom one')
      ),
      repo.importFromGitHub(
        'https://github.com/acme/two/tree/main/pack/foo',
        fakeFetch('---\nname: Foo\n---\nfrom two')
      )
    ])

    expect([a.id, b.id].sort()).toEqual(['imported-foo', 'imported-foo-2'])
    expect((await repo.list()).map((skill) => skill.id).sort()).toEqual([
      'imported-foo',
      'imported-foo-2'
    ])
  })

  it('restores the newest backup when several exist for one slug', async () => {
    const root = await makeStorage()
    const importedDir = join(root, 'skills', 'imported')
    // Two backups for "foo" with different (sortable) generations; the live dir is gone.
    await mkdir(join(importedDir, '.foo.backup-000000000000001-old'), { recursive: true })
    await writeFile(
      join(importedDir, '.foo.backup-000000000000001-old', 'SKILL.md'),
      '---\nname: Foo\n---\nolder generation'
    )
    await mkdir(join(importedDir, '.foo.backup-000000000000002-new'), { recursive: true })
    await writeFile(
      join(importedDir, '.foo.backup-000000000000002-new', 'SKILL.md'),
      '---\nname: Foo\n---\nnewer generation'
    )

    // Recovery restores the newest generation and discards the older; only the live dir remains.
    const repo = new UserSkillRepository(root)
    expect(await repo.body('imported-foo')).toContain('newer generation')
    expect((await readdir(importedDir)).sort()).toEqual(['foo'])
  })

  it('recovers a legacy-format transaction dir (no generation timestamp)', async () => {
    const root = await makeStorage()
    const importedDir = join(root, 'skills', 'imported')
    // A backup written before the sortable-generation change (name has no timestamp prefix).
    await mkdir(join(importedDir, '.foo.backup-legacyuuid'), { recursive: true })
    await writeFile(
      join(importedDir, '.foo.backup-legacyuuid', 'SKILL.md'),
      '---\nname: Foo\n---\nlegacy body'
    )

    expect(await new UserSkillRepository(root).body('imported-foo')).toContain('legacy body')
  })

  it('recovers within the same instance after a rollback leaves a backup (not memoized once)', async () => {
    const root = await makeStorage()
    const repo = new UserSkillRepository(root)
    const first = await repo.importFromGitHub(SKILL_URL, fakeFetch('---\nname: Foo\n---\nold body'))
    // First op already ran a recovery pass; prove a later crash state is still recovered by the SAME
    // instance (recovery is not cached after the first call).
    await repo.list()

    const importedDir = join(root, 'skills', 'imported')
    await rename(join(importedDir, 'foo'), join(importedDir, '.foo.backup-late-crash'))

    expect(await repo.body(first.id)).toContain('old body')
  })

  it('runs recovery before previewZip so dedup state is not stale after a crash', async () => {
    const root = await makeStorage()
    const repo = new UserSkillRepository(root)
    const zip = buildZip([
      { path: 'foo/SKILL.md', content: Buffer.from('---\nname: Foo\n---\nbody') }
    ])
    const { id } = await repo.importFromZip(zip)
    const slug = id.replace(/^imported-/, '')

    // Crash: the imported skill survives only as a hidden backup.
    const importedDir = join(root, 'skills', 'imported')
    await rename(join(importedDir, slug), join(importedDir, `.${slug}.backup-crash`))

    // previewZip must recover first, so the same bundle is correctly seen as already imported.
    const restarted = new UserSkillRepository(root)
    expect((await restarted.previewZip(zip)).previews[0].alreadyImported).toBe(true)
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
