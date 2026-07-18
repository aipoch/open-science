import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Wrap the real fs/promises but make `rename` a spy we can fail on demand. Every other call (mkdir,
// writeFile, stat, rm) stays real so the test exercises the actual staging/backup dance on disk.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args))
  }
})

import * as fsp from 'node:fs/promises'
import { UserSkillRepository } from './user-skill-repository'
import type { FetchLike } from './github-import'

const SKILL_URL = 'https://github.com/acme/skills/tree/main/pack/foo'

// The unmocked rename, captured once; each test resets the spy to pass through to it so a prior test's
// failure injection can't leak into the next test's setup.
let realRename: typeof import('node:fs/promises').rename
beforeEach(async () => {
  realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  vi.mocked(fsp.rename).mockImplementation((from, to) => realRename(from, to))
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
})
