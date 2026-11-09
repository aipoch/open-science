import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createJournalAgentStore,
  openAgentSession,
  type AgentCheckpoint,
  type ModelEvent
} from '@aipoch/agent-harness'

// Only this child interposes fs calls. Every byte, fsync and rename still reaches the real filesystem.
const source = String.raw`
const fs = require('node:fs/promises')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { createJournalAgentStore, openAgentSession } = require('@aipoch/agent-harness')
const [root, point] = process.argv.slice(1)
const directory = join(root, 'store')
const base = join(directory, createHash('sha256').update('session').digest('hex'))
const journal = base + '.jsonl', snapshot = base + '.snapshot.json'
const text = value => [{ type: 'text', text: value }]
const pause = async () => {
  process.send({ point })
  await new Promise(() => { setInterval(() => {}, 1000) })
}
async function main() {
  const seed = await openAgentSession({
    sessionId: 'session', store: createJournalAgentStore({ directory, snapshotMinRevisions: 1000 }),
    maxSteps: 4, maxOutputTokens: 128,
    model: { id: 'crash-fixture', capabilities: { tools: true, images: false, files: false },
      async *stream(request) {
        yield request.messages.at(-1).role === 'tool'
          ? { type: 'finish', reason: 'complete', content: text('done') }
          : { type: 'finish', reason: 'tools', content: [], calls: [{ id: 'once', name: 'append', arguments: {} }] }
      }
    },
    tools: [{ name: 'append', version: '1', description: 'Append once', parameters: { type: 'object' },
      validate: value => value, authorize: async () => true,
      execute: async (_, context) => {
        const receipt = JSON.stringify({ invocationId: context.invocationId, value: 1 })
        const handle = await fs.open(join(root, 'effect.jsonl'), 'a')
        try { await handle.writeFile(receipt + '\n'); await handle.sync() } finally { await handle.close() }
        return { content: text(receipt) }
      }
    }]
  })
  await seed.prompt(text('perform one effect'))
  const before = await seed.snapshot()
  await seed.dispose()
  const next = { ...before, revision: before.revision + 1,
    messages: [...before.messages, { id: 'next-prompt', role: 'user', content: text('pending evidence '.repeat(2000)) }],
    run: { id: 'interrupted-turn', kind: 'turn', status: 'running' },
    requests: [...before.requests, { id: 'interrupted-request', runId: 'interrupted-turn', modelId: 'crash-fixture', status: 'started' }]
  }
  await fs.writeFile(join(root, 'before.json'), JSON.stringify(before))
  await fs.writeFile(join(root, 'next.json'), JSON.stringify(next))
  const originalOpen = fs.open, originalRename = fs.rename
  fs.open = async (file, flags, ...args) => {
    const handle = await originalOpen(file, flags, ...args)
    const path = String(file)
    const append = path === journal && flags === 'a'
    const snapshotTemp = path.startsWith(snapshot + '.') && path.endsWith('.tmp')
    const resetTemp = path.startsWith(journal + '.') && path.endsWith('.tmp')
    const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle)
    handle.writeFile = async (data, ...options) => {
      if ((append && point.startsWith('partial-')) || (snapshotTemp && point === 'snapshot-partial')) {
        const bytes = Buffer.from(data)
        const count = point === 'partial-first-byte' ? 1 : point === 'partial-newline' ? bytes.length - 1 : Math.floor(bytes.length / 2)
        await write(bytes.subarray(0, count))
        await sync()
        await pause()
      }
      return write(data, ...options)
    }
    handle.sync = async () => {
      await sync()
      if ((append && point === 'journal-synced') || (snapshotTemp && point === 'snapshot-temp-synced') || (resetTemp && point === 'reset-temp-synced')) await pause()
    }
    return handle
  }
  fs.rename = async (from, to) => {
    await originalRename(from, to)
    if ((String(to) === snapshot && point === 'snapshot-published') || (String(to) === journal && point === 'reset-published')) await pause()
  }
  await createJournalAgentStore({ directory, snapshotMinRevisions: 1 }).commit('session', before.revision, next)
  throw new Error('Crash barrier was not reached')
}
main().catch(error => { console.error(error); process.exit(1) })
`

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Crash fixture cleanup failed')
})

it.each([
  'partial-first-byte',
  'partial-half',
  'partial-newline',
  'journal-synced',
  'snapshot-partial',
  'snapshot-temp-synced',
  'snapshot-published',
  'reset-temp-synced',
  'reset-published'
])('preserves the journal safety boundary after SIGKILL at %s', async (point) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-journal-crash-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['-e', source, root, point], {
    cwd: process.cwd(),
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stdout!.resume()
  child.stderr!.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192)
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
  cleanup.push(stop)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Crash barrier timeout: ${stderr}`)), 10_000)
    child.once('message', (value) => {
      clearTimeout(timer)
      if ((value as { point: string }).point === point) resolve()
      else reject(new Error('Unexpected crash barrier'))
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Premature exit: ${stderr}`))
    })
  })
  await stop()
  expect(child.signalCode).toBe('SIGKILL')
  const directory = join(root, 'store')
  const base = join(directory, createHash('sha256').update('session').digest('hex'))
  const lock = base + '.journal.lock'
  const journal = base + '.jsonl'
  const before: AgentCheckpoint = JSON.parse(await readFile(join(root, 'before.json'), 'utf8'))
  const next: AgentCheckpoint = JSON.parse(await readFile(join(root, 'next.json'), 'utf8'))
  const effects = await readFile(join(root, 'effect.jsonl'), 'utf8')
  expect(effects.trim().split('\n')).toHaveLength(1)
  expect(before.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
  const store = createJournalAgentStore({ directory, lockTimeoutMs: 100 })
  await expect(store.load('session')).rejects.toThrow('lock timeout')
  expect(await readFile(lock, 'utf8')).toBe('')
  // Host owns this isolated directory and has awaited its worker's exit; only now clear its lock.
  await unlink(lock)
  const contents = await readFile(journal, 'utf8')
  if (point.startsWith('partial-')) {
    expect(contents.endsWith('\n')).toBe(false)
    await expect(store.load('session')).rejects.toThrow('Incomplete agent journal')
    await expect(store.commit('session', before.revision, next)).rejects.toThrow(
      'Incomplete agent journal'
    )
    const dispatch = vi.fn(async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'finish', reason: 'complete', content: [] }
    })
    await expect(
      openAgentSession({
        sessionId: 'session',
        store,
        maxSteps: 2,
        maxOutputTokens: 64,
        model: {
          id: 'no-dispatch',
          capabilities: { tools: false, images: false, files: false },
          stream: dispatch
        }
      })
    ).rejects.toThrow('Incomplete agent journal')
    expect(dispatch).not.toHaveBeenCalled()
    expect(await readFile(journal, 'utf8')).toBe(contents)
  } else {
    expect(await store.load('session')).toEqual(next)
    expect(await store.commit('session', before.revision, next)).toBe(false)
    if (point === 'reset-published') expect(contents).toBe('')
    else expect(contents.length).toBeGreaterThan(0)
    if (['snapshot-partial', 'snapshot-temp-synced', 'reset-temp-synced'].includes(point))
      expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(true)
    const execute = vi.fn(async () => {
      throw new Error('Must not repeat a confirmed effect')
    })
    const session = await openAgentSession({
      sessionId: 'session',
      store,
      maxSteps: 2,
      maxOutputTokens: 64,
      model: {
        id: 'crash-fixture',
        capabilities: { tools: true, images: false, files: false },
        async *stream() {
          yield { type: 'finish', reason: 'complete', content: [{ type: 'text', text: 'resumed' }] }
        }
      },
      tools: [
        {
          name: 'append',
          version: '1',
          description: 'Append once',
          parameters: { type: 'object' },
          validate: (args) => args,
          authorize: async () => true,
          execute
        }
      ]
    })
    cleanup.push(() => session.dispose())
    await expect(session.continue()).rejects.toThrow('explicit recovery')
    await session.recover(next.run!.id)
    const recovered = await session.snapshot()
    expect(recovered.requests.at(-1)).toMatchObject({
      id: 'interrupted-request',
      status: 'interrupted'
    })
    expect(recovered.requests.at(-1)?.usage).toBeUndefined()
    expect(recovered.messages).toEqual(next.messages)
    expect(await session.continue()).toBe('complete')
    expect(execute).not.toHaveBeenCalled()
    const final = await session.snapshot()
    expect(final.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(await createJournalAgentStore({ directory }).load('session')).toEqual(final)
  }
  expect(await readFile(join(root, 'effect.jsonl'), 'utf8')).toBe(effects)
})
