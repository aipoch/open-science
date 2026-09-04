import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'

import {
  UserSkillRepository,
  parseUserSkillId,
  normalizeSkillName,
  frontmatterBlock
} from './user-skill-repository'
import { parseFrontmatter } from './frontmatter'
import { SKILL_IMPORT_LIMITS } from './import-limits'
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

describe('normalizeSkillName / parseUserSkillId', () => {
  it('normalizes imported names and parses the neutral storage directory from user Skill ids', () => {
    expect(normalizeSkillName('My Skill!')).toBe('my-skill')
    expect(parseUserSkillId('personal-my-skill')).toEqual({
      source: 'personal',
      directoryName: 'my-skill'
    })
    expect(parseUserSkillId('imported-foo')).toEqual({
      source: 'imported',
      directoryName: 'foo'
    })
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
  it('publishes a complete personal skill directory and only overwrites explicitly', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const draft = await mkdtemp(join(tmpdir(), 'skill-draft-'))
    await mkdir(join(draft, 'scripts'), { recursive: true })
    await writeFile(
      join(draft, 'SKILL.md'),
      '---\nname: analysis-helper\ndescription: Analyze a dataset.\n---\nUse the script.\n'
    )
    await writeFile(join(draft, 'scripts', 'run.js'), 'console.log("v1")\n')

    await expect(repo.publishPersonalDirectory('analysis-helper', draft)).resolves.toBe(
      'personal-analysis-helper'
    )
    await expect(
      readFile(join(storage, 'skills', 'personal', 'analysis-helper', 'scripts', 'run.js'), 'utf8')
    ).resolves.toBe('console.log("v1")\n')

    await writeFile(join(draft, 'scripts', 'run.js'), 'console.log("v2")\n')
    await expect(repo.publishPersonalDirectory('analysis-helper', draft)).rejects.toThrow(
      'already exists'
    )
    await expect(repo.publishPersonalDirectory('analysis-helper', draft, true)).resolves.toBe(
      'personal-analysis-helper'
    )
    await expect(
      readFile(join(storage, 'skills', 'personal', 'analysis-helper', 'scripts', 'run.js'), 'utf8')
    ).resolves.toBe('console.log("v2")\n')
  })

  it('rejects unsafe entries before publishing a personal skill directory', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const draft = await mkdtemp(join(tmpdir(), 'skill-draft-'))
    await writeFile(
      join(draft, 'SKILL.md'),
      '---\nname: unsafe\ndescription: Unsafe test.\n---\nBody.\n'
    )
    await symlink(join(storage, 'outside'), join(draft, 'escape'))

    await expect(repo.publishPersonalDirectory('unsafe', draft)).rejects.toThrow('symbolic link')
    await expect(stat(join(storage, 'skills', 'personal', 'unsafe'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('holds the mutation lock throughout a caller-controlled Skill read', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const id = await repo.createPersonal({
      name: 'locked',
      description: 'Original.',
      body: '# Original'
    })
    let releaseRead!: () => void
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })

    const read = repo.withSkillReadLock(id, async (skill) => {
      markReadStarted()
      await readReleased
      return skill.name
    })
    await readStarted

    let updateFinished = false
    const update = repo
      .updatePersonal(id, { name: 'locked', description: 'Updated.', body: '# Updated' })
      .finally(() => {
        updateFinished = true
      })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(updateFinished).toBe(false)

    releaseRead()
    await expect(read).resolves.toBe('locked')
    await update
    expect(updateFinished).toBe(true)
  })

  it('creates, lists, reads, updates, and deletes a personal skill', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const id = await repo.createPersonal({
      name: 'my-skill',
      description: 'Does a thing.',
      body: '# My Skill\nBody.'
    })
    expect(id).toBe('personal-my-skill')

    const listed = await repo.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: 'personal-my-skill',
      name: 'my-skill',
      description: 'Does a thing.',
      source: 'personal'
    })

    expect(await repo.body(id)).toContain('# My Skill')

    await repo.updatePersonal(id, {
      name: 'my-skill',
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
      name: 'tricky',
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

  it('rejects colliding personal skill names', async () => {
    const repo = new UserSkillRepository(await makeStorage())

    const first = await repo.createPersonal({ name: 'dup', description: 'a', body: 'x' })

    expect(first).toBe('personal-dup')
    await expect(repo.createPersonal({ name: 'dup', description: 'b', body: 'y' })).rejects.toThrow(
      /already exists/
    )
  })

  it('writes reference files under references/ when creating a skill', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)

    await repo.createPersonal({
      name: 'with-refs',
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

  it('rejects editor writes that exceed the shared package file-count budget', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)

    await expect(
      repo.createPersonal({
        name: 'too-many-files',
        description: 'd',
        body: 'x',
        references: Array.from({ length: SKILL_IMPORT_LIMITS.maxFiles }, (_, index) => ({
          path: `reference-${index}.txt`,
          dataBase64: Buffer.from('x').toString('base64')
        }))
      })
    ).rejects.toThrow('Skill package has too many files.')

    await expect(stat(join(storage, 'skills', 'personal', 'too-many-files'))).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
  })

  it('enforces the canonical SKILL.md body and persisted metadata budget', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const oversizedText = 'x'.repeat(SKILL_IMPORT_LIMITS.maxFileBytes)

    await expect(
      repo.createPersonal({
        name: 'oversized-body',
        description: 'd',
        body: oversizedText
      })
    ).rejects.toThrow('Skill package contains an oversized file.')

    await expect(
      repo.createPersonal({
        name: 'oversized-metadata',
        description: 'd',
        body: 'x',
        metadata: { notes: oversizedText }
      })
    ).rejects.toThrow('Skill package contains an oversized file.')

    await expect(
      repo.createPersonal({
        name: 'filtered-metadata',
        description: 'd',
        body: 'x',
        metadata: { 'not a persisted key': oversizedText }
      })
    ).resolves.toBe('personal-filtered-metadata')
  })

  it('rejects an oversized Base64 reference before publishing a live directory', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const dataBase64 = Buffer.alloc(SKILL_IMPORT_LIMITS.maxFileBytes + 1).toString('base64')

    await expect(
      repo.createPersonal({
        name: 'oversized-reference',
        description: 'd',
        body: 'x',
        references: [{ path: 'large.bin', dataBase64 }]
      })
    ).rejects.toThrow(/exceeds the .* limit/)

    await expect(
      stat(join(storage, 'skills', 'personal', 'oversized-reference'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an update when preserved files exceed the package total budget', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const id = await repo.createPersonal({
      name: 'oversized-total',
      description: 'before',
      body: 'before'
    })
    const packageRoot = join(storage, 'skills', 'personal', 'oversized-total')
    const referencesDir = join(packageRoot, 'references')
    await mkdir(referencesDir)
    const sparseFileBytes = Math.floor(SKILL_IMPORT_LIMITS.maxTotalBytes / 3) + 1
    for (const name of ['one.bin', 'two.bin', 'three.bin']) {
      const path = join(referencesDir, name)
      await writeFile(path, '')
      await truncate(path, sparseFileBytes)
    }

    await expect(
      repo.updatePersonal(id, {
        name: 'oversized-total',
        description: 'after',
        body: 'after'
      })
    ).rejects.toThrow('Skill package exceeds the total size limit.')
    await expect(repo.body(id)).resolves.toBe('before')
  })

  it('uses the immutable name and rejects collisions, reserved prefixes, and invalid names', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const id = await repo.createPersonal({ name: 'my-id', description: 'd', body: 'x' })
    expect(id).toBe('personal-my-id')

    // Colliding with the just-created name is rejected (no silent suffix).
    await expect(
      repo.createPersonal({ name: 'my-id', description: 'd', body: 'y' })
    ).rejects.toThrow(/already exists/)

    // Reserved built-in / MCP prefixes are rejected.
    await expect(
      repo.createPersonal({ name: 'os-thing', description: 'd', body: 'x' })
    ).rejects.toThrow(/os- or mcp-/)
    await expect(
      repo.createPersonal({ name: 'mcp-thing', description: 'd', body: 'x' })
    ).rejects.toThrow(/os- or mcp-/)

    // Unsafe characters are rejected.
    await expect(
      repo.createPersonal({ name: 'Bad Name', description: 'd', body: 'x' })
    ).rejects.toThrow(/lowercase/)
  })

  it('reconciles references on update: keeps untouched, adds new, deletes removed', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const b64 = (text: string): string => Buffer.from(text).toString('base64')

    const id = await repo.createPersonal({
      name: 'refs',
      description: 'd',
      body: 'x',
      references: [
        { path: 'keep.py', dataBase64: b64('keep') },
        { path: 'drop.py', dataBase64: b64('drop') }
      ]
    })

    await repo.updatePersonal(id, {
      name: 'refs',
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
      name: 'foo',
      source: 'imported',
      license: 'MIT',
      compatibility: expect.stringMatching(/^sha256-tree-v2:/)
    })
  })

  it.each(['personal', 'imported'] as const)(
    'lists only stable invocation-name directories from %s',
    async (source) => {
      const storage = await makeStorage()
      const sourceDir = join(storage, 'skills', source)
      for (const name of ['valid-name', '-leading', 'double--hyphen', 'a'.repeat(65)]) {
        const directory = join(sourceDir, name)
        await mkdir(directory, { recursive: true })
        await writeFile(
          join(directory, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Direct package.\n---\nbody\n`
        )
      }

      expect((await new UserSkillRepository(storage).list()).map((skill) => skill.name)).toEqual([
        'valid-name'
      ])
    }
  )

  it('returns empty when no user skills exist', async () => {
    expect(await new UserSkillRepository(await makeStorage()).list()).toEqual([])
  })

  it('previews one selected GitHub skill without importing it', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const preview = await repo.previewGitHubSkill(
      SKILL_URL,
      fakeFetch(
        [
          '---',
          'name: Foo',
          'description: A remote skill.',
          'license: MIT',
          '---',
          '# Preview body'
        ].join('\n')
      )
    )

    expect(preview).toEqual({
      name: 'Foo',
      description: 'A remote skill.',
      metadata: { license: 'MIT' },
      body: '# Preview body',
      files: ['SKILL.md']
    })
    expect(await repo.list()).toEqual([])
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
    expect(listed[0]).toMatchObject({ name: 'bundled', source: 'imported' })

    // The wrapper prefix is stripped, so the script lands under references-free root path.
    const script = await readFile(
      join(storage, 'skills', 'imported', 'bundled', 'scripts', 'run.py'),
      'utf8'
    )
    expect(script).toBe('print(1)')

    // Same content re-imported is a no-op.
    expect((await repo.importFromZip(zip)).status).toBe('unchanged')
  })

  it.each(['os-reserved', 'mcp-reserved'])(
    'rejects reserved imported name %s before GitHub or archive content is written',
    async (name) => {
      const storage = await makeStorage()
      const repo = new UserSkillRepository(storage)
      const skillMd = `---\nname: ${name}\ndescription: Reserved.\n---\nbody`

      await expect(repo.importFromGitHub(SKILL_URL, fakeFetch(skillMd))).rejects.toThrow(
        /os- or mcp-/
      )
      await expect(
        repo.importFromZip(buildZip([{ path: 'SKILL.md', content: Buffer.from(skillMd) }]))
      ).rejects.toThrow(/os- or mcp-/)
      expect(await repo.list()).toEqual([])
      await expect(readdir(join(storage, 'skills', 'imported'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  )

  it('allocates an imported suffix when a Personal Skill already owns the name', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    await repo.createPersonal({ name: 'bundled', description: 'Personal', body: 'personal' })
    const zip = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: Bundled\n---\nimported') }
    ])

    await expect(repo.importFromZip(zip)).resolves.toEqual({
      status: 'imported',
      id: 'imported-bundled-2'
    })
  })

  it('rejects a Personal Skill name already owned by an Imported Skill', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    await repo.importFromZip(
      buildZip([{ path: 'SKILL.md', content: Buffer.from('---\nname: Shared\n---\nimported') }])
    )

    await expect(
      repo.createPersonal({ name: 'shared', description: 'Personal', body: 'personal' })
    ).rejects.toThrow('A skill named "shared" already exists.')
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
    expect(body).toContain('name: beta')
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
          metadata: {},
          body: 'body',
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

  it('previews a three-level wrapped ppt-master-scale Skill bundle', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // ppt-master v6.2.0 contains 12,941 files. Keep a small synthetic fixture at the same structural
    // scale so the real release remains importable without checking a third-party archive into Git.
    const zip = buildZip([
      {
        path: 'ppt-master/skills/ppt-master/SKILL.md',
        content: Buffer.from('---\nname: ppt-master\ndescription: d\n---\nbody')
      },
      ...Array.from({ length: 12_940 }, (_, index) => ({
        path: `ppt-master/skills/ppt-master/templates/icons/icon-${index}.svg`,
        content: Buffer.alloc(0)
      }))
    ])

    const { previews } = await repo.previewZip(zip)

    expect(previews).toEqual([
      expect.objectContaining({
        name: 'ppt-master',
        subPath: 'ppt-master/skills/ppt-master'
      })
    ])
    expect(previews[0].files).toHaveLength(12_941)
  })

  it('bounds cumulative preview content without making later bundle skills unimportable', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const largeBody = Buffer.alloc(3 * 1024 * 1024, 0x61)
    const skillMd = (name: string): Buffer =>
      Buffer.concat([
        Buffer.from(`---\nname: ${name}\ndescription: Large preview\n---\n`),
        largeBody
      ])
    const zip = buildZip([
      { path: 'alpha/SKILL.md', content: skillMd('Alpha') },
      { path: 'beta/SKILL.md', content: skillMd('Beta') }
    ])

    const { previews, skipped } = await repo.previewZip(zip)

    expect(previews.map((preview) => preview.name)).toEqual(['Alpha', 'Beta'])
    expect(previews[0]).toMatchObject({ previewError: undefined })
    expect(previews[1]).toMatchObject({
      body: '',
      previewError: expect.stringMatching(/preview content.*limit/i)
    })
    expect(skipped).toEqual([])

    await expect(
      repo.importFromZipBatch(
        zip,
        previews.map((preview) => ({ subPath: preview.subPath }))
      )
    ).resolves.toMatchObject([
      { subPath: 'alpha', outcome: { status: 'imported' } },
      { subPath: 'beta', outcome: { status: 'imported' } }
    ])
  })

  it('omits oversized frontmatter fields from a still-importable bundle preview', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const oversizedDescription = 'x'.repeat(SKILL_IMPORT_LIMITS.maxPreviewContentBytes)
    const zip = buildZip([
      {
        path: 'large-frontmatter/SKILL.md',
        content: Buffer.from(
          `---\nname: Large frontmatter\ndescription: ${oversizedDescription}\nauthor: Ada\n---\n# Body`
        )
      }
    ])

    const { previews, skipped } = await repo.previewZip(zip)

    expect(previews).toEqual([
      expect.objectContaining({
        name: 'Large frontmatter',
        description: '',
        metadata: {},
        body: '',
        previewError: expect.stringMatching(/preview content.*limit/i)
      })
    ])
    expect(skipped).toEqual([])
    await expect(
      repo.importFromZipBatch(zip, [{ subPath: 'large-frontmatter' }])
    ).resolves.toMatchObject([{ outcome: { status: 'imported' } }])
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
    expect((await repo.list()).map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
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
    expect((await repo.list()).map((s) => s.name)).toEqual(['alpha'])
  })

  it('skips a loose single-skill root that exceeds the per-skill file-count cap', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // A SKILL.md plus more loose files than the per-skill cap allows — within the bundle-wide walk
    // caps, but over the per-skill file count, so the root is rejected rather than imported.
    const extras = Array.from({ length: SKILL_IMPORT_LIMITS.maxFiles + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      content: Buffer.from('x')
    }))
    const zip = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\nname: Big\ndescription: d\n---\nx') },
      ...extras
    ])

    const { previews, skipped } = await repo.previewZip(zip)
    expect(previews).toHaveLength(0)
    expect(skipped[0].reason).toMatch(/more than \d+ files/)
  })

  it('skips a loose root whose file the lenient walk dropped (no partial import)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // A file nested past the depth cap is dropped by the outer walk; the root that owns it must be
    // skipped rather than imported without it. (Depth is a cheap stand-in for any dropped-file cause.)
    const tooDeep = `pack/${Array.from({ length: SKILL_IMPORT_LIMITS.maxDepth }, (_, i) => `d${i}`).join('/')}/x.txt`
    const zip = buildZip([
      { path: 'pack/SKILL.md', content: Buffer.from('---\nname: Pack\ndescription: d\n---\nx') },
      { path: tooDeep, content: Buffer.from('deep') }
    ])

    const { previews, skipped } = await repo.previewZip(zip)
    expect(previews).toHaveLength(0)
    expect(skipped.some((s) => s.source === 'pack' && /couldn't be imported/.test(s.reason))).toBe(
      true
    )
  })

  it('skips a loose root whose unsafe path was dropped (no partial import)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const zip = buildZip([
      { path: 'tool/SKILL.md', content: Buffer.from('---\nname: Tool\ndescription: d\n---\nx') },
      { path: 'tool/../evil.txt', content: Buffer.from('nope') }
    ])

    const { previews, skipped } = await repo.previewZip(zip)
    expect(previews).toHaveLength(0)
    expect(skipped.some((s) => s.source === 'tool' && /unsafe path/.test(s.reason))).toBe(true)
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

    // Import derives the canonical name from frontmatter instead of using a generic fallback.
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

  it('offers the canonical-name match when another imported Skill has a conflict suffix', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    await repo.importFromZip(sharedBundle('v1'))
    await repo.importFromZip(sharedBundle('v2')) // second "Shared" -> imported-shared-2

    const [preview] = (await repo.previewZip(sharedBundle('v3'))).previews
    expect(preview.replaceableId).toBe('imported-shared')
  })

  it('normalizes a multi-word preview name before finding its replace target', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const bundle = (body: string): Buffer =>
      buildZip([
        {
          path: 'pack/SKILL.md',
          content: Buffer.from(`---\nname: Paper Review\ndescription: d\n---\n${body}`)
        }
      ])
    await repo.importFromZip(bundle('v1'))

    const [preview] = (await repo.previewZip(bundle('v2'))).previews
    expect(preview.replaceableId).toBe('imported-paper-review')
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
    expect(listed[0]).toMatchObject({ name: 'foo', source: 'imported' })

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

  it('serializes concurrent fresh imports so they get distinct names (no clobber)', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    // Two sources request the same normalized name ("foo"). Name allocation and swap share one
    // critical section, so the second is suffixed rather than
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

  it('restores the newest backup when several exist for one directory name', async () => {
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
    const directoryName = id.replace(/^imported-/, '')

    // Crash: the imported skill survives only as a hidden backup.
    const importedDir = join(root, 'skills', 'imported')
    await rename(
      join(importedDir, directoryName),
      join(importedDir, `.${directoryName}.backup-crash`)
    )

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
        : url.includes('/commits/')
          ? { sha: '0123456789abcdef0123456789abcdef01234567' }
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
    const id = await repo.createPersonal({
      name: 'round-trip',
      description: 'desc',
      metadata: {
        author: 'Ada',
        license: 'MIT',
        name: 'Untrusted override',
        description: 'Untrusted override',
        Name: 'Case-insensitive override',
        DESCRIPTION: 'Case-insensitive override'
      },
      body: 'hello'
    })

    const raw = await readFile(
      join(storage, 'skills', 'personal', 'round-trip', 'SKILL.md'),
      'utf8'
    )
    expect(raw).toContain('name: round-trip')
    expect(raw).toContain('description: desc')
    expect(parseFrontmatter(raw).fields).toMatchObject({
      name: 'round-trip',
      description: 'desc',
      author: 'Ada',
      license: 'MIT'
    })
    expect(await repo.body(id)).toBe('hello')
  })
})

describe('UserSkillRepository: agent-home import', () => {
  // Round 5 of the AI review (the agent-home import path). The listAgentHomeSkills + importAgentHomeSkill
  // pair is the new "From your agent home" source on the Skills panel. The repository layer owns
  // the file-system work; the service layer wraps it with framework routing. These tests cover the
  // copy/conflict/failure paths the repository is responsible for.

  // The agent-home directory layout is `<home>/skills/<slug>/SKILL.md`, mirroring what the renderer
  // sees as the user's `~/.claude/skills/` (or `~/.codex/skills/`) tree.
  const seedSkill = async (agentHome: string, slug: string): Promise<string> => {
    const dir = join(agentHome, 'skills', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: Test skill ${slug}\n---\nBody of ${slug}.\n`
    )
    return dir
  }

  it('lists skills under the agent home with alreadyImported=false for fresh skills', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-list-agent-'))
    await seedSkill(home, 'alpha')
    await seedSkill(home, 'beta')

    const items = await repo.listAgentHomeSkills(join(home, 'skills'), 'agents')

    expect(items.map((i) => i.slug).sort()).toEqual(['alpha', 'beta'])
    expect(items.every((i) => i.alreadyImported === false)).toBe(true)
    expect(items[0].path).toBe(join(home, 'skills', items[0].slug))
  })

  it('hides agent-home directories that cannot be allocated as imported Skill names', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-list-agent-'))
    await seedSkill(home, 'alpha')
    await seedSkill(home, 'foo--bar')
    await seedSkill(home, 'a'.repeat(65))
    await seedSkill(home, 'os-reserved')

    const items = await repo.listAgentHomeSkills(join(home, 'skills'), 'agents')

    expect(items.map((item) => item.slug)).toEqual(['alpha'])
  })

  it('previews an installed skill body, metadata, and file names without importing it', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const home = await mkdtemp(join(tmpdir(), 'os-preview-agent-'))
    const source = await seedSkill(home, 'alpha')
    await writeFile(
      join(source, 'SKILL.md'),
      [
        '---',
        'name: Alpha',
        'description: Installed preview.',
        'license: Apache-2.0',
        '---',
        '# Installed body'
      ].join('\n')
    )
    await mkdir(join(source, 'references'))
    await writeFile(join(source, 'references', 'guide.md'), 'Guide')

    await expect(repo.previewAgentHomeSkill(source)).resolves.toEqual({
      name: 'Alpha',
      description: 'Installed preview.',
      metadata: { license: 'Apache-2.0' },
      body: '# Installed body',
      files: ['SKILL.md', 'references/guide.md']
    })
    expect(await repo.list()).toEqual([])
  })

  it('bounds installed preview content without preventing import', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-preview-agent-content-large-'))
    const source = await seedSkill(home, 'alpha')
    await writeFile(
      join(source, 'SKILL.md'),
      `---\nname: alpha\ndescription: Large preview\n---\n${'x'.repeat(SKILL_IMPORT_LIMITS.maxPreviewContentBytes)}`
    )

    const previewError = await repo.previewAgentHomeSkill(source).then(
      () => null,
      (error: unknown) => error
    )
    expect(previewError).toBeInstanceOf(Error)
    expect((previewError as Error).message).toMatch(/preview exceeds the 4 MB limit/i)
    await expect(
      repo.importAgentHomeSkill(source, { source: 'agents', slug: 'alpha' })
    ).resolves.toMatchObject({ status: 'imported', id: 'imported-alpha' })
  })

  it('rejects an installed preview whose declared file sizes exceed the skill cap', async () => {
    const repo = new UserSkillRepository(await makeStorage())
    const home = await mkdtemp(join(tmpdir(), 'os-preview-agent-large-'))
    const source = await seedSkill(home, 'alpha')
    const largeReference = join(source, 'large.bin')
    await writeFile(largeReference, '')
    await truncate(largeReference, SKILL_IMPORT_LIMITS.maxFileBytes + 1)

    await expect(repo.previewAgentHomeSkill(source)).rejects.toThrow(/file over/)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a nested symlink while previewing an installed skill',
    async () => {
      const repo = new UserSkillRepository(await makeStorage())
      const home = await mkdtemp(join(tmpdir(), 'os-preview-agent-link-'))
      const source = await seedSkill(home, 'alpha')
      const outside = join(home, 'outside.md')
      await writeFile(outside, 'outside')
      await mkdir(join(source, 'references'))
      await symlink(outside, join(source, 'references', 'outside.md'))

      await expect(repo.previewAgentHomeSkill(source)).rejects.toThrow(/symbolic link/)
    }
  )

  it('marks a skill as alreadyImported when the same source identity exists', async () => {
    // The renderer uses alreadyImported to flip the row to a "Imported" badge and hide the action
    // button. The match is by source plus slug and the current content signature.
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-list-agent-'))
    await seedSkill(home, 'alpha')

    await repo.importAgentHomeSkill(join(home, 'skills', 'alpha'), {
      source: 'agents',
      slug: 'alpha'
    })

    const items = await repo.listAgentHomeSkills(join(home, 'skills'), 'agents')
    expect(items[0].alreadyImported).toBe(true)
  })

  it('skips loose files and directories without a readable SKILL.md', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-list-agent-'))
    await mkdir(join(home, 'skills'), { recursive: true })
    await writeFile(join(home, 'skills', 'stray-file.txt'), 'not a skill')
    await mkdir(join(home, 'skills', 'empty-directory'))
    await seedSkill(home, 'alpha')

    const items = await repo.listAgentHomeSkills(join(home, 'skills'), 'agents')
    expect(items.map((i) => i.slug)).toEqual(['alpha'])
  })

  it.skipIf(process.platform === 'win32')(
    'lists directory symlinks that resolve to a readable skill',
    async () => {
      const storage = await makeStorage()
      const repo = new UserSkillRepository(storage)
      const home = await mkdtemp(join(tmpdir(), 'os-list-agent-link-'))
      const target = await seedSkill(home, 'real-skill')
      await symlink(target, join(home, 'skills', 'linked-skill'))

      const items = await repo.listAgentHomeSkills(join(home, 'skills'), 'agents')

      expect(items.map((item) => item.slug)).toEqual(['linked-skill', 'real-skill'])
    }
  )

  it('returns an empty list for a missing agent-home skills dir (no error)', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-list-agent-'))

    const items = await repo.listAgentHomeSkills(join(home, 'skills'), 'agents')
    expect(items).toEqual([])
  })

  it('imports a skill and lists the imported record under the new slug', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-'))
    await seedSkill(home, 'alpha')

    const outcome = await repo.importAgentHomeSkill(join(home, 'skills', 'alpha'), {
      source: 'agents',
      slug: 'alpha'
    })

    expect(outcome).toEqual({ status: 'imported', id: 'imported-alpha' })
    const skills = await repo.list()
    expect(skills.find((s) => s.id === 'imported-alpha')).toBeDefined()
  })

  it.each(['os-reserved', 'mcp-reserved'])(
    'rejects reserved agent-home slug %s before copying it into Imported',
    async (slug) => {
      const storage = await makeStorage()
      const repo = new UserSkillRepository(storage)
      const home = await mkdtemp(join(tmpdir(), 'os-import-agent-'))
      const source = await seedSkill(home, slug)

      await expect(repo.importAgentHomeSkill(source, { source: 'agents', slug })).rejects.toThrow(
        /os- or mcp-/
      )
      expect(await repo.list()).toEqual([])
    }
  )

  it('throws when the source path does not exist (no half-copied state)', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-'))
    // No seedSkill — the path resolves to a non-existent directory.

    await expect(
      repo.importAgentHomeSkill(join(home, 'skills', 'missing'), {
        source: 'agents',
        slug: 'missing'
      })
    ).rejects.toThrow(/not available/)
    // No record should have been created on the failure path.
    expect(await repo.list()).toEqual([])
  })

  it.each(['has spaces', 'foo--bar', 'a'.repeat(65)])(
    'rejects noncanonical Agent Home slug %s before copying it',
    async (slug) => {
      const storage = await makeStorage()
      const repo = new UserSkillRepository(storage)
      const home = await mkdtemp(join(tmpdir(), 'os-import-agent-'))
      const source = await seedSkill(home, slug)

      await expect(repo.importAgentHomeSkill(source, { source: 'agents', slug })).rejects.toThrow(
        /must use up to 64/
      )
      expect(await repo.list()).toEqual([])
    }
  )

  it('deduplicates the same installed skill identity while suffixing a cross-source collision', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-'))
    await seedSkill(home, 'alpha')

    const first = await repo.importAgentHomeSkill(join(home, 'skills', 'alpha'), {
      source: 'agents',
      slug: 'alpha'
    })
    const repeated = await repo.importAgentHomeSkill(join(home, 'skills', 'alpha'), {
      source: 'agents',
      slug: 'alpha'
    })
    const secondSource = await repo.importAgentHomeSkill(join(home, 'skills', 'alpha'), {
      source: 'claude',
      slug: 'alpha'
    })

    expect(first.id).toBe('imported-alpha')
    expect(repeated).toEqual({ status: 'unchanged', id: 'imported-alpha' })
    expect(secondSource.id).toBe('imported-alpha-2')
    const skills = await repo.list()
    expect(skills.find((s) => s.id === 'imported-alpha')).toBeDefined()
    expect(skills.find((s) => s.id === 'imported-alpha-2')).toBeDefined()
  })

  it('revalidates legacy fallback content during import', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-stale-fallback-'))
    const source = await seedSkill(home, 'alpha')
    const importedDir = join(storage, 'skills', 'imported', 'alpha')
    await mkdir(importedDir, { recursive: true })
    await writeFile(
      join(importedDir, 'SKILL.md'),
      '---\nname: alpha\ndescription: Different import\n---\nDifferent body.\n'
    )

    const outcome = await repo.importAgentHomeSkill(
      source,
      { source: 'agents', slug: 'alpha' },
      { fallbackDirectoryNames: ['alpha'] }
    )

    expect(outcome).toEqual({ status: 'imported', id: 'imported-alpha-2' })
  })

  it('does not update skill content during a stale canonical identity migration', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-stale-migration-'))
    const source = await seedSkill(home, 'alpha')
    await repo.importAgentHomeSkill(source, { source: 'claude', slug: 'linked-skill' })
    const importedDir = join(storage, 'skills', 'imported', 'linked-skill')
    const originalManifest = JSON.parse(
      await readFile(join(importedDir, '.source.json'), 'utf8')
    ) as { signature: string }

    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: alpha\ndescription: Changed during scan\n---\nChanged body.\n'
    )

    await expect(
      repo.importAgentHomeSkill(
        source,
        { source: 'agents', slug: 'alpha' },
        {
          aliases: [{ source: 'claude', slug: 'linked-skill' }],
          expectedSignature: originalManifest.signature
        }
      )
    ).rejects.toThrow(/changed during canonical identity migration/)
    expect(await readFile(join(importedDir, 'SKILL.md'), 'utf8')).toContain('Body of alpha.')
  })

  it('does not recreate an imported alias deleted after canonical identity matching', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-deleted-migration-'))
    const source = await seedSkill(home, 'alpha')
    await repo.importAgentHomeSkill(source, { source: 'claude', slug: 'linked-skill' })

    const [match] = await repo.matchImportedAgentHomeSkills([
      {
        sourcePath: source,
        canonical: { source: 'agents', slug: 'alpha' },
        aliases: [{ source: 'claude', slug: 'linked-skill' }]
      }
    ])
    await repo.delete('imported-linked-skill')

    await expect(
      repo.importAgentHomeSkill(
        source,
        { source: 'agents', slug: 'alpha' },
        {
          aliases: [{ source: 'claude', slug: 'linked-skill' }],
          expectedSignature: match.matchedIdentitySignature,
          expectedImportedIdentity: match.matchedImportedIdentity
        }
      )
    ).rejects.toThrow(/changed during canonical identity migration/)
    expect(await repo.list()).toEqual([])
  })

  it('does not overwrite an imported alias changed after canonical identity matching', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-changed-migration-'))
    const source = await seedSkill(home, 'alpha')
    await repo.importAgentHomeSkill(source, { source: 'claude', slug: 'linked-skill' })

    const [match] = await repo.matchImportedAgentHomeSkills([
      {
        sourcePath: source,
        canonical: { source: 'agents', slug: 'alpha' },
        aliases: [{ source: 'claude', slug: 'linked-skill' }]
      }
    ])
    const importedDir = join(storage, 'skills', 'imported', 'linked-skill')
    await writeFile(
      join(importedDir, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: Concurrent edit\n---\nKeep this body.\n'
    )

    await expect(
      repo.importAgentHomeSkill(
        source,
        { source: 'agents', slug: 'alpha' },
        {
          aliases: [{ source: 'claude', slug: 'linked-skill' }],
          expectedSignature: match.matchedIdentitySignature,
          expectedImportedIdentity: match.matchedImportedIdentity
        }
      )
    ).rejects.toThrow(/changed during canonical identity migration/)
    expect(await readFile(join(importedDir, 'SKILL.md'), 'utf8')).toContain('Keep this body.')
  })

  it('refreshes an installed skill when the same source identity changes', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-refresh-'))
    const source = await seedSkill(home, 'alpha')
    const skill = { source: 'agents', slug: 'alpha' } as const

    await repo.importAgentHomeSkill(source, skill)
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: alpha\ndescription: Updated\n---\nUpdated body.\n'
    )

    expect((await repo.listAgentHomeSkills(join(home, 'skills'), 'agents'))[0]).toMatchObject({
      alreadyImported: false
    })

    const updated = await repo.importAgentHomeSkill(source, skill)
    const unchanged = await repo.importAgentHomeSkill(source, skill)

    expect(updated).toEqual({ status: 'updated', id: 'imported-alpha' })
    expect(unchanged).toEqual({ status: 'unchanged', id: 'imported-alpha' })
    expect(
      await readFile(join(storage, 'skills', 'imported', 'alpha', 'SKILL.md'), 'utf8')
    ).toContain('Updated body.')
    expect(
      JSON.parse(
        await readFile(join(storage, 'skills', 'imported', 'alpha', '.source.json'), 'utf8')
      )
    ).toMatchObject({ agentHome: skill, signature: expect.any(String) })
  })

  it('refreshes installed-skill directory structure and portable permission changes', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-structure-'))
    const source = await seedSkill(home, 'alpha')
    const skill = { source: 'agents', slug: 'alpha' } as const
    await repo.importAgentHomeSkill(source, skill)

    await mkdir(join(source, 'empty-reference-dir'))
    expect(await repo.importAgentHomeSkill(source, skill)).toMatchObject({ status: 'updated' })
    expect(
      (
        await stat(join(storage, 'skills', 'imported', 'alpha', 'empty-reference-dir'))
      ).isDirectory()
    ).toBe(true)

    if (process.platform !== 'win32') {
      await chmod(join(source, 'SKILL.md'), 0o744)
      expect(await repo.importAgentHomeSkill(source, skill)).toMatchObject({ status: 'updated' })
      expect(
        (await stat(join(storage, 'skills', 'imported', 'alpha', 'SKILL.md'))).mode & 0o777
      ).toBe(0o744)
    }
  })

  it('preserves the prior imported copy when an installed-skill refresh fails validation', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-refresh-failure-'))
    const source = await seedSkill(home, 'alpha')
    const skill = { source: 'agents', slug: 'alpha' } as const
    await repo.importAgentHomeSkill(source, skill)
    const importedDir = join(storage, 'skills', 'imported', 'alpha')
    const originalManifest = await readFile(join(importedDir, '.source.json'), 'utf8')

    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: alpha\ndescription: Invalid refresh\n---\nReplacement body.\n'
    )
    await writeFile(join(source, '.source.json'), '{}')

    await expect(repo.importAgentHomeSkill(source, skill)).rejects.toThrow(/reserved file/)
    expect(await readFile(join(importedDir, 'SKILL.md'), 'utf8')).toContain('Body of alpha.')
    expect(await readFile(join(importedDir, '.source.json'), 'utf8')).toBe(originalManifest)
    expect(
      (await readdir(join(storage, 'skills', 'imported'))).filter((entry) =>
        entry.startsWith('.alpha.import-')
      )
    ).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink used as the Skill root', async () => {
    const storage = await makeStorage()
    const repo = new UserSkillRepository(storage)
    const home = await mkdtemp(join(tmpdir(), 'os-import-agent-symlink-root-'))
    const target = await seedSkill(home, 'real-skill')
    const link = join(home, 'skills', 'linked-skill')
    await symlink(target, link)

    await expect(
      repo.importAgentHomeSkill(link, { source: 'agents', slug: 'linked-skill' })
    ).rejects.toThrow(/symbolic link/)
    expect(await repo.list()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a nested symlink in the Skill tree',
    async () => {
      const storage = await makeStorage()
      const repo = new UserSkillRepository(storage)
      const home = await mkdtemp(join(tmpdir(), 'os-import-agent-symlink-nested-'))
      const source = await seedSkill(home, 'alpha')
      const outside = join(home, 'outside.md')
      await writeFile(outside, 'outside')
      await mkdir(join(source, 'references'), { recursive: true })
      await symlink(outside, join(source, 'references', 'outside.md'))

      await expect(
        repo.importAgentHomeSkill(source, { source: 'agents', slug: 'alpha' })
      ).rejects.toThrow(/symbolic link/)
      expect(await repo.list()).toEqual([])
    }
  )
})
