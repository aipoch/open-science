import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJournalAgentStore } from './journal-store'
import { openAgentSession, type AgentSession } from './session'
import type {
  AgentCheckpoint,
  AgentEvent,
  AgentModel,
  AgentTool,
  ModelEvent
} from './session-types'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    open: vi.fn(actual.open),
    stat: vi.fn(actual.stat)
  }
})

let directory: string
const seed = (): AgentCheckpoint => ({
  version: 1,
  sessionId: 'session',
  revision: 0,
  messages: [],
  compactions: [],
  requests: [],
  pending: []
})
const append = (state: AgentCheckpoint, text = 'evidence'): AgentCheckpoint => ({
  ...state,
  revision: state.revision + 1,
  messages: [
    ...state.messages,
    { id: `message-${state.revision}`, role: 'user', content: [{ type: 'text', text }] }
  ]
})
const file = (extension: string): string =>
  join(directory, createHash('sha256').update('session').digest('hex') + extension)
const done: ModelEvent = {
  type: 'finish',
  reason: 'complete',
  content: [{ type: 'text', text: 'done' }]
}
const call: ModelEvent = {
  type: 'finish',
  reason: 'tools',
  content: [],
  calls: [{ id: 'call', name: 'work', arguments: {} }]
}
const result = { content: [{ type: 'text' as const, text: 'result' }] }
const model: AgentModel = {
  id: 'fixture',
  capabilities: { tools: true, images: false, files: false },
  async *stream(request) {
    yield request.messages.at(-1)?.role === 'user' ? call : done
  }
}
const tool = (execute: AgentTool['execute']): AgentTool => ({
  name: 'work',
  version: '1',
  description: 'work',
  parameters: { type: 'object' },
  validate: (args) => args,
  authorize: async () => true,
  execute
})
const setup = (
  execute: AgentTool['execute'],
  onEvent?: (event: AgentEvent) => void
): Promise<AgentSession> =>
  openAgentSession({
    sessionId: 'session',
    store: createJournalAgentStore({ directory, snapshotMinRevisions: 4 }),
    model,
    tools: [tool(execute)],
    maxSteps: 4,
    maxOutputTokens: 64,
    onEvent
  })

beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile)
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat)
  directory = await fs.mkdtemp(join(tmpdir(), 'agent-journal-'))
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

describe('journal CAS and snapshots', () => {
  it.each([1, 7, 256 * 1024])(
    'restores UTF-8 records with %i-byte reads without loading the whole journal string',
    async (chunk) => {
      const store = createJournalAgentStore({ directory, snapshotMinRevisions: 100 })
      await store.commit('session', null, seed())
      const first = append(seed(), '证🧪\\nline\n'.repeat(8))
      await store.commit('session', 0, first)
      const next = append(first, 'tail')
      await store.commit('session', 1, next)
      const actual = await vi.importActual<typeof fs>('node:fs/promises')
      vi.mocked(fs.readFile).mockClear()
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args)
        if (args[1] === 'r' && String(args[0]).endsWith('.jsonl')) {
          const read = handle.read.bind(handle)
          vi.spyOn(handle, 'read').mockImplementation(async (...values) => {
            if (Buffer.isBuffer(values[0]))
              return read(values[0], 0, Math.min(chunk, values[0].byteLength), null)
            return read(...values)
          })
        }
        return handle
      })
      const cold = createJournalAgentStore({ directory })
      const restored = await cold.load('session')
      expect(restored).toEqual(next)
      expect(await cold.load('session')).toBe(restored)
      expect(
        vi.mocked(fs.readFile).mock.calls.some(([path]) => String(path).endsWith('.jsonl'))
      ).toBe(false)
      const tail = append(next, 'after recovery')
      expect(await cold.commit('session', 2, tail)).toBe(true)
      expect(await createJournalAgentStore({ directory }).load('session')).toEqual(tail)
    }
  )

  it('closes a cold journal and releases the lock after a malformed record', async () => {
    await createJournalAgentStore({ directory }).commit('session', null, seed())
    await fs.appendFile(file('.jsonl'), '\n')
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    const closed = vi.fn()
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[1] === 'r' && String(args[0]).endsWith('.jsonl')) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          closed()
          await close()
        })
      }
      return handle
    })
    await expect(createJournalAgentStore({ directory }).load('session')).rejects.toThrow(
      'Invalid agent journal record'
    )
    expect(closed).toHaveBeenCalledOnce()
    await expect(fs.stat(file('.journal.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps concurrent large histories warm within the session-count bound', async () => {
    const store = createJournalAgentStore({ directory })
    const active: AgentCheckpoint[] = []
    for (let index = 0; index < 8; index++) {
      const state: AgentCheckpoint = {
        ...seed(),
        sessionId: `large-${index}`,
        messages: [
          { id: 'u', role: 'user', content: [{ type: 'text', text: 'e'.repeat(5 * 1024 * 1024) }] }
        ]
      }
      await store.commit(state.sessionId, null, state)
      active.push((await store.load(state.sessionId))!)
    }
    vi.mocked(fs.readFile).mockClear()
    for (const state of active) expect(await store.load(state.sessionId)).toBe(state)
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.some(([path]) => /\.(jsonl|snapshot\.json)$/.test(String(path)))
    ).toBe(false)
  }, 30_000)

  it('bounds retained bytes, skips oversized entries and preserves small cached sessions', async () => {
    const store = createJournalAgentStore({ directory, maxCacheBytes: 1024 })
    const small = { ...seed(), sessionId: 'small' }
    const big = { ...append(seed(), 'x'.repeat(2048)), sessionId: 'big', revision: 0 }
    expect(await store.commit('small', null, small)).toBe(true)
    const held = await store.load('small')
    expect(await store.commit('big', null, big)).toBe(true)
    const cold = await store.load('big')
    expect(await store.load('big')).toEqual(cold)
    expect(await store.load('big')).not.toBe(cold)
    expect(await store.load('small')).toBe(held)
    // Growing an existing entry removes its old retained footprint as well.
    expect(await store.commit('small', 0, append(held!, 'y'.repeat(2048)))).toBe(true)
    const grown = await store.load('small')
    expect(await store.load('small')).not.toBe(grown)
    expect(await store.commit('small', 0, append(held!, 'stale'))).toBe(false)
  })

  it('evicts by byte allowance before reaching the entry count limit', async () => {
    const writer = createJournalAgentStore({ directory })
    for (const sessionId of ['one', 'two', 'three'])
      await writer.commit(sessionId, null, { ...seed(), sessionId })
    const journalBytes = await Promise.all(
      ['one', 'two', 'three'].map(
        async (id) =>
          (await fs.stat(join(directory, createHash('sha256').update(id).digest('hex') + '.jsonl')))
            .size
      )
    )
    const store = createJournalAgentStore({
      directory,
      maxCacheBytes: 4 * Math.max(...journalBytes)
    })
    const one = await store.load('one')
    const two = await store.load('two')
    expect(await store.load('one')).toBe(one)
    await store.load('three')
    expect(await store.load('one')).toBe(one)
    expect(await store.load('two')).not.toBe(two)
  })

  it('supports uncached durable reads and rejects invalid byte allowances', async () => {
    for (const maxCacheBytes of [-1, 0.5, Infinity, NaN])
      expect(() => createJournalAgentStore({ directory, maxCacheBytes })).toThrow('Invalid')
    const store = createJournalAgentStore({ directory, maxCacheBytes: 0 })
    await store.commit('session', null, seed())
    const before = await store.load('session')
    expect(await store.load('session')).toEqual(before)
    expect(await store.load('session')).not.toBe(before)
    expect(await store.commit('session', 0, append(before!))).toBe(true)
    await store.delete('session')
    expect(await store.load('session')).toBeUndefined()
  })

  it('evicts older session caches while preserving recent reads, CAS and durable history', async () => {
    const store = createJournalAgentStore({ directory })
    let older: AgentCheckpoint | undefined
    for (let index = 0; index < 16; index++) {
      const id = `session-${index}`
      expect(await store.commit(id, null, { ...seed(), sessionId: id })).toBe(true)
      if (index === 1) older = await store.load(id)
    }
    const recent = await store.load('session-0')
    await store.commit('session-16', null, { ...seed(), sessionId: 'session-16' })
    // The touched entry is still cached; the least recently used one is re-decoded from disk.
    expect(await store.load('session-0')).toBe(recent)
    vi.mocked(fs.readFile).mockClear()
    const evicted = await store.load('session-1')
    expect(evicted).toEqual({ ...seed(), sessionId: 'session-1' })
    expect(evicted).not.toBe(older)
    const other = createJournalAgentStore({ directory })
    expect(await other.commit('session-1', 0, append(evicted!))).toBe(true)
    expect(await store.commit('session-1', 0, append(evicted!, 'stale'))).toBe(false)
    expect((await store.load('session-1'))?.messages).toHaveLength(1)
  })

  it('preserves optional inbox presence and run removal across delta replay', async () => {
    const store = createJournalAgentStore({ directory })
    await store.commit('session', null, seed())
    const active: AgentCheckpoint = {
      ...seed(),
      revision: 1,
      inbox: [],
      run: { id: 'run', kind: 'turn', status: 'complete' }
    }
    await store.commit('session', 0, active)
    expect(await createJournalAgentStore({ directory }).load('session')).toEqual(active)
    const cleared = { ...seed(), revision: 2 }
    await store.commit('session', 1, cleared)
    expect(await createJournalAgentStore({ directory }).load('session')).toEqual(cleared)
  })
  it('isolates mutable input, returns immutable state, and observes external revisions', async () => {
    const a = createJournalAgentStore({ directory })
    const b = createJournalAgentStore({ directory })
    expect(await a.load('session')).toBeUndefined()
    expect(await a.commit('session', null, seed())).toBe(true)
    const next = append(seed())
    const writing = a.commit('session', 0, next)
    next.messages[0].content[0] = { type: 'text', text: 'mutated' }
    expect(await writing).toBe(true)
    const loaded = (await b.load('session'))!
    expect(loaded.messages[0].content[0]).toEqual({ type: 'text', text: 'evidence' })
    expect(() => {
      loaded.messages.length = 0
    }).toThrow()
    expect(await b.commit('session', 1, append(loaded, 'external'))).toBe(true)
    expect((await a.load('session'))?.revision).toBe(2)
    expect(await a.commit('session', 1, append(loaded))).toBe(false)
  })

  it('has one winner for concurrent creation and revision CAS across independent owners', async () => {
    const stores = [createJournalAgentStore({ directory }), createJournalAgentStore({ directory })]
    expect(
      (await Promise.all(stores.map((store) => store.commit('session', null, seed())))).sort()
    ).toEqual([false, true])
    const outcomes = await Promise.all(
      stores.map((store, index) => store.commit('session', 0, append(seed(), String(index))))
    )
    expect(outcomes.sort()).toEqual([false, true])
    expect((await stores[0].load('session'))?.revision).toBe(1)
  })

  it('rotates and reopens snapshots, preserving replacements as well as appends', async () => {
    const writes: { kind: string; bytes: number }[] = []
    const store = createJournalAgentStore({
      directory,
      snapshotMinRevisions: 2,
      onWrite: (event) => {
        writes.push(event)
      }
    })
    let state = seed()
    await store.commit('session', null, state)
    for (let index = 0; index < 10; index++) {
      const next = append(state, 'large evidence '.repeat(100))
      await store.commit('session', state.revision, next)
      state = next
      expect(await createJournalAgentStore({ directory }).load('session')).toEqual(state)
    }
    expect(writes.filter((write) => write.kind === 'snapshot').length).toBeGreaterThan(1)
    const replaced = {
      ...state,
      revision: state.revision + 1,
      messages: state.messages.slice(0, 1)
    }
    await store.commit('session', state.revision, replaced)
    expect(await createJournalAgentStore({ directory }).load('session')).toEqual(replaced)
  })

  it.each(['snapshot', 'journal'])(
    'can reopen after %s publication fails following a durable append',
    async (phase) => {
      const store = createJournalAgentStore({ directory, snapshotMinRevisions: 1 })
      await store.commit('session', null, seed())
      const actual = await vi.importActual<typeof fs>('node:fs/promises')
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (String(to).endsWith(phase === 'journal' ? '.jsonl' : '.snapshot.json'))
          throw new Error('publication failed')
        return actual.rename(from, to)
      })
      const next = append(seed(), 'large evidence '.repeat(100))
      await expect(store.commit('session', 0, next)).rejects.toThrow('publication failed')
      expect(await createJournalAgentStore({ directory }).load('session')).toEqual(next)
      expect(await store.commit('session', 0, next)).toBe(false)
    }
  )

  it('reports append fsync failure as uncertain, without replaying the accepted record', async () => {
    const store = createJournalAgentStore({ directory })
    await store.commit('session', null, seed())
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[1] === 'a') vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed'))
      return handle
    })
    const next = append(seed())
    await expect(store.commit('session', 0, next)).rejects.toThrow('sync failed')
    expect(await createJournalAgentStore({ directory }).load('session')).toEqual(next)
    expect(await store.commit('session', 0, next)).toBe(false)
  })

  it.each(['partial', 'checksum', 'gap', 'session', 'orphan'])(
    'rejects %s journal damage even with a warm cache',
    async (damage) => {
      const store = createJournalAgentStore({ directory })
      await store.commit('session', null, seed())
      await store.commit('session', 0, append(seed()))
      const lines = (await fs.readFile(file('.jsonl'), 'utf8')).trimEnd().split('\n')
      const last = JSON.parse(lines[1])
      if (damage === 'checksum') last.hash = 'bad'
      else if (damage === 'gap') last.record.revision++
      else if (damage === 'session') last.record.sessionId = 'another-session'
      else if (damage === 'orphan')
        last.record.arrays.messages.items[0] = {
          id: 'orphan',
          role: 'tool',
          invocationId: 'missing',
          content: []
        }
      if (damage !== 'checksum')
        last.hash = createHash('sha256').update(JSON.stringify(last.record)).digest('hex')
      lines[1] = JSON.stringify(last)
      await fs.writeFile(file('.jsonl'), lines.join('\n') + (damage === 'partial' ? '' : '\n'))
      await expect(store.load('session')).rejects.toThrow()
      await expect(store.commit('session', 1, append(append(seed())))).rejects.toThrow()
    }
  )

  it('rejects equal-size journal corruption when all stat metadata stays unchanged', async () => {
    const store = createJournalAgentStore({ directory })
    await store.commit('session', null, seed())
    await store.commit('session', 0, append(seed()))
    const stamp = await fs.stat(file('.jsonl'), { bigint: true })
    vi.mocked(fs.stat).mockResolvedValue(stamp)
    // Warm the old metadata cache with the same values returned after corruption.
    expect((await store.load('session'))?.revision).toBe(1)
    const original = await fs.readFile(file('.jsonl'), 'utf8')
    const damaged = original.replace('evidence', 'tampered')
    expect(Buffer.byteLength(damaged)).toBe(Buffer.byteLength(original))
    expect(damaged).not.toBe(original)
    await fs.writeFile(file('.jsonl'), damaged)
    await expect(store.load('session')).rejects.toThrow()
    await expect(store.commit('session', 1, append(append(seed())))).rejects.toThrow()
    expect(await fs.readFile(file('.jsonl'), 'utf8')).toBe(damaged)
  })

  it('verifies warm Unicode history in bounded buffers without reading full strings', async () => {
    const store = createJournalAgentStore({ directory, snapshotMinRevisions: 1 })
    await store.commit('session', null, seed())
    const large = append(seed(), '证🧪'.repeat(100_000))
    await store.commit('session', 0, large)
    const next = append(large, 'tail')
    await store.commit('session', 1, next)
    vi.mocked(fs.readFile).mockClear()
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    const lengths: number[] = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[1] === 'r') {
        const read = handle.read.bind(handle)
        vi.spyOn(handle, 'read').mockImplementation(async (...values) => {
          if (ArrayBuffer.isView(values[0])) lengths.push(values[0].byteLength)
          return read(...values)
        })
      }
      return handle
    })
    expect(await store.load('session')).toEqual(next)
    expect(lengths.length).toBeGreaterThan(3)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(256 * 1024)
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.some(
          ([path]) => String(path).endsWith('.snapshot.json') || String(path).endsWith('.jsonl')
        )
    ).toBe(false)
    expect(await createJournalAgentStore({ directory }).load('session')).toEqual(next)
  })

  it('closes the verification handle after a read error and retries without trusting the cache', async () => {
    const store = createJournalAgentStore({ directory })
    await store.commit('session', null, seed())
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    const close = vi.fn()
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[1] === 'r' && String(args[0]).endsWith('.jsonl')) {
        vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('read failed'))
        const originalClose = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          close()
          await originalClose()
        })
      }
      return handle
    })
    await expect(store.load('session')).rejects.toThrow('read failed')
    expect(close).toHaveBeenCalledOnce()
    vi.mocked(fs.open).mockImplementation(actual.open)
    expect(await store.load('session')).toEqual(seed())
  })

  it('rejects equal-size snapshot damage after streaming a warm cache', async () => {
    const store = createJournalAgentStore({ directory, snapshotMinRevisions: 1 })
    await store.commit('session', null, seed())
    const next = append(seed(), '证🧪'.repeat(100_000))
    await store.commit('session', 0, next)
    expect(await store.load('session')).toEqual(next)
    const original = await fs.readFile(file('.snapshot.json'), 'utf8')
    const damaged = original.replace('证', '坏')
    expect(Buffer.byteLength(damaged)).toBe(Buffer.byteLength(original))
    await fs.writeFile(file('.snapshot.json'), damaged)
    await expect(store.load('session')).rejects.toThrow('Invalid agent journal record')
    await expect(store.commit('session', 1, append(next))).rejects.toThrow()
  })

  it('does not cache corrupted append bytes as if they matched the committed checkpoint', async () => {
    const store = createJournalAgentStore({ directory })
    await store.commit('session', null, seed())
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[1] === 'a') {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...values) => {
          await write(...values)
          const raw = await actual.readFile(file('.jsonl'), 'utf8')
          await actual.writeFile(file('.jsonl'), raw.replace('evidence', 'tampered'))
        })
      }
      return handle
    })
    await store.commit('session', 0, append(seed()))
    await expect(store.load('session')).rejects.toThrow('Invalid agent journal record')
    await expect(store.commit('session', 1, append(append(seed())))).rejects.toThrow()
  })

  it('does not steal a stale lock or let observer errors change commit success', async () => {
    const store = createJournalAgentStore({
      directory,
      lockTimeoutMs: 100,
      onWrite: () => {
        throw new Error('observer')
      }
    })
    await store.commit('session', null, seed())
    await fs.writeFile(file('.journal.lock'), '')
    await expect(store.load('session')).rejects.toThrow('lock timeout')
    expect(await fs.readFile(file('.journal.lock'), 'utf8')).toBe('')
  })
})

describe('journal session lifecycle', () => {
  it('persists steering during tool execution and consumes it once', async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.fn(async () => {
      enter()
      await gate
      return result
    })
    const session = await setup(execute)
    const running = session.prompt([{ type: 'text', text: 'first' }])
    await entered
    await session.steer([{ type: 'text', text: 'follow-up' }])
    expect((await createJournalAgentStore({ directory }).load('session'))?.inbox).toHaveLength(1)
    release()
    expect(await running).toBe('complete')
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await session.snapshot()).inbox).toEqual([])
    await session.dispose()
  })

  it('poisons a session after a lost started-write acknowledgement and requires recovery', async () => {
    const disk = createJournalAgentStore({ directory })
    const execute = vi.fn(async () => result)
    const first = await openAgentSession({
      sessionId: 'session',
      model,
      tools: [tool(execute)],
      maxSteps: 4,
      maxOutputTokens: 64,
      store: {
        load: disk.load,
        commit: async (id, revision, next) => {
          const accepted = await disk.commit(id, revision, next)
          if (next.pending.some((pending) => pending.status === 'started'))
            throw new Error('lost acknowledgement')
          return accepted
        }
      }
    })
    await expect(first.prompt([{ type: 'text', text: 'work' }])).rejects.toThrow(
      'lost acknowledgement'
    )
    await expect(first.continue()).rejects.toThrow('uncertain checkpoint')
    expect(execute).not.toHaveBeenCalled()
    await first.dispose()
    const second = await setup(execute)
    await expect(second.continue()).rejects.toThrow('explicit recovery')
    await second.recover((await second.snapshot()).run!.id)
    expect((await second.snapshot()).pending[0].status).toBe('unknown')
    await expect(second.continue()).rejects.toThrow('Reconcile')
    await second.dispose()
  })
  it('keeps observer checkpoints immutable and old history shared across updates', async () => {
    const checkpoints: AgentCheckpoint[] = []
    const session = await setup(
      async () => result,
      (event) => {
        if (event.type === 'checkpoint') checkpoints.push(event.checkpoint)
      }
    )
    expect(await session.prompt([{ type: 'text', text: 'work' }])).toBe('complete')
    expect(checkpoints.at(-1)?.messages).toHaveLength(4)
    expect(checkpoints[0].messages).toHaveLength(1)
    expect(checkpoints.at(-1)?.messages[0]).toBe(checkpoints[0].messages[0])
    expect(() => {
      checkpoints[0].messages[0].content.push({ type: 'text', text: 'injection' })
    }).toThrow()
    await session.dispose()
  })

  it.each(['waiting', 'unknown'])(
    'reopens %s without repeating an effect, then forks independently',
    async (status) => {
      const execute = vi.fn(async () => {
        if (status === 'unknown') throw new Error('disconnected after effect')
        return { waiting: { question: 'continue?' } }
      })
      const first = await setup(execute)
      const running = first.prompt([{ type: 'text', text: 'work' }])
      if (status === 'unknown') await expect(running).rejects.toThrow('disconnected')
      else expect(await running).toBe('waiting')
      const pending = (await first.snapshot()).pending[0]
      expect(pending.status).toBe(status)
      await first.dispose()
      const second = await setup(execute)
      if (status === 'unknown') await second.reconcile(pending.invocationId, result)
      else await second.respond(pending.invocationId, result)
      expect(await second.continue()).toBe('complete')
      expect(execute).toHaveBeenCalledOnce()
      const fork = await second.fork('child')
      expect(fork.messages).toHaveLength(4)
      expect(await createJournalAgentStore({ directory }).load('child')).toEqual(fork)
      await second.dispose()
    }
  )

  it('fences a late worker after explicit recovery and retains the uncertain effect', async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.fn(async () => {
      enter()
      await gate
      return result
    })
    const first = await setup(execute)
    const late = first.prompt([{ type: 'text', text: 'work' }]).catch((error: Error) => error)
    await entered
    const state = await first.snapshot()
    const second = await setup(execute)
    await second.recover(state.run!.id)
    release()
    expect(await late).toBeInstanceOf(Error)
    expect((await second.snapshot()).pending[0].status).toBe('unknown')
    await second.reconcile(state.pending[0].invocationId, result)
    expect(await second.continue()).toBe('complete')
    expect(execute).toHaveBeenCalledOnce()
    await first.dispose()
    await second.dispose()
  })
})

it('permanently deletes checkpoint content and fences stale and fresh writers across instances', async () => {
  const store = createJournalAgentStore({ directory, snapshotMinRevisions: 1 })
  const stale = createJournalAgentStore({ directory })
  await store.commit('session', null, seed())
  await store.commit('session', 0, append(seed(), 'private transcript'))
  const held = (await stale.load('session'))!
  await store.delete('session')
  expect(await stale.load('session')).toBeUndefined()
  expect(await stale.commit('session', held.revision, append(held))).toBe(false)
  expect(await stale.commit('session', null, seed())).toBe(false)
  expect(await fs.readdir(directory)).toEqual([file('.jsonl.deleted').split(/[\\/]/).at(-1)])
  await createJournalAgentStore({ directory }).delete('session')
  const other = { ...seed(), sessionId: 'other' }
  expect(await store.commit('other', null, other)).toBe(true)
  expect(await store.load('other')).toEqual(other)
})
