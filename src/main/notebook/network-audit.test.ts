import { mkdtemp, readFile, readdir, writeFile, mkdir, symlink, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NotebookNetworkAudit, readNetworkAudit } from './network-audit'

const day = 86_400_000
const entry = {
  mode: 'strict' as const,
  projectId: 'project-a',
  sessionId: 'session-a',
  notebookRunId: 'run-a',
  runtime: 'python',
  host: 'example.org',
  port: 443,
  protocol: 'https' as const,
  decision: 'allowed' as const,
  requestId: 'request-a'
}
const setup = async (): Promise<{
  root: string
  store: NotebookNetworkAudit
  advance: (n: number) => void
}> => {
  const root = await mkdtemp(join(tmpdir(), 'network-audit-'))
  let now = Date.UTC(2026, 10, 12, 12)
  const store = new NotebookNetworkAudit(root, { now: () => now, schedule: false })
  await store.ready
  return {
    root,
    store,
    advance: (n: number) => {
      now += n * day
    }
  }
}

describe('Notebook network audit', () => {
  it('appends system-format records by UTC day with immutable mode and run attribution', async () => {
    const { root, store, advance } = await setup()
    store.record(entry)
    await store.flush()
    const path = join(root, 'logs/network/notebook-2026-11-12.log')
    const first = await readFile(path, 'utf8')
    expect(JSON.parse(first)).toMatchObject({
      t: '2026-11-12T12:00:00.000Z',
      scope: 'notebook:network',
      data: entry
    })
    advance(1)
    store.record({ ...entry, mode: 'relaxed', notebookRunId: 'run-b' })
    await store.flush()
    expect(await readFile(path, 'utf8')).toBe(first)
    expect(
      (await store.query({ mode: 'strict' })).records.map((r) => r.data.notebookRunId)
    ).toEqual(['run-a'])
    expect(
      (await store.query({ mode: 'relaxed' })).records.map((r) => r.data.notebookRunId)
    ).toEqual(['run-b'])
  })
  it('paginates newest first without duplicates and combines exact identity filters', async () => {
    const { store } = await setup()
    for (let i = 0; i < 5; i++) store.record({ ...entry, notebookRunId: `run-${i}` })
    const first = await store.query({ limit: 2 })
    expect(first.records.map((r) => r.data.notebookRunId)).toEqual(['run-4', 'run-3'])
    store.record({ ...entry, notebookRunId: 'later' })
    const second = await store.query({ limit: 2, cursor: first.cursor })
    expect(second.records.map((r) => r.data.notebookRunId)).toEqual(['run-2', 'run-1'])
    expect((await store.query({ projectId: 'project-a', sessionId: 'wrong' })).records).toEqual([])
    await expect(store.query({ cursor: '../../settings.json' })).rejects.toThrow()
  })
  it('cleans only fully expired inactive files, at most every three days, across restarts', async () => {
    const { root, store, advance } = await setup()
    await store.setRetention(1)
    store.record(entry)
    await store.flush()
    advance(2)
    await store.cleanup()
    expect(await readdir(join(root, 'logs/network'))).toContain('notebook-2026-11-12.log')
    advance(1)
    await store.cleanup()
    expect(await readdir(join(root, 'logs/network'))).not.toContain('notebook-2026-11-12.log')
    const next = new NotebookNetworkAudit(root, {
      now: () => Date.UTC(2026, 10, 15, 12),
      schedule: false
    })
    await next.ready
    expect((await next.query({})).retentionDays).toBe(1)
  })
  it('does not delete mixed-age or malformed files based on their first record', async () => {
    const { root, store, advance } = await setup()
    store.record(entry)
    await store.flush()
    const dir = join(root, 'logs/network')
    const old = await readFile(join(dir, 'notebook-2026-11-12.log'), 'utf8')
    const recent = JSON.parse(old)
    recent.t = '2026-11-15T12:00:00.000Z'
    await writeFile(join(dir, 'notebook-2026-11-11.log'), old + JSON.stringify(recent) + '\n')
    await writeFile(join(dir, 'notebook-2026-11-10.log'), old + '{broken\n')
    await store.setRetention(1)
    advance(3)
    await store.cleanup()
    expect(await readdir(dir)).toEqual(
      expect.arrayContaining(['notebook-2026-11-11.log', 'notebook-2026-11-10.log'])
    )
    expect((await store.query({})).warnings.length).toBeGreaterThan(0)
  })
  it('rejects symlinked storage and does not expose or append unexpected payload fields', async () => {
    const { store } = await setup()
    store.record({ ...entry, authorization: 'secret', body: 'secret' } as typeof entry)
    const result = await store.query({})
    expect(JSON.stringify(result.records)).not.toContain('secret')
    const root = await mkdtemp(join(tmpdir(), 'network-audit-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'network-audit-outside-'))
    await mkdir(join(root, 'logs'))
    await symlink(outside, join(root, 'logs/network'))
    const linked = new NotebookNetworkAudit(root, { schedule: false })
    await linked.ready
    linked.record(entry)
    await linked.flush()
    expect(await readdir(outside)).toEqual([])
    expect((await linked.query({})).warnings.length).toBeGreaterThan(0)
  })
})

it('preserves a truncated crash tail without merging the next event into it', async () => {
  const { root, store } = await setup()
  const dir = join(root, 'logs/network')
  await writeFile(join(dir, 'notebook-2026-11-12.log'), '{"unfinished":')
  store.record(entry)
  const result = await store.query({})
  expect(result.records).toHaveLength(1)
  expect(result.records[0].data.notebookRunId).toBe('run-a')
  expect(result.warnings.length).toBeGreaterThan(0)
})
it('never purges using the default retention when the saved policy is unreadable', async () => {
  const { root, store } = await setup()
  store.record(entry)
  await store.flush()
  const dir = join(root, 'logs/network')
  await writeFile(join(dir, 'retention.json'), '{broken')
  const next = new NotebookNetworkAudit(root, {
    schedule: false,
    now: () => Date.UTC(2027, 10, 12)
  })
  await next.ready
  await next.cleanup()
  expect(await readdir(dir)).toContain('notebook-2026-11-12.log')
})

it('persists a write gap after storage recovers and reports it to new readers', async () => {
  const { root, store } = await setup()
  const dir = join(root, 'logs/network')
  const daily = join(dir, 'notebook-2026-11-12.log')
  store.record(entry)
  await store.flush()
  await rename(daily, `${daily}.saved`)
  await mkdir(daily)
  store.record({ ...entry, notebookRunId: 'missing-run' })
  await store.flush()
  expect((await store.query({})).warnings).toContain(
    'Network log recording failed. Some records may be missing.'
  )
  await rm(daily, { recursive: true })
  await rename(`${daily}.saved`, daily)
  expect((await store.query({})).warnings).toContain(
    'Network log recording failed. Some records may be missing.'
  )
  expect((await readNetworkAudit(root, {})).warnings).toContain(
    'Network log recording failed. Some records may be missing.'
  )
  const restarted = new NotebookNetworkAudit(root, { schedule: false })
  await restarted.ready
  expect((await restarted.query({})).warnings).toContain(
    'Network log recording failed. Some records may be missing.'
  )
})

it('continues cleaning later files when an earlier expired file cannot be read', async () => {
  const { root, store, advance } = await setup()
  const dir = join(root, 'logs/network')
  const old = JSON.stringify({
    t: '2026-11-01T00:00:00.000Z',
    level: 'info',
    scope: 'notebook:network',
    msg: 'network access',
    data: entry
  })
  await writeFile(join(dir, 'notebook-2026-11-10.log'), old + '\n')
  await writeFile(join(dir, 'notebook-2026-11-11.log'), old + '\n')
  await rm(join(dir, 'notebook-2026-11-10.log'))
  await mkdir(join(dir, 'notebook-2026-11-10.log'))
  await store.setRetention(1)
  advance(3)
  await store.cleanup()
  expect(await readdir(dir)).toContain('notebook-2026-11-10.log')
  expect(await readdir(dir)).not.toContain('notebook-2026-11-11.log')
  expect((await store.query({})).warnings).toContain(
    'Network log cleanup failed. Older records may remain.'
  )
})

it('keeps reverse pages exact across byte-block boundaries and UTF-8 fields', async () => {
  const { store } = await setup()
  for (let i = 0; i < 600; i++)
    store.record({
      ...entry,
      projectName: '网络审计项目',
      notebookRunId: `run-${i}`,
      outcome: 'completed'
    })
  const runs: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.query({ cursor, limit: 73, decision: 'allowed', outcome: 'completed' })
    expect(page.warnings).toEqual([])
    expect(page.records.every((record) => record.data.projectName === '网络审计项目')).toBe(true)
    runs.push(...page.records.map((record) => record.data.notebookRunId!))
    cursor = page.cursor
  } while (cursor)
  expect(runs).toEqual(Array.from({ length: 600 }, (_, index) => `run-${599 - index}`))
})
