import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

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
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      if (String(from).includes('.import-')) throw new Error('simulated swap failure')
      return actual.rename(from, to)
    })

    await expect(
      repo.importFromGitHub(SKILL_URL, fetchSkill('---\nname: Foo\n---\nnew body'))
    ).rejects.toThrow(/simulated swap failure/)

    // The failed swap left the previous skill intact — not deleted, not half-written.
    expect(await repo.body(first.id)).toContain('old body')
  })
})
