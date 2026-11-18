import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { pruneStoredResearchFilms } from './stored-presentation'
import { ManagedPreviewResources } from '../managed-preview-resources'
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
  branchId: string | null = null,
  mode?: 'operation-replay'
): Promise<{ base: string; directory: string }> => {
  const key = createHash('sha256')
    .update(JSON.stringify(['project', sessionId, branchId, ...(mode ? [mode] : [])]))
    .digest('hex')
  const base = join(root, 'research-video-presentations', key),
    id = randomUUID(),
    directory = join(base, id)
  await mkdir(join(directory, 'output'), { recursive: true })
  await writeFile(
    join(directory, 'session.json'),
    JSON.stringify({
      provenance: { projectId: 'project', sessionId, mode, ...(branchId ? { branchId } : {}) }
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

const pending = async (
  root: string,
  sessionId: string,
  marked = true,
  mode?: 'operation-replay'
): Promise<{ directory: string; pointer: string; latest: string }> => {
  const saved = await presentation(root, sessionId, 'branch', mode)
  const id = basename(saved.directory)
  const directory = join(saved.base, 'pending')
  const pointer = join(saved.base, 'pending.json')
  const latest = join(saved.base, 'latest.json')
  await rename(saved.directory, directory)
  await rm(latest)
  await writeFile(
    pointer,
    JSON.stringify({
      version: mode ? 2 : 1,
      mode,
      id,
      conversation: 'a'.repeat(64),
      source: 'b'.repeat(64),
      step: 3,
      startedAt: 1,
      updatedAt: 2,
      attempt: 1
    })
  )
  if (marked)
    await writeFile(
      join(directory, 'pending-owner.json'),
      JSON.stringify({
        version: mode ? 2 : 1,
        mode,
        id,
        projectId: 'project',
        sessionId,
        branchId: 'branch'
      })
    )
  return { directory, pointer, latest }
}

it('reclaims only marked orphan pending jobs during startup reconciliation', async () => {
  const { root } = await fixture()
  const orphan = await pending(root, 'gone')
  const archived = await pending(root, 'archived')
  const legacy = await pending(root, 'legacy', false)
  const mismatched = await pending(root, 'mismatched')
  const pointer = JSON.parse(await readFile(mismatched.pointer, 'utf8'))
  await writeFile(mismatched.pointer, JSON.stringify({ ...pointer, id: randomUUID() }))
  // Keep an older receipt distinct from the pending attempt.
  const oldFilm = JSON.stringify({ id: randomUUID(), title: 'Private', duration: 1 })
  await writeFile(orphan.latest, oldFilm)
  await new Promise((resolve) => setTimeout(resolve, 2))
  const owner = createResearchFilmLifecycle({ dataRoot: () => root })
  const plans = await owner.planSessionReconciliation(['archived'])
  expect(plans.map(({ sessionId }) => sessionId)).toEqual(['gone'])
  await plans[0].apply()
  await expect(lstat(orphan.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(orphan.pointer)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(orphan.latest, 'utf8')).toBe(oldFilm)
  for (const retained of [archived, legacy, mismatched]) {
    expect(await exists(join(retained.directory, 'session.json'))).toBe(true)
    expect(await exists(retained.pointer)).toBe(true)
  }
})

it('reconciles replay checkpoints only when the pointer and owner agree on the mode', async () => {
  const { root } = await fixture()
  const orphan = await pending(root, 'gone', true, 'operation-replay')
  const mismatch = await pending(root, 'mismatch', true, 'operation-replay')
  const pointer = JSON.parse(await readFile(mismatch.pointer, 'utf8'))
  await writeFile(mismatch.pointer, JSON.stringify({ ...pointer, mode: 'research-explanation' }))
  await new Promise((resolve) => setTimeout(resolve, 2))
  const owner = createResearchFilmLifecycle({ dataRoot: () => root })
  const plans = await owner.planSessionReconciliation([])
  expect(plans.map(({ sessionId }) => sessionId)).toEqual(['gone'])
  await plans[0].apply()
  await expect(lstat(orphan.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await exists(mismatch.pointer)).toBe(true)
  expect(await exists(join(mismatch.directory, 'pending-owner.json'))).toBe(true)
})

it('continues orphan cleanup when a published index is oversized', async () => {
  const { root } = await fixture()
  const orphan = await presentation(root, 'gone', 'published')
  const staged = await pending(root, 'gone')
  const live = await presentation(root, 'live')
  const latest = join(orphan.base, 'latest.json')
  const oversized = 'x'.repeat(4097)
  await writeFile(latest, oversized)
  await new Promise((resolve) => setTimeout(resolve, 2))
  const owner = createResearchFilmLifecycle({ dataRoot: () => root })
  const plans = await owner.planSessionReconciliation(['live'])
  expect(plans.map(({ sessionId }) => sessionId)).toEqual(['gone'])
  await plans[0].apply()
  await expect(lstat(orphan.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(staged.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(latest, 'utf8')).toBe(oversized)
  expect(await exists(join(live.directory, 'output/player.html'))).toBe(true)
})

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

it.each(['published', 'pending'] as const)(
  'does not cancel a live film admitted after orphan planning and rejects changed %s evidence',
  async (kind) => {
    const { root } = await fixture()
    const saved =
      kind === 'pending' ? await pending(root, 'gone') : await presentation(root, 'gone')
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
    const receipt = 'pointer' in saved ? saved.pointer : join(saved.directory, 'session.json')
    await writeFile(receipt, '{}')
    await expect(plans[0].apply()).rejects.toThrow('receipt changed')
    expect(await exists(join(saved.directory, 'session.json'))).toBe(true)
    await expect(owner.run('project', 'gone', async () => 'available')).resolves.toBe('available')
  }
)

it('removes both modes for a deleted session while keeping a live session', async () => {
  const { root, owner } = await fixture()
  const explanation = await presentation(root, 'gone', 'branch')
  const replay = await presentation(root, 'gone', 'branch', 'operation-replay')
  const live = await presentation(root, 'live', 'branch', 'operation-replay')
  await owner.deleteSessions(['gone'])
  for (const saved of [explanation, replay])
    expect(await exists(join(saved.directory, 'session.json'))).toBe(false)
  expect(await exists(join(live.directory, 'session.json'))).toBe(true)
})

it('retains the latest two films, defers open outputs and leaves other modes and unproven data alone', async () => {
  const { root } = await fixture()
  const old = await presentation(root, 'session', 'branch', 'operation-replay')
  const pinned = await presentation(root, 'session', 'branch', 'operation-replay')
  const wrong = await presentation(root, 'session', 'branch', 'operation-replay')
  const corrupt = await presentation(root, 'session', 'branch', 'operation-replay')
  const inaccessible = await presentation(root, 'session', 'branch', 'operation-replay')
  const previous = await presentation(root, 'session', 'branch', 'operation-replay')
  const current = await presentation(root, 'session', 'branch', 'operation-replay')
  const explanation = await presentation(root, 'session', 'branch')
  for (const film of [old, pinned, wrong, corrupt, inaccessible, previous, current, explanation])
    await writeFile(join(film.directory, 'output/sources.zip'), 'archive')
  await writeFile(
    join(wrong.directory, 'session.json'),
    JSON.stringify({ provenance: { projectId: 'other', sessionId: 'session' } })
  )
  await writeFile(join(corrupt.directory, 'session.json'), '{invalid json')
  const previews = new ManagedPreviewResources({
    resolvePath: async (_source, request) => request.path
  })
  const path = join(pinned.directory, 'output/player.html')
  const resource = await previews.acquire(1, { source: 'local', path })
  const prune = (): Promise<void> =>
    pruneStoredResearchFilms(
      root,
      { projectId: 'project', sessionId: 'session', branchId: 'branch', mode: 'operation-replay' },
      basename(current.directory),
      basename(previous.directory),
      async (paths, remove) => {
        if (paths.includes(join(inaccessible.directory, 'output/player.html')))
          throw Object.assign(new Error('Removal denied'), { code: 'EACCES' })
        return previews.withUnusedFiles(paths, remove)
      }
    )
  await prune()
  expect(await exists(join(old.directory, 'output/player.html'))).toBe(false)
  for (const film of [pinned, wrong, corrupt, inaccessible, previous, current, explanation])
    expect(await exists(join(film.directory, 'output/player.html'))).toBe(true)
  previews.release(1, { resourceId: resource.id })
  await prune()
  expect(await exists(path)).toBe(false)
})
