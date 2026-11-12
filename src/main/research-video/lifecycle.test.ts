import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createResearchFilmLifecycle, type ResearchFilmLifecycle } from './lifecycle'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async (): Promise<{ root: string; owner: ResearchFilmLifecycle }> => {
  const root = await mkdtemp(join(tmpdir(), 'film-lifecycle-'))
  roots.push(root)
  return { root, owner: createResearchFilmLifecycle({ dataRoot: () => root }) }
}
const presentation = async (
  root: string,
  sessionId: string,
  branchId: string | null = null
): Promise<{ base: string; directory: string }> => {
  const key = createHash('sha256')
    .update(JSON.stringify(['project', sessionId, branchId]))
    .digest('hex')
  const base = join(root, 'research-video-presentations', key),
    id = randomUUID(),
    directory = join(base, id)
  await mkdir(join(directory, 'output'), { recursive: true })
  await writeFile(
    join(directory, 'session.json'),
    JSON.stringify({
      provenance: { projectId: 'project', sessionId, ...(branchId ? { branchId } : {}) }
    })
  )
  await writeFile(join(directory, 'output/player.html'), 'private film')
  await writeFile(join(base, 'latest.json'), JSON.stringify({ id, title: 'Private', duration: 1 }))
  return { base, directory }
}
const exists = (path: string): Promise<boolean> =>
  readFile(path).then(
    () => true,
    () => false
  )

it('removes all deleted-session branches and retained tool jobs while preserving other sessions and user exports', async () => {
  const { root, owner } = await fixture()
  const first = await presentation(root, 'deleted')
  const branch = await presentation(root, 'deleted', 'other')
  const retained = await presentation(root, 'archived')
  const id = randomUUID(),
    job = join(root, 'research-video-jobs', id)
  await mkdir(job, { recursive: true })
  await writeFile(
    join(job, 'job.json'),
    JSON.stringify({ schemaVersion: 1, id, projectId: 'project', appSessionId: 'deleted' })
  )
  await writeFile(join(root, 'user-export.mp4'), 'keep')
  await owner.deleteSessions(['deleted'])
  for (const value of [first, branch])
    expect(await exists(join(value.directory, 'session.json'))).toBe(false)
  expect(await exists(join(first.base, 'latest.json'))).toBe(false)
  expect(await exists(join(job, 'job.json'))).toBe(false)
  expect(await exists(join(retained.directory, 'session.json'))).toBe(true)
  expect(await exists(join(root, 'user-export.mp4'))).toBe(true)
  await expect(owner.run('project', 'deleted', async () => undefined)).rejects.toThrow('deleted')
})

it('cancels and drains generation before removing files, and blocks new work after deletion', async () => {
  const { root, owner } = await fixture()
  const saved = await presentation(root, 'session')
  let release!: () => void,
    aborted = false
  const drain = new Promise<void>((resolve) => {
    release = resolve
  })
  const work = owner.run('project', 'session', async (signal) => {
    signal.addEventListener(
      'abort',
      () => {
        aborted = true
      },
      { once: true }
    )
    await drain
    expect(await exists(join(saved.directory, 'session.json'))).toBe(true)
    await writeFile(join(saved.directory, 'output/last.bin'), 'last native write')
  })
  await Promise.resolve()
  const deleting = owner.deleteSessions(['session'])
  await Promise.resolve()
  expect(aborted).toBe(true)
  await expect(owner.run('project', 'session', async () => undefined)).rejects.toThrow('deleted')
  release()
  await Promise.all([work, deleting])
  expect(await exists(join(saved.directory, 'output/last.bin'))).toBe(false)
})

it('recovers interrupted deletion from a complete catalog and retains archived sessions', async () => {
  const { root } = await fixture()
  const deleted = await presentation(root, 'gone')
  const archived = await presentation(root, 'archived')
  // Crash after rename(pending, id), before the pending receipt was unlinked.
  for (const saved of [deleted, archived])
    await writeFile(
      join(saved.base, 'pending.json'),
      JSON.stringify({ version: 1, id: basename(saved.directory) })
    )
  const restarted = createResearchFilmLifecycle({ dataRoot: () => root })
  await restarted.reconcileSessions(['archived'])
  await expect(lstat(deleted.base)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await exists(join(archived.directory, 'session.json'))).toBe(true)
  await restarted.reconcileSessions(['archived'])
})

it('does not follow a linked receipt or remove a directory with mismatched ownership', async () => {
  const { root, owner } = await fixture()
  const linked = await presentation(root, 'linked')
  const outside = join(root, 'outside.json')
  await writeFile(
    outside,
    JSON.stringify({ provenance: { projectId: 'project', sessionId: 'linked' } })
  )
  await rm(join(linked.directory, 'session.json'))
  await symlink(outside, join(linked.directory, 'session.json'))
  const mismatched = await presentation(root, 'expected')
  await writeFile(
    join(mismatched.directory, 'session.json'),
    JSON.stringify({ provenance: { projectId: 'project', sessionId: 'different' } })
  )
  await owner.reconcileSessions([])
  expect(await exists(outside)).toBe(true)
  expect(await exists(join(linked.directory, 'output/player.html'))).toBe(true)
  expect(await exists(join(mismatched.directory, 'output/player.html'))).toBe(true)
})

it('fences project tasks before deletion and restores admission when deletion fails', async () => {
  const { owner } = await fixture()
  let release!: () => void
  const drain = new Promise<void>((resolve) => {
    release = resolve
  })
  let aborted = false,
    deleting = false
  const task = owner.run('project', 'session', async (signal) => {
    signal.addEventListener(
      'abort',
      () => {
        aborted = true
      },
      { once: true }
    )
    await drain
  })
  await Promise.resolve()
  const removal = owner.withProjectStopped('project', async () => {
    deleting = true
    throw new Error('delete failed')
  })
  expect(aborted).toBe(true)
  expect(deleting).toBe(false)
  await expect(owner.run('project', 'another', async () => undefined)).rejects.toThrow('deleted')
  await expect(owner.run('other', 'unrelated', async () => 'ok')).resolves.toBe('ok')
  release()
  await task
  await expect(removal).rejects.toThrow('delete failed')
  await expect(owner.run('project', 'session', async () => 'retry')).resolves.toBe('retry')
})

it('does not wait for a blocked publisher while catalog reconciliation owns the session lock', async () => {
  const { root, owner } = await fixture()
  const saved = await presentation(root, 'gone')
  let release!: () => void
  const publisher = new Promise<void>((resolve) => {
    release = resolve
  })
  let signal!: AbortSignal
  const task = owner.run('project', 'gone', async (next) => {
    signal = next
    await publisher
  })
  await Promise.resolve()
  await expect(owner.reconcileSessions([])).rejects.toThrow('waiting for cancelled work')
  expect(signal.aborted).toBe(true)
  expect(await exists(join(saved.directory, 'session.json'))).toBe(true)
  release()
  await task
  await owner.reconcileSessions([])
  expect(await exists(join(saved.directory, 'session.json'))).toBe(false)
})

it('cleans full conversation snapshots larger than 8 MiB', async () => {
  const { root, owner } = await fixture()
  const saved = await presentation(root, 'expanded')
  await writeFile(
    join(saved.directory, 'session.json'),
    JSON.stringify({
      provenance: { projectId: 'project', sessionId: 'expanded' },
      messages: [{ md: '![image](files/long-checksummed-image-name.png)'.repeat(200000) }]
    })
  )
  await owner.deleteSessions(['expanded'])
  expect(await exists(join(saved.directory, 'session.json'))).toBe(false)
})

it('deletes film files and empty scope directories without writing a deletion record', async () => {
  const { root, owner } = await fixture()
  const { deleteStoredResearchFilms } = await import('./stored-presentation')
  const saved = await presentation(root, 'session')
  await deleteStoredResearchFilms(root, { projectId: 'project', sessionId: 'session' })
  await expect(lstat(saved.base)).rejects.toMatchObject({ code: 'ENOENT' })
  await deleteStoredResearchFilms(root, { projectId: 'project', sessionId: 'session' })
  await owner.deleteSessions(['session'])
  await expect(lstat(saved.base)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes an interrupted stale latest pointer without a deletion record', async () => {
  const { root } = await fixture()
  const { deleteStoredResearchFilms, readStoredResearchFilm } =
    await import('./stored-presentation')
  const saved = await presentation(root, 'session')
  await rm(saved.directory, { recursive: true })
  const request = { projectId: 'project', sessionId: 'session' }
  expect(await readStoredResearchFilm(root, request)).toBeUndefined()
  await deleteStoredResearchFilms(root, request)
  await expect(lstat(saved.base)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects imported-film symlinks without deleting local films and allows an explicit retry', async () => {
  const { root } = await fixture()
  const { deleteStoredResearchFilms } = await import('./stored-presentation')
  const saved = await presentation(root, 'session')
  const id = saved.directory.split(/[\\/]/).at(-1)!
  const outside = join(root, 'user-saved')
  await mkdir(outside)
  await writeFile(join(outside, 'player.html'), 'keep')
  const parent = join(root, 'artifacts', 'project', 'session', '.research-films')
  await mkdir(parent, { recursive: true })
  await symlink(outside, join(parent, id), process.platform === 'win32' ? 'junction' : 'dir')
  const request = { projectId: 'project', sessionId: 'session' }
  await expect(deleteStoredResearchFilms(root, request, id)).rejects.toThrow('Unsafe imported')
  expect(await exists(join(saved.base, 'deleted.json'))).toBe(false)
  expect(await exists(join(saved.directory, 'output/player.html'))).toBe(true)
  expect(await readFile(join(outside, 'player.html'), 'utf8')).toBe('keep')
  await rm(join(parent, id))
  await deleteStoredResearchFilms(root, request, id)
  await expect(lstat(saved.base)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(outside, 'player.html'), 'utf8')).toBe('keep')
})

it('does not cancel a live film admitted after orphan planning and rejects changed owner evidence', async () => {
  const { root } = await fixture()
  const saved = await presentation(root, 'gone')
  await new Promise((resolve) => setTimeout(resolve, 2))
  const owner = createResearchFilmLifecycle({ dataRoot: () => root })
  const plans = await owner.planSessionReconciliation([])
  expect(plans).toHaveLength(1)
  let release!: () => void
  let aborted = false
  const live = owner.run('project', 'gone', async (signal) => {
    signal.addEventListener('abort', () => {
      aborted = true
    })
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await Promise.resolve()
  await expect(plans[0].apply()).rejects.toThrow('live work')
  expect(aborted).toBe(false)
  release()
  await live
  await writeFile(
    join(saved.directory, 'session.json'),
    JSON.stringify({ provenance: { projectId: 'project', sessionId: 'new-owner' } })
  )
  await expect(plans[0].apply()).rejects.toThrow('receipt changed')
  expect(await exists(join(saved.directory, 'session.json'))).toBe(true)
  await expect(owner.run('project', 'gone', async () => 'available')).resolves.toBe('available')
})
