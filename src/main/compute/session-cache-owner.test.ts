import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionCacheOwner, withSessionCacheDeletion } from './session-cache-owner'

describe('SessionCacheOwner', () => {
  let storageRoot: string
  let owner: SessionCacheOwner

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-cache-'))
    owner = new SessionCacheOwner(storageRoot)
  })

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('allocates each download below its owning Project and Session', async () => {
    const operation = await owner.createOperationFile('project-1', 'session-1', 'result.csv')

    expect(relative(storageRoot, operation.path).split(sep)).toEqual([
      'compute',
      'session-cache',
      'project-1',
      'session-1',
      expect.any(String),
      'result.csv'
    ])
  })

  it('does not allocate an operation directory for an invalid filename', async () => {
    await expect(owner.createOperationFile('project-1', 'session-1', '')).rejects.toThrow(
      'Invalid Session cache filename'
    )

    await expect(readdir(storageRoot, { recursive: true })).resolves.toEqual([])
  })

  it.each(['Compute', 'Project', 'Session'] as const)(
    'rejects a symlinked %s cache parent without writing outside the data root',
    async (scope) => {
      const outside = await mkdtemp(join(tmpdir(), 'open-science-session-cache-outside-'))
      const cacheRoot = join(storageRoot, 'compute', 'session-cache')
      if (scope === 'Compute') {
        await symlink(
          outside,
          join(storageRoot, 'compute'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      } else {
        await mkdir(cacheRoot, { recursive: true })
      }
      if (scope === 'Project') {
        await symlink(
          outside,
          join(cacheRoot, 'project-1'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      } else if (scope === 'Session') {
        const projectRoot = join(cacheRoot, 'project-1')
        await mkdir(projectRoot)
        await symlink(
          outside,
          join(projectRoot, 'session-1'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }

      try {
        await expect(
          owner.createOperationFile('project-1', 'session-1', 'result.csv')
        ).rejects.toThrow(`Unsafe Session cache ${scope} directory.`)
        await expect(readdir(outside)).resolves.toEqual([])
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    }
  )

  it.each([
    ['Project deletion through a symlinked Compute directory', 'compute', 'project'],
    ['Project deletion through a symlinked cache root', 'cache', 'project'],
    ['Session deletion through a symlinked Project directory', 'project', 'session'],
    ['operation cleanup through a symlinked Session directory', 'session', 'operation']
  ] as const)('rejects %s without deleting external data', async (_label, linkAt, action) => {
    const outside = await mkdtemp(join(tmpdir(), 'open-science-session-cache-delete-outside-'))
    const computeRoot = join(storageRoot, 'compute')
    const cacheRoot = join(computeRoot, 'session-cache')
    const externalFile =
      linkAt === 'compute'
        ? join(outside, 'session-cache', 'project-1', 'session-1', 'operation-1', 'result.csv')
        : linkAt === 'cache'
          ? join(outside, 'project-1', 'session-1', 'operation-1', 'result.csv')
          : linkAt === 'project'
            ? join(outside, 'session-1', 'operation-1', 'result.csv')
            : join(outside, 'operation-1', 'result.csv')

    try {
      await mkdir(dirname(externalFile), { recursive: true })
      await writeFile(externalFile, 'retained')
      if (linkAt === 'compute') {
        await symlink(outside, computeRoot, process.platform === 'win32' ? 'junction' : 'dir')
      } else {
        await mkdir(linkAt === 'cache' ? computeRoot : cacheRoot, { recursive: true })
        const link =
          linkAt === 'cache'
            ? cacheRoot
            : linkAt === 'project'
              ? join(cacheRoot, 'project-1')
              : join(cacheRoot, 'project-1', 'session-1')
        if (linkAt === 'session') await mkdir(dirname(link), { recursive: true })
        await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      }

      const removal =
        action === 'project'
          ? owner.removeProject('project-1')
          : action === 'session'
            ? owner.removeSession('project-1', 'session-1')
            : owner.removeOperation('project-1', 'session-1', 'operation-1')
      await expect(removal).rejects.toThrow('Unsafe Session cache')
      await expect(readFile(externalFile, 'utf8')).resolves.toBe('retained')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects reconciliation through a symlinked cache root without deleting external data', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'open-science-session-cache-reconcile-outside-'))
    const externalFile = join(outside, 'orphan-project', 'orphan-session', 'result.csv')
    await mkdir(join(storageRoot, 'compute'))
    await symlink(
      outside,
      join(storageRoot, 'compute', 'session-cache'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    try {
      await mkdir(dirname(externalFile), { recursive: true })
      await writeFile(externalFile, 'retained')

      await expect(owner.reconcileActiveSessions([])).rejects.toThrow('Unsafe Session cache')
      await expect(readFile(externalFile, 'utf8')).resolves.toBe('retained')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('removes only the deleted Session cache', async () => {
    const removed = await owner.createOperationFile('project-1', 'session-1', 'removed.csv')
    const retained = await owner.createOperationFile('project-1', 'session-2', 'retained.csv')
    await writeFile(removed.path, 'removed')
    await writeFile(retained.path, 'retained')
    removed.release()

    await owner.removeSession('project-1', 'session-1')

    await expect(stat(dirname(removed.path))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(retained.path)).resolves.toMatchObject({ size: 8 })
  })

  it.each(['Session', 'Project'] as const)(
    'rejects late operations after %s cache deletion starts',
    async (scope) => {
      const active = await owner.createOperationFile('project-1', 'session-1', 'active.csv')
      const deleting =
        scope === 'Session'
          ? owner.removeSession('project-1', 'session-1')
          : owner.removeProject('project-1')

      await expect(
        owner.createOperationFile(
          'project-1',
          scope === 'Session' ? 'session-1' : 'session-2',
          'late.csv'
        )
      ).rejects.toThrow('cannot accept new operations')

      active.release()
      await deleting
    }
  )

  it('reconciles crash leftovers only after receiving the complete active Session set', async () => {
    const orphan = await owner.createOperationFile('project-1', 'orphan-session', 'orphan.csv')
    const active = await owner.createOperationFile('project-1', 'active-session', 'active.csv')
    await writeFile(orphan.path, 'orphan')
    await writeFile(active.path, 'active')
    orphan.release()

    await owner.reconcileActiveSessions([{ sessionId: 'active-session', projectId: 'project-1' }])

    await expect(stat(dirname(orphan.path))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(active.path)).resolves.toMatchObject({ size: 6 })
  })

  it('allows later Sessions under a Project whose orphan cache was reconciled', async () => {
    const orphan = await owner.createOperationFile('project-1', 'orphan-session', 'orphan.csv')
    await writeFile(orphan.path, 'orphan')
    orphan.release()

    await owner.reconcileActiveSessions([])

    await expect(stat(dirname(orphan.path))).rejects.toMatchObject({ code: 'ENOENT' })
    const later = await owner.createOperationFile('project-1', 'later-session', 'later.csv')
    expect(relative(storageRoot, later.path).split(sep)).toEqual([
      'compute',
      'session-cache',
      'project-1',
      'later-session',
      expect.any(String),
      'later.csv'
    ])
    later.release()
  })
})

describe('withSessionCacheDeletion', () => {
  it('runs Session and Project cache cleanup only after Compute Job deletion commits', async () => {
    const calls: string[] = []
    const jobs = {
      restoreProjectJobDeletion: vi.fn(async () => undefined),
      prepareSessionJobDeletion: vi.fn(async () => undefined),
      commitSessionJobDeletion: vi.fn(async () => {
        calls.push('jobs-session')
      }),
      prepareProjectJobDeletion: vi.fn(async () => undefined),
      commitProjectJobDeletion: vi.fn(async () => {
        calls.push('jobs-project')
      }),
      abortSessionJobDeletion: vi.fn(async () => undefined),
      abortProjectJobDeletion: vi.fn(async () => undefined),
      reconcileProjectOrphanJobs: vi.fn(async () => undefined)
    }
    const cache = {
      removeSession: vi.fn(async () => {
        calls.push('cache-session')
      }),
      removeProject: vi.fn(async () => {
        calls.push('cache-project')
      })
    }
    const participant = withSessionCacheDeletion(jobs, cache)

    await participant.commitSessionJobDeletion('project-1', 'session-1')
    await participant.commitProjectJobDeletion('project-1')

    expect(calls).toEqual(['jobs-session', 'cache-session', 'jobs-project', 'cache-project'])
  })
})
