import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Wrap real filesystem operations with spies for deterministic swap and cleanup failures.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
    rm: vi.fn((...args: Parameters<typeof actual.rm>) => actual.rm(...args))
  }
})

import * as fsp from 'node:fs/promises'
import { UserSkillRepository } from './user-skill-repository'
import type { FetchLike } from './github-import'

const SKILL_URL = 'https://github.com/acme/skills/tree/main/pack/foo'

// The unmocked rename, captured once; each test resets the spy to pass through to it so a prior test's
// failure injection can't leak into the next test's setup.
let realRename: typeof import('node:fs/promises').rename
let realRm: typeof import('node:fs/promises').rm
beforeEach(async () => {
  realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  realRm = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm
  vi.mocked(fsp.rename).mockImplementation((from, to) => realRename(from, to))
  vi.mocked(fsp.rm).mockImplementation((path, options) => realRm(path, options))
})

const fetchSkill =
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
            download_url: 'https://raw/s'
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

describe('writeImported swap atomicity', () => {
  it('rolls back to the previous skill when the swap rename fails', async () => {
    const repo = new UserSkillRepository(await mkdtemp(join(tmpdir(), 'atomic-')))

    const first = await repo.importFromGitHub(
      SKILL_URL,
      fetchSkill('---\nname: Foo\n---\nold body')
    )
    expect(await repo.body(first.id)).toContain('old body')

    // Fail only the staging -> live-dir rename (its source is the ".import-" staging dir); let the
    // dir -> backup move and the backup -> dir rollback (sources without ".import-") run for real.
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).includes('.import-')) throw new Error('simulated swap failure')
      return realRename(from, to)
    })

    await expect(
      repo.importFromGitHub(SKILL_URL, fetchSkill('---\nname: Foo\n---\nnew body'))
    ).rejects.toThrow(/simulated swap failure/)

    // The failed swap left the previous skill intact — not deleted, not half-written.
    expect(await repo.body(first.id)).toContain('old body')
  })

  it('preserves the backup and recovers it when the rollback also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-rollback-'))
    const repo = new UserSkillRepository(root)

    const first = await repo.importFromGitHub(
      SKILL_URL,
      fetchSkill('---\nname: Foo\n---\nold body')
    )
    expect(await repo.body(first.id)).toContain('old body')

    // Fail BOTH the swap (staging -> live) and the rollback (backup -> live) — any rename whose source
    // is a transaction dir. The initial live -> backup move (source is the live dir) still succeeds,
    // so the backup is left on disk.
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).includes('.import-') || String(from).includes('.backup-')) {
        throw new Error('simulated fs failure')
      }
      return realRename(from, to)
    })

    await expect(
      repo.importFromGitHub(SKILL_URL, fetchSkill('---\nname: Foo\n---\nnew body'))
    ).rejects.toThrow(/preserved at .*backup-.*restored on the next operation/)

    // With a healthy filesystem again, the SAME instance recovers the preserved backup on its next
    // operation — recovery is not memoized after the first pass, so a backup left later is still fixed.
    vi.mocked(fsp.rename).mockImplementation((from, to) => realRename(from, to))
    expect(await repo.body(first.id)).toContain('old body')

    // And a fresh instance (a real restart) recovers it just the same.
    const restarted = new UserSkillRepository(root)
    expect(await restarted.body(first.id)).toContain('old body')
  })

  it('rejects the operation when a required backup restore fails (no silent proceed)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-restore-fail-'))
    const repo = new UserSkillRepository(root)
    const first = await repo.importFromGitHub(
      SKILL_URL,
      fetchSkill('---\nname: Foo\n---\nold body')
    )

    // Crash state: the live dir survives only as a backup (set up with the real rename).
    const importedDir = join(root, 'skills', 'imported')
    await realRename(join(importedDir, 'foo'), join(importedDir, '.foo.backup-crash'))

    // Now make the restore rename fail. Recovery must reject the operation rather than log-and-proceed
    // (which would let a delete() remove a non-existent live dir and "succeed").
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).includes('.backup-')) throw new Error('restore failure')
      return realRename(from, to)
    })

    await expect(repo.body(first.id)).rejects.toThrow(/Failed to recover/)
  })

  it('leaves nothing behind when a fresh import fails its swap rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-fresh-fail-'))
    const repo = new UserSkillRepository(root)

    // No prior skill, so there is no backup; only the staging -> live rename runs and here it fails.
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).includes('.import-')) throw new Error('swap failure')
      return realRename(from, to)
    })

    await expect(
      repo.importFromGitHub(SKILL_URL, fetchSkill('---\nname: Foo\n---\nbody'))
    ).rejects.toThrow(/swap failure/)

    // Staging was discarded; nothing partial remains.
    vi.mocked(fsp.rename).mockImplementation((from, to) => realRename(from, to))
    expect(await repo.list()).toEqual([])
  })
})

describe.each(['imported', 'personal'] as const)('%s replacement recovery validation', (source) => {
  let root: string
  let sourceDir: string
  let live: string
  let backup: string
  let staging: string
  const oldDocument = '---\nname: foo\n---\nold body'
  const newDocument = '---\nname: foo\n---\nnew body'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'atomic-recovery-validation-'))
    sourceDir = join(root, 'skills', source)
    live = join(sourceDir, 'foo')
    backup = join(sourceDir, '.foo.backup-crash')
    staging = join(sourceDir, '.foo.import-crash')
    await mkdir(live, { recursive: true })
    await writeFile(join(live, 'SKILL.md'), oldDocument)
    if (source === 'imported') {
      await writeFile(join(live, '.source.json'), JSON.stringify({ url: SKILL_URL }))
    }
    await mkdir(staging)
    await writeFile(join(staging, 'SKILL.md'), newDocument)
  })

  afterEach(async () => {
    await realRm(root, { recursive: true, force: true })
  })

  it.each(['first rename', 'second rename'])(
    'restores the previous package after a crash following the %s',
    async (boundary) => {
      await realRename(live, backup)
      if (boundary === 'second rename') await realRename(staging, live)
      const validate = vi.fn<NonNullable<ConstructorParameters<typeof UserSkillRepository>[2]>>(
        async (list) => {
          const skills = await list()
          const document = await readFile(join(skills[0].sourceDir, 'SKILL.md'), 'utf8')
          if (document.includes('new body')) throw new Error('new helper rejected')
        }
      )
      const restarted = new UserSkillRepository(root, undefined, validate)

      // Public reads execute the real runRecovered path and repository validator binding.
      expect.soft(await restarted.body(`${source}-foo`)).toBe('old body')
      expect.soft(validate).toHaveBeenCalledTimes(boundary === 'second rename' ? 1 : 0)
      expect.soft(await readFile(join(live, 'SKILL.md'), 'utf8')).toBe(oldDocument)
      expect(await fsp.readdir(sourceDir)).toEqual(['foo'])
    }
  )

  it('rolls back when promotion validation fails', async () => {
    const validate = vi.fn(async () => {
      throw new Error('new helper rejected')
    })
    const repo = new UserSkillRepository(root, undefined, validate)

    if (source === 'imported') {
      await expect(repo.importFromGitHub(SKILL_URL, fetchSkill(newDocument))).rejects.toThrow(
        'new helper rejected'
      )
    } else {
      await expect(
        repo.updatePersonal('personal-foo', { name: 'foo', description: '', body: 'new body' })
      ).rejects.toThrow('new helper rejected')
    }

    expect(validate).toHaveBeenCalledTimes(1)
    expect(await readFile(join(live, 'SKILL.md'), 'utf8')).toBe(oldDocument)
    expect(await fsp.readdir(sourceDir)).toEqual(['foo'])
  })

  it('revalidates a successful promotion before retrying failed backup cleanup', async () => {
    const validate = vi.fn(async () => {})
    const repo = new UserSkillRepository(root, undefined, validate)
    vi.mocked(fsp.rm).mockImplementation(async (path, options) => {
      if (String(path).includes('.backup-')) throw new Error('backup cleanup failed')
      return realRm(path, options)
    })
    if (source === 'imported') {
      await repo.importFromGitHub(SKILL_URL, fetchSkill(newDocument))
    } else {
      await repo.updatePersonal('personal-foo', { name: 'foo', description: '', body: 'new body' })
    }
    expect(validate).toHaveBeenCalledTimes(1)
    const entries = await fsp.readdir(sourceDir)
    const leftover = entries.find((entry) => entry.includes('.backup-'))!
    expect(await readFile(join(sourceDir, leftover, 'SKILL.md'), 'utf8')).toBe(oldDocument)

    validate.mockClear()
    const restarted = new UserSkillRepository(root, undefined, validate)
    expect(await restarted.body(`${source}-foo`)).toBe('new body')
    expect.soft(validate).toHaveBeenCalledTimes(1)
    expect(await fsp.readdir(sourceDir)).toContain(leftover)

    vi.mocked(fsp.rm).mockImplementation((path, options) => realRm(path, options))
    expect(await restarted.body(`${source}-foo`)).toBe('new body')
    expect.soft(validate).toHaveBeenCalledTimes(2)
    expect(await fsp.readdir(sourceDir)).toEqual(['foo'])
  })
})

describe('Personal Skill write atomicity', () => {
  it('keeps the previous package intact when an update fails while writing a reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-personal-'))
    const repo = new UserSkillRepository(root)
    const id = await repo.createPersonal({
      name: 'atomic-update',
      description: 'original',
      body: 'original body',
      references: [
        { path: 'keep.txt', dataBase64: Buffer.from('original reference').toString('base64') }
      ]
    })
    const packageRoot = join(root, 'skills', 'personal', 'atomic-update')
    await mkdir(join(packageRoot, 'references', 'write-target'), { recursive: true })
    await writeFile(join(packageRoot, 'references', 'write-target', 'child.txt'), 'occupied')

    await expect(
      repo.updatePersonal(id, {
        name: 'atomic-update',
        description: 'updated',
        body: 'updated body',
        references: [
          {
            path: 'write-target',
            dataBase64: Buffer.from('cannot replace a directory').toString('base64')
          }
        ]
      })
    ).rejects.toThrow()

    await expect(repo.body(id)).resolves.toBe('original body')
    await expect(readFile(join(packageRoot, 'references', 'keep.txt'), 'utf8')).resolves.toBe(
      'original reference'
    )
  })

  it('preserves package files and nested references outside the editor surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-personal-files-'))
    const repo = new UserSkillRepository(root)
    const id = await repo.createPersonal({
      name: 'complete-package',
      description: 'original',
      body: 'original body'
    })
    const packageRoot = join(root, 'skills', 'personal', 'complete-package')
    const script = join(packageRoot, 'scripts', 'run.js')
    const nestedReference = join(packageRoot, 'references', 'guides', 'setup.md')
    await mkdir(join(script, '..'), { recursive: true })
    await mkdir(join(nestedReference, '..'), { recursive: true })
    await writeFile(script, 'console.log("preserved")\n')
    await writeFile(nestedReference, 'preserved reference')

    await repo.updatePersonal(id, {
      name: 'complete-package',
      description: 'updated',
      body: 'updated body',
      references: []
    })

    await expect(readFile(script, 'utf8')).resolves.toBe('console.log("preserved")\n')
  })
})
