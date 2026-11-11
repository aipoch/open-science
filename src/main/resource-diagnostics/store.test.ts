import { link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESOURCE_LOG_LIMIT, ResourceLogStore } from './store'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>())
}))

const directories: string[] = []
const stores: ResourceLogStore[] = []
const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'resource-log-'))
  directories.push(path)
  return path
}
const store = (
  path: string,
  extra: Partial<ConstructorParameters<typeof ResourceLogStore>[0]> = {}
): ResourceLogStore => {
  const value = new ResourceLogStore({
    directory: path,
    windowBytes: 256,
    segmentBytes: 128,
    queueBytes: 2048,
    rateBytes: 2048,
    ...extra
  })
  stores.push(value)
  return value
}
const content = async (path: string, prefix: string): Promise<string> =>
  (
    await Promise.all(
      (await readdir(path))
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => readFile(join(path, name), 'utf8'))
    )
  ).join('')

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const value of stores.splice(0)) await value.close(false)
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('bounded resource journal', () => {
  it('creates missing journal directories beneath the existing owned root', async () => {
    const root = await directory()
    const path = join(root, 'logs', 'resources')
    const journal = store(path, { rootDirectory: root })
    journal.append('{"event":"first"}\n')
    await journal.close(true)
    expect(journal.status.failed).toBe(false)
    expect(await content(path, 'live-')).toContain('first')
  })

  it('rejects a journal outside its declared root without creating it', async () => {
    const root = await directory()
    const outside = await directory()
    const journal = store(join(outside, 'resources'), { rootDirectory: root })
    journal.append('{"event":"test"}\n')
    await journal.close(true)
    expect(journal.status.failed).toBe(true)
    expect(await readdir(outside)).toEqual([])
  })

  it.each(['root', 'logs', 'resources'] as const)(
    'refuses a linked %s directory before creating or changing journal contents',
    async (boundary) => {
      const base = await directory()
      const outside = await directory()
      const root = join(base, 'config')
      const path = join(root, 'logs', 'resources')
      const linked =
        boundary === 'root'
          ? root
          : join(root, 'logs', ...(boundary === 'resources' ? ['resources'] : []))
      await fs.mkdir(dirname(linked), { recursive: true })
      await writeFile(join(outside, 'keep'), 'original')
      await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
      try {
        const journal = store(path, { rootDirectory: root })
        journal.append('{"event":"test"}\n')
        await journal.flush()
        await journal.close(true)
        expect(journal.status.failed).toBe(true)
        expect(await readdir(outside)).toEqual(['keep'])
        expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('original')
      } finally {
        await rm(linked)
      }
    }
  )

  it.each([false, true])(
    'refuses a replaced segment before append (existing: %s)',
    async (existing) => {
      const path = await directory()
      const journal = store(path)
      await journal.flush()
      const segment = join(path, 'live-00000000.jsonl')
      if (existing) {
        journal.append('{"before":true}\n')
        await journal.flush()
        await rm(segment)
      }
      const target = join(await directory(), 'user-data')
      await writeFile(target, 'preserve unrelated data')
      await (process.platform === 'win32' ? link(target, segment) : symlink(target, segment))
      journal.append('{"after":true}\n')
      await journal.flush()
      expect(await readFile(target, 'utf8')).toBe('preserve unrelated data')
      expect(journal.status.failed).toBe(true)
    }
  )

  it('never truncates a replacement target when retrying a partial write', async () => {
    const path = await directory()
    let now = 1000
    const journal = store(path, {
      now: () => now,
      write: async (file, data, position) => {
        await file.write(data, 0, 7, position)
        throw Object.assign(new Error('full'), { code: 'ENOSPC' })
      }
    })
    journal.append('{"before":true}\n')
    await journal.flush()
    expect(journal.status.writeFailures).toBe(1)
    const segment = join(path, 'live-00000000.jsonl')
    await rm(segment)
    const target = join(await directory(), 'user-data')
    await writeFile(target, 'preserve unrelated data')
    await (process.platform === 'win32' ? link(target, segment) : symlink(target, segment))
    now += 1000
    await journal.flush()
    expect(await readFile(target, 'utf8')).toBe('preserve unrelated data')
    expect(journal.status.failed).toBe(true)
  })

  it('pins the opened file when its path is replaced immediately before writing', async () => {
    const path = await directory()
    const segment = join(path, 'live-00000000.jsonl')
    const target = join(await directory(), 'user-data')
    await writeFile(target, 'preserve unrelated data')
    const journal = store(path, {
      write: async (file, data, position) => {
        await rm(segment, { force: true })
        await (process.platform === 'win32' ? link(target, segment) : symlink(target, segment))
        await file.write(data, 0, data.length, position)
      }
    })
    journal.append('{"first":true}\n')
    await journal.flush()
    expect(await readFile(target, 'utf8')).toBe('preserve unrelated data')
    journal.append('{"next":true}\n')
    await journal.flush()
    expect(journal.status.failed).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('preserve unrelated data')
  })

  it('schedules only queued writes, disarms on suspend and preserves queued evidence on resume', async () => {
    vi.useFakeTimers()
    const path = await directory()
    const journal = store(path)
    await journal.flush()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(vi.getTimerCount()).toBe(0)
    journal.append('{"before":true}\n')
    expect(vi.getTimerCount()).toBe(1)
    journal.setSuspended(true)
    expect(vi.getTimerCount()).toBe(0)
    journal.append('{"during":true}\n')
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await journal.flush()
    expect(await content(path, 'live')).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    journal.setSuspended(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    await journal.flush()
    expect(await content(path, 'live')).toContain('"before":true')
    expect(await content(path, 'live')).toContain('"during":true')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])(
    'does not overwrite a linked target inserted before marker creation (previous run: %s)',
    async (previousRun) => {
      const path = await directory()
      const marker = join(path, 'open')
      const target = join(await directory(), 'user-data')
      const original = 'user data must survive diagnostic startup'
      await writeFile(target, original)
      if (previousRun) await writeFile(marker, '1')
      const actualWrite = fs.writeFile
      let inserted = false
      vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
        if (file === marker && !inserted) {
          inserted = true
          await rm(marker, { force: true })
          // Windows hard links exercise real target truncation without elevation; POSIX
          // additionally exercises the exact symlink race from the review.
          await (process.platform === 'win32' ? link(target, marker) : symlink(target, marker))
        }
        return actualWrite(file, data, options)
      })
      const value = store(path)
      value.append('{"run":"new"}\n')
      await value.flush()
      expect(inserted).toBe(true)
      expect(await readFile(target, 'utf8')).toBe(original)
      expect(value.status.failed).toBe(true)
      expect(value.status.pendingBytes).toBe(0)
    }
  )

  it('reserves bounded anomaly capacity when ordinary events exhaust both rate and queue', async () => {
    const path = await directory()
    const value = store(path, {
      queueBytes: 1024,
      rateBytes: 20,
      windowBytes: 1024,
      segmentBytes: 256
    })
    expect(value.append('{"before":1}\n')).toBe(true)
    expect(value.append('{"rate-overflow":1}\n')).toBe(false)
    const line = JSON.stringify({ sample: 'x'.repeat(80) }) + '\n'
    while (value.append(line, false, true)) {
      /* Fill the normal bounded queue. */
    }
    expect(value.append('{"unexpected":1}\n', true)).toBe(true)
    expect(value.status.pendingBytes).toBeLessThanOrEqual(1024)
    await value.flush()
    expect(await content(path, 'incident-')).toContain('unexpected')
  })

  it('begins each rotated segment with an independently readable identity checkpoint', async () => {
    const path = await directory()
    const value = store(path, { windowBytes: 512, segmentBytes: 256 })
    value.setCheckpoint(() => '{"checkpoint":"runtime-session-pid"}\n')
    for (let i = 0; i < 20; i++) {
      value.append(JSON.stringify({ i, data: 'x'.repeat(80) }) + '\n', false, true)
      await value.flush()
    }
    for (const name of (await readdir(path)).filter((name) => name.endsWith('.jsonl'))) {
      expect((await readFile(join(path, name), 'utf8')).split('\n')[0]).toContain('checkpoint')
      expect((await stat(join(path, name))).size).toBeLessThanOrEqual(256)
    }
  })

  it('recovers a partial ENOSPC write after bounded backoff without duplicate or corrupt lines', async () => {
    const path = await directory()
    let now = 1000
    let writes = 0
    const value = store(path, {
      now: () => now,
      write: async (file, data, position) => {
        writes++
        if (writes === 1) {
          await file.write(data, 0, 7, position)
          throw Object.assign(new Error('full'), { code: 'ENOSPC' })
        }
        await file.write(data, 0, data.length, position)
      }
    })
    value.append('{"event":"before"}\n')
    await value.flush()
    await value.flush()
    expect(writes).toBe(1)
    expect(value.status.writeFailures).toBe(1)
    now += 1000
    await value.flush()
    expect(await content(path, 'live-')).toBe('{"event":"before"}\n')
    expect(value.status.pendingBytes).toBe(0)
    expect(value.status.failed).toBe(false)
  })

  it('keeps the production 64 MiB total budget through rotations, seals and restart', async () => {
    const path = await directory()
    const value = new ResourceLogStore({ directory: path })
    stores.push(value)
    const line = JSON.stringify({ data: 'x'.repeat(60 * 1024) }) + '\n'
    const assertBudget = async (): Promise<void> => {
      const sizes = await Promise.all(
        (await readdir(path)).map(async (name) => (await stat(join(path, name))).size)
      )
      expect(sizes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(RESOURCE_LOG_LIMIT)
    }
    for (let i = 0; i < 1200; i++) {
      expect(value.append(line, i === 600, true)).toBe(true)
      if (i % 15 === 14 || i === 600) {
        await value.flush()
        await assertBudget()
      }
    }
    await value.close(false)
    await assertBudget()
    const next = new ResourceLogStore({ directory: path })
    stores.push(next)
    next.append('{"run":"next"}\n')
    await next.close(true)
    await assertBudget()
    expect(await content(path, 'live-')).toContain('next')
    expect(value.status.rotatedBytes).toBeGreaterThan(0)
  })

  it('continuously rolls the live window instead of stopping when full', async () => {
    const path = await directory()
    const value = store(path)
    for (let i = 0; i < 30; i++) {
      expect(value.append(JSON.stringify({ i, data: 'x'.repeat(30) }) + '\n')).toBe(true)
      await value.flush()
    }
    const text = await content(path, 'live-')
    expect(text).toContain('"i":29')
    expect(text).not.toContain('"i":0,')
    const bytes = await Promise.all(
      (await readdir(path)).map(async (name) => (await stat(join(path, name))).size)
    )
    expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(257)
    expect(value.status.rotatedBytes).toBeGreaterThan(0)
  })

  it('preserves an anomaly across clean restarts and records subsequent activity separately', async () => {
    const path = await directory()
    const first = store(path)
    first.append('{"event":"before"}\n')
    first.append('{"event":"unexpected-exit"}\n', true)
    first.append('{"event":"after"}\n')
    await first.close(true)
    expect(await content(path, 'incident-')).toContain('before')
    expect(await content(path, 'incident-')).not.toContain('after')
    const second = store(path)
    second.append('{"event":"next-run"}\n')
    await second.close(true)
    expect(await content(path, 'incident-')).toContain('unexpected-exit')
    expect(await content(path, 'live-')).toContain('next-run')
  })

  it('seals the unclean previous tail before a new run can overwrite it', async () => {
    const path = await directory()
    const first = store(path)
    first.append('{"run":1}\n')
    await first.close(false)
    const second = store(path)
    second.append('{"run":2}\n')
    await second.close(true)
    expect(await content(path, 'incident-')).toContain('"run":1')
    expect(await content(path, 'live-')).toContain('"run":2')
  })

  it('recovers an interrupted seal without deleting already moved evidence', async () => {
    const path = await directory()
    await writeFile(join(path, 'open'), '1')
    await writeFile(join(path, 'seal.pending'), '1')
    await writeFile(join(path, 'incident-00000000.jsonl'), '{"old":1}\n')
    await writeFile(join(path, 'live-00000001.jsonl'), '{"old":2}\n')
    const value = store(path)
    value.append('{"new":1}\n')
    await value.close(true)
    expect(await content(path, 'incident-')).toBe('{"old":1}\n{"old":2}\n')
  })

  it('coalesces an anomaly storm while retaining the first context', async () => {
    const path = await directory()
    let now = 1000
    const value = store(path, { now: () => now })
    value.append('{"first":1}\n', true)
    await value.flush()
    value.append('{"second":1}\n', true)
    await value.flush()
    expect(await content(path, 'incident-')).toContain('first')
    expect(value.status.sealsSuppressed).toBe(1)
    now += 61_000
    value.append('{"later":1}\n', true)
    await value.flush()
    expect(await content(path, 'incident-')).toContain('later')
  })

  it('bounds queue and rate, and preserves unknown files on initialization failure', async () => {
    const path = await directory()
    await writeFile(join(path, 'user-file'), 'preserve')
    const value = store(path, { rateBytes: 20, queueBytes: 20 })
    expect(value.append('{"one":1}\n')).toBe(true)
    expect(value.append('{"two":2222222222}\n')).toBe(false)
    await value.flush()
    expect(value.status.failed).toBe(true)
    expect(await readFile(join(path, 'user-file'), 'utf8')).toBe('preserve')
    expect(value.status.pendingBytes).toBe(0)
  })
})
