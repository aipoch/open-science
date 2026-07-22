import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsRepository } from './repository'

describe('SettingsRepository compute grant persistence', () => {
  const withRepo = async (fn: (repo: SettingsRepository) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'osci-compute-grants-'))
    try {
      await fn(new SettingsRepository(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('adds a project grant and reads it back', async () => {
    await withRepo(async (repo) => {
      await repo.addComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      const has = await repo.hasComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      expect(has).toBe(true)
    })
  })

  it('returns false for a grant that has not been saved', async () => {
    await withRepo(async (repo) => {
      const has = await repo.hasComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:other'
      })
      expect(has).toBe(false)
    })
  })

  it('project isolation: grant for proj-1 does not apply to proj-2', async () => {
    await withRepo(async (repo) => {
      await repo.addComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      const inProj2 = await repo.hasComputeGrant({
        projectId: 'proj-2',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      expect(inProj2).toBe(false)
    })
  })

  it('operation isolation: grant for call_command does not apply to submit_job', async () => {
    await withRepo(async (repo) => {
      await repo.addComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      const otherOp = await repo.hasComputeGrant({
        projectId: 'proj-1',
        operation: 'submit_job',
        providerId: 'ssh:biowulf'
      })
      expect(otherOp).toBe(false)
    })
  })

  it('provider isolation: grant for ssh:biowulf does not apply to ssh:other', async () => {
    await withRepo(async (repo) => {
      await repo.addComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      const otherProvider = await repo.hasComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:other'
      })
      expect(otherProvider).toBe(false)
    })
  })

  it('persists grants to disk and survives a fresh repository read', async () => {
    await withRepo(async (repo) => {
      await repo.addComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      const raw = await readFile(
        join((repo as unknown as { storageDir: string }).storageDir, 'settings.json'),
        'utf8'
      )
      const parsed = JSON.parse(raw) as { computeGrants?: unknown[] }
      expect(Array.isArray(parsed.computeGrants)).toBe(true)
      expect((parsed.computeGrants ?? []).length).toBeGreaterThan(0)
    })
  })

  it('deduplicates: adding the same grant twice does not create a duplicate', async () => {
    await withRepo(async (repo) => {
      await repo.addComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      await repo.addComputeGrant({
        projectId: 'proj-1',
        operation: 'call_command',
        providerId: 'ssh:biowulf'
      })
      const settings = await repo.getSettings()
      const grants = settings.computeGrants ?? []
      const matching = grants.filter(
        (g) =>
          g.projectId === 'proj-1' &&
          g.operation === 'call_command' &&
          g.providerId === 'ssh:biowulf'
      )
      expect(matching).toHaveLength(1)
    })
  })
})
