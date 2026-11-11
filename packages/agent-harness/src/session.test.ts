import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { openAgentSession } from './session'
import { createMemoryAgentStore } from './memory-store'
import { createJsonFileAgentStore } from './file-store'
import type {
  AgentCheckpoint,
  AgentEvent,
  AgentMessage,
  AgentModel,
  AgentSessionOptions,
  AgentStore,
  AgentTool,
  ContentBlock,
  ModelEvent,
  ModelRequest,
  ToolGuard
} from './session-types'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

it.each(['within-budget', 'uncompactable'] as const)(
  'does not announce compaction when no summary runs: %s',
  async (expected) => {
    const events: AgentEvent[] = []
    const session = await openAgentSession(options({ onEvent: (event) => events.push(event) }))
    await session.prompt(text('hello'))
    const summarize = vi.fn(async () => 'unused')
    expect(
      await session.compact({
        inputBudget: expected === 'within-budget' ? 100000 : 1,
        keepRecentItems: 100,
        measure: (request) => JSON.stringify(request).length,
        summarize
      })
    ).toEqual({ status: expected })
    expect(summarize).not.toHaveBeenCalled()
    expect(events.filter((event) => event.type === 'compaction')).toEqual([])
    await session.dispose()
  }
)

it.each(['committed', 'not-smaller', 'failed', 'cancelled', 'write-failed'] as const)(
  'reports compaction lifecycle after its actual %s outcome',
  async (outcome) => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(options({ store, model: model(() => [done()]) }))
    await seed.prompt(text('old evidence '.repeat(300)))
    await seed.prompt(text('latest request'))
    await seed.dispose()
    const events: AgentEvent[] = []
    let installed = false
    let completionSawInstalled = false
    const session = await openAgentSession(
      options({
        store: {
          load: store.load,
          commit: async (id, revision, next) => {
            if (next.compactions.length && outcome === 'write-failed')
              throw new Error('store failed')
            const result = await store.commit(id, revision, next)
            if (result && next.compactions.length) installed = true
            return result
          }
        },
        onEvent(event) {
          events.push(event)
          if (
            event.type === 'compaction' &&
            event.status === 'finished' &&
            event.outcome.status === 'committed'
          )
            completionSawInstalled = installed
        }
      })
    )
    const operation = session.compact({
      inputBudget: 500,
      keepRecentItems: 1,
      measure: (request) => JSON.stringify(request.messages).length,
      summarize: async () => {
        expect(events.filter((event) => event.type === 'compaction')).toMatchObject([
          { status: 'started' }
        ])
        if (outcome === 'failed') throw new Error('summary failed')
        if (outcome === 'cancelled') session.cancel()
        return outcome === 'not-smaller' ? 'larger '.repeat(2000) : 'small checkpoint'
      }
    })
    if (['failed', 'cancelled', 'write-failed'].includes(outcome))
      await expect(operation).rejects.toThrow()
    else expect(await operation).toMatchObject({ status: outcome })
    const lifecycle = events.filter((event) => event.type === 'compaction')
    expect(lifecycle).toHaveLength(2)
    expect(lifecycle[0]).toMatchObject({ status: 'started' })
    expect(lifecycle[1]).toMatchObject({
      compactionId: lifecycle[0].compactionId,
      runId: lifecycle[0].runId,
      status:
        outcome === 'cancelled'
          ? 'cancelled'
          : ['failed', 'write-failed'].includes(outcome)
            ? 'failed'
            : 'finished'
    })
    expect(installed).toBe(outcome === 'committed')
    expect(completionSawInstalled).toBe(outcome === 'committed')
    await session.dispose()
    const reopened = await openAgentSession(
      options({ store, onEvent: (event) => events.push(event) })
    )
    expect(events.filter((event) => event.type === 'compaction')).toHaveLength(2)
    await reopened.dispose()
  }
)

it('releases disposed checkpoint objects while preserving store-backed snapshots', async () => {
  // Compile the current source in an isolated GC-enabled process, not a possibly stale dist.
  const source = `
    const ts = require(process.argv[1]), fs = require('node:fs');
    require.extensions['.ts'] = (module, filename) => module._compile(
      ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
      }}).outputText, filename);
    const { openAgentSession } = require(process.argv[2]);
    (async () => {
      let saved, weak;
      const store = { load: async () => saved && JSON.parse(saved),
        commit: async (_id, _expected, state) => { saved = JSON.stringify(state); return true; } };
      const session = await openAgentSession({ sessionId: 's', store, maxSteps: 1, maxOutputTokens: 64,
        model: { id: 'fixture', capabilities: { tools: false, images: false, files: false },
          async *stream() { yield { type: 'finish', reason: 'complete', content: [{type:'text',text:'ok'}] }; } },
        onEvent(event) { if (event.type === 'checkpoint') weak = new WeakRef(event.checkpoint); }
      });
      await session.prompt([{type:'text',text:'evidence'}]);
      await Promise.all([session.dispose(), session.dispose()]);
      for (let i = 0; i < 10; i++) { await new Promise(r => setImmediate(r)); global.gc(); }
      const retained = !!weak.deref();
      const snapshot = await session.snapshot();
      console.log(JSON.stringify({ retained, messages: snapshot.messages.length, status: snapshot.run.status }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--expose-gc',
    '-e',
    source,
    createRequire(import.meta.url).resolve('typescript'),
    join(import.meta.dirname, 'session.ts')
  ])
  expect(JSON.parse(stdout)).toEqual({ retained: false, messages: 2, status: 'complete' })
})
const done = (value = 'ok'): ModelEvent => ({
  type: 'finish',
  reason: 'complete',
  content: text(value)
})
const call = (name = 'work', args = {}): ModelEvent => ({
  type: 'finish',
  reason: 'tools',
  content: [],
  calls: [{ id: 'call', name, arguments: args }]
})
function memory(): AgentStore & { rows: Map<string, AgentCheckpoint> } {
  const rows = new Map<string, AgentCheckpoint>()
  return {
    rows,
    load: async (id) => structuredClone(rows.get(id)),
    commit: async (id, expected, next) => {
      if ((rows.get(id)?.revision ?? null) !== expected) return false
      rows.set(id, structuredClone(next))
      return true
    }
  }
}
function model(
  respond: (
    request: ModelRequest,
    index: number,
    signal: AbortSignal
  ) => AsyncIterable<ModelEvent> | ModelEvent[],
  id = 'model-a'
): AgentModel {
  let index = 0
  return {
    id,
    capabilities: { tools: true, images: true, files: true },
    async *stream(request, signal) {
      yield* respond(request, index++, signal)
    }
  }
}
const summaryText = (value: string): string =>
  `## Goal\nContinue.\n## Progress\n${value}\n## Evidence\nRetained.\n## Next\nFinish.`
// One production adapter handles both kinds of request; fixture counters remain independent.
function withSummary(main: AgentModel, summary: AgentModel): AgentModel {
  return {
    ...main,
    async *stream(request, signal) {
      const last = request.messages.at(-1)?.content[0]
      if (
        last?.type !== 'text' ||
        !last.text.startsWith('Create a compact continuation checkpoint')
      ) {
        yield* main.stream(request, signal)
        return
      }
      for await (const event of summary.stream(request, signal)) {
        if (event.type === 'finish' && event.reason === 'complete')
          yield {
            ...event,
            content: text(
              summaryText(event.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'))
            )
          }
        else yield event
      }
    }
  }
}
const tool = (overrides: Partial<AgentTool> = {}): AgentTool => ({
  name: 'work',
  version: '1',
  description: 'Host work',
  parameters: { type: 'object' },
  validate: (args) => args,
  authorize: async () => true,
  execute: async () => ({ content: text('result') }),
  ...overrides
})
const options = ({
  summary,
  ...overrides
}: Partial<AgentSessionOptions> & { summary?: AgentModel } = {}): AgentSessionOptions => ({
  sessionId: 'session',
  store: memory(),
  model: model(() => [done()]),
  maxSteps: 4,
  maxOutputTokens: 100,
  ...overrides,
  ...(summary ? { model: withSummary(overrides.model ?? model(() => [done()]), summary) } : {})
})
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('standalone session capability journeys', () => {
  it('inspects fresh store state across owners and disposal without exporting history', async () => {
    const store = memory()
    const reader = await openAgentSession(options({ store }))
    const writer = await openAgentSession(options({ store }))
    try {
      const before = await reader.inspect()
      await writer.prompt(text('historical evidence'))
      const after = await reader.inspect({ requestsFrom: before.requestCount })
      expect(after.revision).toBeGreaterThan(before.revision)
      expect(after.run?.status).toBe('complete')
      expect(after.requestCount).toBe(1)
      expect(after.requests).toEqual((await writer.snapshot()).requests)
      expect(after).not.toHaveProperty('messages')
      expect(after).not.toHaveProperty('compactions')
      expect(after).not.toHaveProperty('inbox')
      expect((await reader.inspect()).requests).toEqual([])
      expect((await reader.inspect({ requestsFrom: 1 })).requests).toEqual([])
      expect(Object.isFrozen(after.requests[0])).toBe(true)
      await reader.dispose()
      await writer.prompt(text('new revision after disposal'))
      expect((await reader.inspect({ requestsFrom: 1 })).requests).toHaveLength(1)
      expect(after.requestCount).toBe(1)
    } finally {
      await Promise.all([reader.dispose(), writer.dispose()])
    }
  })

  it('isolates inspected pending data from mutable custom stores', async () => {
    const store = memory()
    store.load = async (id) => store.rows.get(id)
    const session = await openAgentSession(
      options({
        store,
        model: model(() => [call('work', { value: 'original' })]),
        tools: [tool({ execute: async () => ({ waiting: { question: 'answer?' } }) })]
      })
    )
    try {
      expect(await session.prompt(text('ask'))).toBe('waiting')
      const inspection = await session.inspect()
      const pending = inspection.pending[0]
      expect(Object.isFrozen(pending.call.arguments)).toBe(true)
      expect(Object.isFrozen(pending.interaction)).toBe(true)
      store.rows.get('session')!.pending[0].interaction = { question: 'changed' }
      expect(pending.interaction).toEqual({ question: 'answer?' })
      expect((await session.inspect()).pending[0].interaction).toEqual({ question: 'changed' })
    } finally {
      await session.dispose()
    }
  })

  it('rejects invalid inspection offsets and corrupt history even when messages are omitted', async () => {
    const store = memory()
    const session = await openAgentSession(options({ store }))
    try {
      for (const requestsFrom of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        await expect(session.inspect({ requestsFrom })).rejects.toThrow('Invalid request offset')
      await expect(session.inspect({ requestsFrom: 1 })).rejects.toThrow('exceeds history')
      await session.prompt(text('evidence'))
      store.rows.get('session')!.messages[1].id = store.rows.get('session')!.messages[0].id
      await expect(session.inspect()).rejects.toThrow('Invalid message identity')
      store.rows.delete('session')
      await expect(session.inspect()).rejects.toThrow('checkpoint disappeared')
    } finally {
      await session.dispose()
    }
  })

  it('inspects a durable started request while the model is running', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const session = await openAgentSession(
      options({
        model: model(async function* () {
          entered.resolve()
          await release.promise
          yield done()
        })
      })
    )
    const running = session.prompt(text('run'))
    try {
      await entered.promise
      const during = await session.inspect({ requestsFrom: 0 })
      expect(during.run?.status).toBe('running')
      expect(during.requests[0].status).toBe('started')
      release.resolve()
      await running
      expect((await session.inspect({ requestsFrom: 0 })).requests[0].status).toBe('completed')
      expect(during.requests[0].status).toBe('started')
    } finally {
      release.resolve()
      await running
      await session.dispose()
    }
  })

  it('preflights and starts parallel-safe tools together, preserves result order and waits for both', async () => {
    const started: string[] = []
    const entered = deferred<void>()
    const release = deferred<void>()
    const toolFor = (name: string): AgentTool =>
      tool({
        name,
        scheduling: 'parallel',
        execute: async () => {
          started.push(name)
          if (started.length === 2) entered.resolve()
          await release.promise
          return { content: text(name) }
        }
      })
    const session = await openAgentSession(
      options({
        maxParallelTools: 2,
        tools: [toolFor('one'), toolFor('two')],
        model: model((_, index) =>
          index === 0
            ? [
                {
                  type: 'finish',
                  reason: 'tools',
                  content: [],
                  calls: [
                    { id: 'one', name: 'one', arguments: {} },
                    { id: 'two', name: 'two', arguments: {} }
                  ]
                }
              ]
            : [done()]
        )
      })
    )
    const run = session.prompt(text('parallel'))
    await entered.promise
    expect((await session.snapshot()).pending.map((entry) => entry.status)).toEqual([
      'started',
      'started'
    ])
    release.resolve()
    expect(await run).toBe('complete')
    expect(
      (await session.snapshot()).messages.slice(-3, -1).map((message) => message.content)
    ).toEqual([text('one'), text('two')])
    await session.dispose()
  })

  it('keeps an exclusive tool as a barrier and drains scoped capabilities before detach', async () => {
    const order: string[] = []
    const session = await openAgentSession(options({ model: model(() => [done()]) }))
    const scoped = tool({
      name: 'scoped',
      execute: async () => {
        order.push('run')
        return { content: text('ok') }
      }
    })
    const scope = await session.openToolScope([scoped])
    expect((await session.snapshot()).messages).toEqual([])
    await session.prompt(text('no call'))
    await scope.close()
    await expect(session.registerTool(scoped)).resolves.toBeUndefined()
    await expect(session.unregisterTool('scoped')).resolves.toBeUndefined()
    expect(order).toEqual([])
    await session.dispose()
  })

  it('persists steering messages and consumes them before the next model request', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const requests: ModelRequest[] = []
    const session = await openAgentSession(
      options({
        maxSteps: 3,
        model: model(async function* (request, index) {
          requests.push(request)
          if (index === 0) {
            entered.resolve()
            await release.promise
          }
          yield done(index === 0 ? 'first' : 'second')
        })
      })
    )
    const running = session.prompt(text('initial'))
    await entered.promise
    await session.steer(text('urgent follow-up'))
    expect((await session.snapshot()).inbox).toHaveLength(1)
    release.resolve()
    expect(await running).toBe('complete')
    expect(requests).toHaveLength(2)
    expect(requests[1].messages.at(-1)?.content).toEqual(text('urgent follow-up'))
    expect((await session.snapshot()).inbox).toEqual([])
    await expect(session.steer(text('idle'))).rejects.toThrow('idle')
    await session.dispose()
  })

  it('reopens durable JSON checkpoints and rejects a competing revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-harness-store-'))
    try {
      const store = createJsonFileAgentStore({ directory })
      const session = await openAgentSession(options({ store, sessionId: 'durable' }))
      await session.prompt(text('persist me'))
      const reopened = await openAgentSession(options({ store, sessionId: 'durable' }))
      expect((await reopened.snapshot()).messages).toHaveLength(2)
      const current = (await store.load('durable'))!
      expect(await store.commit('durable', current.revision - 1, current)).toBe(false)
      await Promise.all([session.dispose(), reopened.dispose()])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps queued steering across a cancellation and consumes it on the next continuation', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const session = await openAgentSession(
      options({
        store: createMemoryAgentStore(),
        model: model(async function* (request, index, signal) {
          if (index === 0) {
            entered.resolve()
            await release.promise
            signal.throwIfAborted()
          }
          yield done()
        })
      })
    )
    const running = session.prompt(text('initial'))
    await entered.promise
    await session.steer(text('continue with this'))
    session.cancel()
    release.resolve()
    expect(await running).toBe('cancelled')
    expect((await session.snapshot()).inbox).toHaveLength(1)
    expect(await session.continue()).toBe('complete')
    expect((await session.snapshot()).inbox).toEqual([])
    await session.dispose()
  })

  it('automatically compacts a long turn, meters the tool-free summary and reloads its projection', async () => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(options({ store }))
    await seed.prompt(text('old evidence '.repeat(100)))
    await seed.dispose()
    const execute = vi.fn(async () => ({ content: text('result') }))
    const summary = vi.fn((request: ModelRequest) => {
      expect(request.tools).toHaveLength(0)
      expect(request.maxOutputTokens).toBe(80)
      expect(request.messages[0].content).toEqual(text('old evidence '.repeat(100)))
      expect(request.messages.at(-1)?.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining('Do not continue the task')
        })
      )
      expect(
        request.messages
          .slice(0, -1)
          .some(
            (message) => message.content[0]?.type === 'text' && message.content[0].text === 'latest'
          )
      ).toBe(false)
      return [{ ...done('evidence retained'), usage: { inputTokens: 123, outputTokens: 7 } }]
    })
    const measure = (request: ModelRequest): number =>
      request.maxOutputTokens +
      request.messages.reduce((n, message) => n + JSON.stringify(message.content).length, 0)
    const admit = vi.fn()
    const events: AgentEvent[] = []
    const config = options({
      store,
      onEvent: (event) => {
        events.push(event)
      },
      summary: model(summary, 'summary'),
      compaction: {
        measure,
        admit,
        inputBudget: 600,
        keepRecentItems: 1,
        maxOutputTokens: 80
      },
      tools: [tool({ execute })],
      model: model((request, index) => {
        expect(request.messages[0].role).toBe('summary')
        expect(measure(request)).toBeLessThanOrEqual(600)
        return [index === 0 ? call() : done()]
      })
    })
    const session = await openAgentSession(config)
    expect(await session.prompt(text('latest'))).toBe('complete')
    expect(execute).toHaveBeenCalledOnce()
    expect(summary).toHaveBeenCalledOnce()
    expect(admit).toHaveBeenCalledOnce()
    const snapshot = await session.snapshot()
    const summaryId = snapshot.requests.find((entry) => entry.purpose === 'compaction')!.id
    const summaryEvents = events.filter(
      (event) => event.type === 'model' && event.requestId === summaryId
    )
    expect(summaryEvents.length).toBeGreaterThan(0)
    expect(
      summaryEvents.every((event) => event.type === 'model' && event.purpose === 'compaction')
    ).toBe(true)
    expect(snapshot.compactions).toHaveLength(1)
    expect(snapshot.messages[0].content).toEqual(text('old evidence '.repeat(100)))
    expect(snapshot.requests.find((entry) => entry.purpose === 'compaction')).toMatchObject({
      modelId: 'model-a',
      status: 'completed',
      usage: { inputTokens: 123, outputTokens: 7 }
    })
    await session.dispose()
    const reopened = await openAgentSession({
      ...config,
      model: model((request) => {
        expect(request.messages[0].role).toBe('summary')
        return [done()]
      })
    })
    expect(await reopened.continue()).toBe('complete')
    expect(summary).toHaveBeenCalledOnce()
    await reopened.dispose()
  })

  it('can keep the main request prefix stable while preparing a summary', async () => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(
      options({
        store,
        model: model(
          () => [
            { ...done(), providerState: { reasoning_content: 'Preserve this reasoning prefix.' } }
          ],
          'stable-model'
        )
      })
    )
    await seed.prompt(text('old evidence '.repeat(120)))
    await seed.dispose()
    const measured: ModelRequest[] = []
    const summaries: ModelRequest[] = []
    const mains: ModelRequest[] = []
    const summaryModel = model((request) => {
      summaries.push(request)
      return [done('summary')]
    }, 'stable-model')
    const mainModel = model((request) => {
      mains.push(request)
      return [done('complete')]
    }, 'stable-model')
    const session = await openAgentSession(
      options({
        store,
        instructions: 'stable system',
        tools: [tool()],
        model: mainModel,
        summary: summaryModel,
        compaction: {
          inputBudget: 400,
          keepRecentItems: 1,
          maxOutputTokens: 64,

          measure: (request) => {
            measured.push(structuredClone(request))
            return JSON.stringify(request.messages).includes('old evidence') ? 1000 : 1
          },
          instructions: 'Summarize safely.'
        }
      })
    )
    expect(await session.prompt(text('latest'))).toBe('complete')
    expect(summaries).toHaveLength(1)
    const original = measured[0]
    expect(original).toBeDefined()
    const summary = summaries[0]
    expect(summary.instructions).toBe(original.instructions)
    expect(summary.tools).toEqual([])
    expect(original.messages[1].providerState?.value).toEqual({
      reasoning_content: 'Preserve this reasoning prefix.'
    })
    expect(summary.messages.slice(0, -1)).toEqual(
      original.messages.slice(0, summary.messages.length - 1)
    )
    expect(summary.messages.length).toBeLessThanOrEqual(original.messages.length)
    expect(summary.messages.at(-1)?.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining('Summarize safely.') })
    )
    await session.prompt(text('next'))
    expect(mains).toHaveLength(2)
    expect(mains[1].messages.slice(0, mains[0].messages.length)).toEqual(mains[0].messages)
    await session.dispose()
  })

  it('uses the configured main route for summaries without a second adapter configuration', async () => {
    const store = createMemoryAgentStore()
    const session = await openAgentSession(
      options({
        store,
        compaction: {
          inputBudget: 1000,
          keepRecentItems: 1,
          maxOutputTokens: 128,
          measure: (request) =>
            request.instructions === 'new route' &&
            JSON.stringify(request.messages).includes('old evidence')
              ? 2000
              : 1
        }
      })
    )
    // Complete the initial turn, then change the route and its measured context pressure.
    await session.prompt(text('old evidence '.repeat(60)))
    const summary = vi.fn(() => [done('retained')])
    const main = vi.fn(() => [done()])
    session.configure({
      model: withSummary(model(main, 'route-b'), model(summary)),
      instructions: 'new route'
    })
    expect(await session.prompt(text('continue'))).toBe('complete')
    expect(summary).toHaveBeenCalledOnce()
    expect(main).toHaveBeenCalledOnce()
    expect((await session.snapshot()).requests.slice(-2).map((r) => r.modelId)).toEqual([
      'route-b',
      'route-b'
    ])
    await session.dispose()
  })

  it('compacts between model steps after tool growth without repeating an acknowledged effect', async () => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(options({ store }))
    await seed.prompt(text('old'.repeat(200)))
    await seed.dispose()
    const execute = vi.fn(async () => ({ content: text('result'.repeat(65)) }))
    const summary = vi.fn(() => [done('retained goal')])
    const session = await openAgentSession(
      options({
        store,
        tools: [tool({ execute })],
        summary: model(summary),
        compaction: {
          inputBudget: 950,
          keepRecentItems: 1,
          maxOutputTokens: 80,

          measure: (request) =>
            request.messages.reduce((n, message) => n + JSON.stringify(message.content).length, 0)
        },
        model: model((request, index) => {
          if (index === 0) expect(request.messages[0].role).toBe('user')
          else {
            expect(request.messages[0].role).toBe('summary')
            expect(request.messages.at(-1)?.role).toBe('tool')
            expect(request.messages.at(-2)?.calls).toHaveLength(1)
          }
          return [index === 0 ? call() : done()]
        })
      })
    )
    expect(await session.prompt(text('new goal'))).toBe('complete')
    expect(execute).toHaveBeenCalledOnce()
    expect(summary).toHaveBeenCalledOnce()
    await session.dispose()
  })

  it('applies separate summary admission before recording or dispatching a summary request', async () => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(options({ store }))
    await seed.prompt(text('old'.repeat(1000)))
    await seed.dispose()
    const summary = vi.fn(() => [done('retained goal')])
    const session = await openAgentSession(
      options({
        store,
        summary: model(summary),
        compaction: {
          inputBudget: 400,
          keepRecentItems: 1,
          maxOutputTokens: 80,

          measure: (request) => JSON.stringify(request.messages).length,
          admit: () => {
            throw new Error('Summary capacity exceeded')
          }
        }
      })
    )
    await expect(session.prompt(text('new goal'))).rejects.toThrow('Summary capacity exceeded')
    expect(summary).not.toHaveBeenCalled()
    expect(
      (await session.snapshot()).requests.some((entry) => entry.purpose === 'compaction')
    ).toBe(false)
    await session.dispose()
  })

  it.each(['not-smaller', 'still-too-large', 'uncompactable'] as const)(
    'stops at budget after bounded %s compaction without a main request',
    async (mode) => {
      const store = createMemoryAgentStore()
      const seed = await openAgentSession(options({ store }))
      if (mode !== 'uncompactable') await seed.prompt(text('x'.repeat(2000)))
      await seed.dispose()
      const dispatch = vi.fn(() => [done()])
      const summary = vi.fn(() => [done(mode === 'not-smaller' ? 'x'.repeat(4000) : 'small')])
      const session = await openAgentSession(
        options({
          store,
          model: model(dispatch),
          summary: model(summary),
          compaction: {
            inputBudget: 400,
            keepRecentItems: 1,
            maxOutputTokens: 50,

            measure: (request) => JSON.stringify(request.messages).length
          }
        })
      )
      expect(
        await session.prompt(text(mode === 'not-smaller' ? 'new' : 'large tail'.repeat(100)))
      ).toBe('budget')
      expect(dispatch).not.toHaveBeenCalled()
      expect(summary).toHaveBeenCalledTimes(mode === 'uncompactable' ? 0 : 1)
      await session.dispose()
    }
  )

  it('checks the transformed request budget even when canonical history is small', async () => {
    const dispatch = vi.fn(() => [done()])
    const summary = vi.fn(() => [done()])
    const session = await openAgentSession(
      options({
        model: model(dispatch),
        transformContext: (messages) => [
          ...messages,
          { id: 'retrieval', role: 'user', content: text('x'.repeat(2000)) }
        ],
        summary: model(summary),
        compaction: {
          inputBudget: 400,
          keepRecentItems: 1,
          maxOutputTokens: 50,

          measure: (request) => JSON.stringify(request.messages).length
        }
      })
    )
    expect(await session.prompt(text('short'))).toBe('budget')
    expect(dispatch).not.toHaveBeenCalled()
    expect(summary).not.toHaveBeenCalled()
    await session.dispose()
  })

  it('summarizes only the transformed compaction source, not the retained recent tail', async () => {
    const store = memory()
    const seed = await openAgentSession(options({ store }))
    await seed.prompt(text('OLD'.repeat(300)))
    await seed.dispose()
    let summarized: ModelRequest | undefined
    const session = await openAgentSession(
      options({
        store,
        // Redaction applies to the summary input as well as to ordinary requests.
        transformContext: (messages) =>
          messages.map((message) =>
            JSON.stringify(message.content).includes('OLD')
              ? { ...message, content: text('REDACTED_OLD'.padEnd(900, '.')) }
              : message
          ),
        summary: model((request) => {
          summarized = request
          return [done('summary')]
        }),
        compaction: {
          inputBudget: 400,
          keepRecentItems: 1,
          maxOutputTokens: 50,
          measure: (request) => JSON.stringify(request.messages).length
        }
      })
    )
    expect(await session.prompt(text('LATEST'.repeat(10)))).toBe('complete')
    const input = JSON.stringify(summarized!.messages.slice(0, -1))
    expect(input).toContain('REDACTED_OLD')
    expect(input).not.toContain('OLDOLD')
    expect(input).not.toContain('LATEST')
    await session.dispose()
  })

  it('cancels an in-flight automatic summary and records interruption without compacting or executing', async () => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(options({ store }))
    await seed.prompt(text('old'.repeat(1000)))
    await seed.dispose()
    const entered = deferred<void>(),
      release = deferred<void>()
    const dispatch = vi.fn(() => [done()])
    const session = await openAgentSession(
      options({
        store,
        model: model(dispatch),
        summary: model(async function* (_, __, signal) {
          entered.resolve()
          await release.promise
          signal.throwIfAborted()
          yield done('summary')
        }),
        compaction: {
          inputBudget: 400,
          keepRecentItems: 1,
          maxOutputTokens: 80,
          measure: (request) => JSON.stringify(request.messages).length
        }
      })
    )
    const running = session.prompt(text('next'))
    await entered.promise
    session.cancel()
    await expect(session.continue()).rejects.toThrow('busy')
    release.resolve()
    expect(await running).toBe('cancelled')
    const snapshot = await session.snapshot()
    expect(snapshot.compactions).toEqual([])
    expect(snapshot.requests.at(-1)).toMatchObject({ purpose: 'compaction', status: 'interrupted' })
    expect(dispatch).not.toHaveBeenCalled()
    await session.dispose()
  })

  it.each([
    'I cannot execute this task; here is code to run.',
    '## Goal\nTask.\n## Progress\nDone.\n## Evidence\nIDs.',
    '## Goal\nTask.\n## Evidence\nIDs.\n## Progress\nDone.\n## Next\nAnswer.',
    '## Goal\nTask.\n## Progress\n\n## Evidence\nIDs.\n## Next\nAnswer.'
  ])('rejects an invalid automatic checkpoint without losing history: %s', async (invalid) => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(options({ store }))
    await seed.prompt(text('evidence '.repeat(1000)))
    const original = (await seed.snapshot()).messages
    await seed.dispose()
    const dispatch = vi.fn(() => [
      { ...done(invalid), usage: { inputTokens: 31, outputTokens: 7 } }
    ])
    const session = await openAgentSession(
      options({
        store,
        model: model(dispatch),
        compaction: {
          inputBudget: 400,
          keepRecentItems: 1,
          maxOutputTokens: 128,
          measure: (r) => JSON.stringify(r.messages).length
        }
      })
    )
    await expect(session.prompt(text('next'))).rejects.toThrow('Invalid continuation summary')
    const state = await session.snapshot()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(state.messages.slice(0, original.length)).toEqual(original)
    expect(state.compactions).toEqual([])
    expect(state.requests.at(-1)).toMatchObject({
      purpose: 'compaction',
      status: 'failed',
      usage: { inputTokens: 31, outputTokens: 7 }
    })
    await session.dispose()
  })

  it('rejects tools from a summary model while retaining reported usage', async () => {
    const store = createMemoryAgentStore()
    const seed = await openAgentSession(options({ store }))
    await seed.prompt(text('old'.repeat(1000)))
    await seed.dispose()
    const execute = vi.fn(async () => ({ content: text('effect') }))
    const session = await openAgentSession(
      options({
        store,
        tools: [tool({ execute })],
        summary: model((request) => {
          expect(request.tools).toEqual([])
          return [{ ...call(), usage: { inputTokens: 30, outputTokens: 4 } }]
        }),
        compaction: {
          inputBudget: 400,
          keepRecentItems: 1,
          maxOutputTokens: 80,
          measure: (request) => JSON.stringify(request.messages).length
        }
      })
    )
    await expect(session.prompt(text('next'))).rejects.toThrow('tool-free summary')
    const snapshot = await session.snapshot()
    expect(snapshot.compactions).toEqual([])
    expect(snapshot.requests.at(-1)).toMatchObject({
      purpose: 'compaction',
      status: 'failed',
      usage: { inputTokens: 30, outputTokens: 4 }
    })
    expect(execute).not.toHaveBeenCalled()
    await session.dispose()
  })

  it('defaults to isolated memory and reopens/forks only through an explicitly shared store', async () => {
    const first = await openAgentSession(options({ store: undefined }))
    await first.prompt(text('private'))
    const second = await openAgentSession(options({ store: undefined }))
    expect((await second.snapshot()).messages).toEqual([])
    const store = createMemoryAgentStore()
    const parent = await openAgentSession(options({ store }))
    await parent.prompt(text('shared'))
    await parent.fork('child')
    await parent.dispose()
    const reopened = await openAgentSession(options({ store }))
    const child = await openAgentSession(options({ store, sessionId: 'child' }))
    expect((await reopened.snapshot()).messages).toHaveLength(2)
    expect((await child.snapshot()).messages).toHaveLength(2)
    await child.prompt(text('child only'))
    expect((await reopened.snapshot()).messages).toHaveLength(2)
    await Promise.all([first.dispose(), second.dispose(), reopened.dispose(), child.dispose()])
  })

  it('isolates memory snapshots and atomically rejects competing or malformed revisions', async () => {
    const store = createMemoryAgentStore()
    const session = await openAgentSession(options({ store }))
    const initial = (await store.load('session'))!
    const next = { ...initial, revision: 1 }
    expect(
      await Promise.all([store.commit('session', 0, next), store.commit('session', 0, next)])
    ).toEqual([true, false])
    next.messages.push({ id: 'injected', role: 'user', content: text('not stored') })
    const loaded = (await store.load('session'))!
    expect(loaded.messages).toEqual([])
    loaded.messages.push(...next.messages)
    expect((await store.load('session'))!.messages).toEqual([])
    expect(await store.commit('session', null, initial)).toBe(false)
    await expect(store.commit('session', 1, { ...initial, revision: 3 })).rejects.toThrow(
      'revision'
    )
    await expect(
      store.commit('session', 1, { ...initial, sessionId: 'other', revision: 2 })
    ).rejects.toThrow('checkpoint')
    await session.dispose()
  })

  it('transforms each model projection before admission without editing canonical history', async () => {
    const projections: ModelRequest[] = []
    const transformContext = vi.fn(async (messages: readonly AgentMessage[]) => {
      expect(Object.isFrozen(messages)).toBe(true)
      expect(Object.isFrozen(messages[0].content)).toBe(true)
      return [
        { id: 'ephemeral', role: 'user' as const, content: text('retrieved context') },
        ...messages
      ]
    })
    const session = await openAgentSession(
      options({
        store: undefined,
        transformContext,
        tools: [tool()],
        admit: (request) => {
          projections.push(request)
        },
        model: model((request, index) => {
          expect(request).toBe(projections[index])
          expect(request.messages[0].content).toEqual(text('retrieved context'))
          if (index === 1) expect(request.messages.at(-1)?.role).toBe('tool')
          return [index === 0 ? call() : done()]
        })
      })
    )
    expect(await session.prompt(text('work'))).toBe('complete')
    expect(transformContext).toHaveBeenCalledTimes(2)
    expect((await session.snapshot()).messages.some((message) => message.id === 'ephemeral')).toBe(
      false
    )
    await session.dispose()
  })

  it('rejects orphaned projected tools before request admission or provider dispatch', async () => {
    const dispatch = vi.fn(() => [done()])
    const admit = vi.fn()
    const session = await openAgentSession(
      options({
        model: model(dispatch),
        admit,
        transformContext: () => [
          { id: 'orphan', role: 'tool', invocationId: 'missing', content: text('fake') }
        ]
      })
    )
    await expect(session.prompt(text('work'))).rejects.toThrow('Orphan tool')
    expect(dispatch).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled()
    expect((await session.snapshot()).requests).toEqual([])
    await session.dispose()
  })

  it('waits for async context cleanup on cancellation without admitting a model request', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const dispatch = vi.fn(() => [done()])
    const session = await openAgentSession(
      options({
        model: model(dispatch),
        transformContext: async (messages, signal) => {
          entered.resolve()
          await release.promise
          expect(signal.aborted).toBe(true)
          return messages
        }
      })
    )
    const running = session.prompt(text('work'))
    await entered.promise
    session.cancel()
    await expect(session.prompt(text('overlap'))).rejects.toThrow('busy')
    release.resolve()
    expect(await running).toBe('cancelled')
    expect(dispatch).not.toHaveBeenCalled()
    expect((await session.snapshot()).requests).toEqual([])
    await session.dispose()
  })

  it.each(['deny', 'throw', 'invalid'] as const)(
    'fails closed after approval when a guard returns %s',
    async (outcome) => {
      const execute = vi.fn(async () => ({ content: text('effect') }))
      const later = vi.fn(() => 'abstain' as const)
      const authorize = vi.fn(async () => true)
      const first: ToolGuard = () => {
        if (outcome === 'throw') throw new Error('guard unavailable')
        return (outcome === 'invalid' ? 'allow' : 'deny') as 'deny'
      }
      const guards = [first, later]
      const statuses: string[] = []
      const session = await openAgentSession(
        options({
          guards,
          tools: [tool({ authorize, execute })],
          onEvent: (event) => {
            if (event.type === 'checkpoint')
              statuses.push(...event.checkpoint.pending.map((p) => p.status))
          },
          model: model((request, index) => {
            expect(Object.keys(request.tools[0]).sort()).toEqual([
              'description',
              'name',
              'parameters',
              'version'
            ])
            if (index === 1) expect(request.messages.at(-1)?.isError).toBe(true)
            return [index === 0 ? call() : done()]
          })
        })
      )
      guards.splice(0) // Changing the caller's registry cannot remove an opened session's guard.
      expect(await session.prompt(text('work'))).toBe('complete')
      expect(authorize).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
      expect(later).not.toHaveBeenCalled()
      expect(statuses).not.toContain('started')
      await session.dispose()
    }
  )

  it('rechecks host-owned action readiness per turn without sharing it across sessions', async () => {
    const effects = [
      vi.fn(async () => ({ content: text('submitted') })),
      vi.fn(async () => ({ content: text('submitted') }))
    ]
    const turns = [1, 2]
    const sessions = await Promise.all(
      effects.map((execute, index) =>
        openAgentSession(
          options({
            sessionId: `guarded-${index}`,
            guards: [() => (turns[index] < 2 ? 'deny' : 'abstain')],
            tools: [tool({ execute })],
            model: model((_, request) => [request % 2 === 0 ? call() : done()])
          })
        )
      )
    )
    try {
      expect(await sessions[0].prompt(text('inspect; do not submit yet'))).toBe('complete')
      expect(effects[0]).not.toHaveBeenCalled()
      expect((await sessions[0].snapshot()).messages.find((m) => m.role === 'tool')?.isError).toBe(
        true
      )
      expect(await sessions[1].prompt(text('submit now'))).toBe('complete')
      expect(effects[1]).toHaveBeenCalledOnce()
      turns[0] = 2
      expect(await sessions[0].prompt(text('submit now'))).toBe('complete')
      expect(effects[0]).toHaveBeenCalledOnce()
      expect(effects[1]).toHaveBeenCalledOnce()
    } finally {
      await Promise.all(sessions.map((session) => session.dispose()))
    }
  })

  it('passes the same frozen validated arguments through authorization, all guards and execution', async () => {
    let authorized: unknown
    const order: string[] = []
    const session = await openAgentSession(
      options({
        guards: [
          (args, context, definition) => {
            order.push('guard1')
            expect(args).toBe(authorized)
            expect(Object.isFrozen(args)).toBe(true)
            expect(Object.isFrozen(definition.parameters)).toBe(true)
            expect(context.invocationId).toContain('/call')
            return 'abstain' as const
          },
          async () => {
            order.push('guard2')
            return 'abstain' as const
          }
        ],
        tools: [
          tool({
            authorize: async (args) => {
              authorized = args
              order.push('authorize')
              return true
            },
            execute: async (args) => {
              expect(args).toBe(authorized)
              order.push('execute')
              return { content: text('result') }
            }
          })
        ],
        model: model((_, index) => [index === 0 ? call() : done()])
      })
    )
    await session.prompt(text('work'))
    expect(order).toEqual(['authorize', 'guard1', 'guard2', 'execute'])
    await session.dispose()
  })

  it('cancels during an async guard without starting any tool effect', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const execute = vi.fn(async () => ({ content: text('effect') }))
    const session = await openAgentSession(
      options({
        guards: [
          async (_, context) => {
            entered.resolve()
            await release.promise
            expect(context.signal.aborted).toBe(true)
            return 'abstain' as const
          }
        ],
        tools: [tool({ execute })],
        model: model(() => [call()])
      })
    )
    const running = session.prompt(text('work'))
    await entered.promise
    session.cancel()
    release.resolve()
    expect(await running).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
    expect((await session.snapshot()).pending).toEqual([])
    await session.dispose()
  })

  it('keeps recovery exclusive until planned tools are cancelled and returns cancellation at the last step', async () => {
    const session = await openAgentSession(
      options({
        maxSteps: 1,
        tools: [
          tool({
            execute: async () => {
              session.cancel()
              return { content: text('acknowledged effect') }
            }
          })
        ],
        model: model(() => [call()])
      })
    )
    expect(await session.prompt(text('go'))).toBe('cancelled')
    expect((await session.snapshot()).pending).toEqual([])
    const store = memory(),
      gate = deferred<void>(),
      entered = deferred<void>()
    const previous = await openAgentSession(
      options({
        store,
        model: model(async function* () {
          entered.resolve()
          await gate.promise
          yield done()
        })
      })
    )
    const original = previous.prompt(text('go'))
    await entered.promise
    const recovery = await openAgentSession(options({ store }))
    const commit = store.commit,
      claimed = deferred<void>(),
      release = deferred<void>()
    store.commit = async (id, revision, next) => {
      const written = await commit(id, revision, next)
      if (next.run?.kind === 'recovery' && next.run.status === 'running') {
        claimed.resolve()
        await release.promise
      }
      return written
    }
    const recovering = recovery.recover((await recovery.snapshot()).run!.id)
    await claimed.promise
    const competing = await openAgentSession(options({ store }))
    await expect(competing.continue()).rejects.toThrow('recovery')
    release.resolve()
    await recovering
    gate.resolve()
    await expect(original).rejects.toThrow('Stale')
  })
  it('reports tool progress only while its execution is active', async () => {
    const updates: string[] = []
    let late: (() => void) | undefined
    const session = await openAgentSession(
      options({
        tools: [
          tool({
            execute: async (_args, context) => {
              context.update(text('working'))
              late = () => context.update(text('too late'))
              return { content: text('done') }
            }
          })
        ],
        model: model((_request, index) => [index ? done() : call()]),
        onEvent: (event) => {
          if (event.type === 'tool-update') updates.push(JSON.stringify(event.content))
        }
      })
    )
    await session.prompt(text('go'))
    late!()
    expect(updates).toEqual([JSON.stringify(text('working'))])
  })

  it('retains reported usage when the stream subsequently fails, without accepting its answer', async () => {
    const session = await openAgentSession(
      options({
        model: model(async function* () {
          yield { ...done('uncommitted'), usage: { inputTokens: 12, outputTokens: 4 } }
          throw new Error('stream cleanup failed')
        })
      })
    )
    await expect(session.prompt(text('go'))).rejects.toThrow('cleanup')
    const checkpoint = await session.snapshot()
    expect(checkpoint.requests[0]).toMatchObject({
      status: 'failed',
      usage: { inputTokens: 12, outputTokens: 4 }
    })
    expect(checkpoint.messages).toHaveLength(1)
  })

  it('does not execute if cancellation arrives at the durable tool-intent checkpoint', async () => {
    const execute = vi.fn()
    const session = await openAgentSession(
      options({
        tools: [tool({ execute })],
        model: model(() => [call()]),
        onEvent: (event) => {
          if (
            event.type === 'checkpoint' &&
            event.checkpoint.pending.some((entry) => entry.status === 'started')
          )
            session.cancel()
        }
      })
    )
    expect(await session.prompt(text('go'))).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
    expect((await session.snapshot()).pending).toEqual([])
  })

  it('drops provider-private state from a fork and rejects malformed JSON before execution', async () => {
    const session = await openAgentSession(
      options({
        model: model(() => [{ ...done(), providerState: { sessionToken: 'opaque-fixture-state' } }])
      })
    )
    await session.prompt(text('go'))
    expect((await session.fork('child')).messages.every((message) => !message.providerState)).toBe(
      true
    )
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(() => session.prompt(cyclic as ContentBlock[])).toThrow('JSON')
    expect(() => session.prompt(new Array(2) as ContentBlock[])).toThrow('dense')
  })
  it('supports a host Plan/ask-user workflow with feedback and explicit approval, without built-in business tools', async () => {
    let executions = 0
    const session = await openAgentSession(
      options({
        tools: [
          tool({
            name: 'review',
            execute: async (args) => ({ waiting: { kind: 'plan-review', plan: args } })
          }),
          tool({
            execute: async () => {
              executions++
              return { content: text('19') }
            }
          })
        ],
        model: model((request, index) => {
          if (index === 0) return [call('review', { expression: '8+10' })]
          if (index === 1) {
            expect(request.messages.at(-1)?.content).toEqual(text('Change to 8+11'))
            return [call('review', { expression: '8+11' })]
          }
          if (index === 2) {
            expect(request.messages.at(-1)?.content).toEqual(text('Approved'))
            return [call()]
          }
          return [done('19')]
        })
      })
    )
    expect(await session.prompt(text('plan first'))).toBe('waiting')
    await session.respond((await session.snapshot()).pending[0].invocationId, {
      content: text('Change to 8+11'),
      isError: true
    })
    expect(executions).toBe(0)
    expect(await session.continue()).toBe('waiting')
    await session.respond((await session.snapshot()).pending[0].invocationId, {
      content: text('Approved')
    })
    expect(await session.continue()).toBe('complete')
    expect(executions).toBe(1)
  })

  it('uses skills, Connector data and artifacts as ordinary authorized tools with real host file effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-host-'))
    try {
      const artifact = join(directory, 'report.json'),
        authorized: string[] = []
      const tools = [
        tool({
          name: 'load_skill',
          execute: async () => ({ content: text('Read measurements, then save their sum.') })
        }),
        tool({
          name: 'connector',
          execute: async () => ({ content: text(JSON.stringify({ measurements: [3, 5, 8] })) })
        }),
        tool({
          name: 'artifact',
          execute: async (args) => {
            await writeFile(artifact, JSON.stringify(args))
            return {
              content: [{ type: 'file', mimeType: 'application/json', source: { ref: 'report' } }]
            }
          }
        })
      ].map((entry) => ({
        ...entry,
        authorize: async () => {
          authorized.push(entry.name)
          return true
        }
      }))
      const session = await openAgentSession(
        options({
          tools,
          model: model((request, index) => {
            if (!index) return [call('load_skill')]
            if (index === 1) {
              expect(request.messages.at(-1)?.content).toEqual(
                text('Read measurements, then save their sum.')
              )
              return [call('connector')]
            }
            if (index === 2) {
              expect(request.messages.at(-1)?.content).toEqual(text('{"measurements":[3,5,8]}'))
              return [call('artifact', { sum: 16 })]
            }
            expect(request.messages.at(-1)?.content[0].type).toBe('file')
            return [done('report saved')]
          })
        })
      )
      expect(await session.prompt(text('summarize'))).toBe('complete')
      expect(JSON.parse(await readFile(artifact, 'utf8'))).toEqual({ sum: 16 })
      expect(authorized).toEqual(['load_skill', 'connector', 'artifact'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps Side chat history private and relays only through an explicitly authorized host tool', async () => {
    const store = memory(),
      inbox: string[] = []
    const main = await openAgentSession(options({ store, model: model(() => [done('MAIN')]) }))
    await main.prompt(text('shared task'))
    await main.fork('side')
    const side = await openAgentSession(
      options({
        store,
        sessionId: 'side',
        tools: [
          tool({
            name: 'relay',
            execute: async (args) => {
              inbox.push(JSON.stringify(args))
              return { content: text('queued') }
            }
          })
        ],
        model: model((_request, index) => [
          index ? done('sent') : call('relay', { message: 'EXPLICIT_MARKER' })
        ])
      })
    )
    await side.prompt(text('SIDE_PRIVATE'))
    expect(JSON.stringify((await main.snapshot()).messages)).not.toContain('SIDE_PRIVATE')
    expect(inbox).toEqual(['{"message":"EXPLICIT_MARKER"}'])
    main.configure({
      model: model((request) => {
        expect(JSON.stringify(request.messages)).toContain('EXPLICIT_MARKER')
        expect(JSON.stringify(request.messages)).not.toContain('SIDE_PRIVATE')
        return [done()]
      })
    })
    await main.prompt(text(inbox.shift()!))
    await side.dispose()
    expect(await main.prompt(text('still usable'))).toBe('complete')
  })

  it('propagates parent cancellation to a child and waits for both domains to settle', async () => {
    const started = deferred<void>(),
      store = memory()
    const child = await openAgentSession(
      options({
        store,
        sessionId: 'child',
        model: model(async function* (_request, _index, signal) {
          started.resolve()
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true })
          )
          signal.throwIfAborted()
          yield done()
        })
      })
    )
    const parent = await openAgentSession(
      options({
        store,
        tools: [
          tool({
            execute: async (_args, { signal }) => {
              const abort = (): void => child.cancel()
              signal.addEventListener('abort', abort, { once: true })
              try {
                const status = await child.prompt(text('child'))
                return { content: text(status), isError: status !== 'complete' }
              } finally {
                signal.removeEventListener('abort', abort)
                await child.dispose()
              }
            }
          })
        ],
        model: model(() => [call()])
      })
    )
    const turn = parent.prompt(text('parent'))
    await started.promise
    parent.cancel()
    expect(await turn).toBe('cancelled')
    expect((await child.snapshot()).run?.status).toBe('cancelled')
    expect((await parent.snapshot()).pending).toEqual([])
  })

  it('times out cooperatively, drains the adapter and does not equate a token/step limit with completion', async () => {
    let cleaned = false
    const session = await openAgentSession(
      options({
        timeoutMs: 15,
        model: model(async function* (_request, _index, signal) {
          try {
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true })
            )
            signal.throwIfAborted()
            yield done()
          } finally {
            cleaned = true
          }
        })
      })
    )
    expect(await session.prompt(text('wait'))).toBe('cancelled')
    expect(cleaned).toBe(true)
    const bounded = await openAgentSession(
      options({ maxSteps: 1, tools: [tool()], model: model(() => [call()]) })
    )
    expect(await bounded.prompt(text('loop'))).toBe('budget')
    expect((await bounded.snapshot()).pending).toEqual([])
  })

  it('rejects stale capabilities after an interaction rather than executing a different tool implementation', async () => {
    const execute = vi.fn(async () => ({ content: text('new implementation') }))
    const session = await openAgentSession(
      options({
        tools: [tool({ name: 'question', execute: async () => ({ waiting: 'answer' }) }), tool()],
        model: model(() => [
          {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [
              { id: 'question', name: 'question', arguments: {} },
              { id: 'work', name: 'work', arguments: {} }
            ]
          }
        ])
      })
    )
    expect(await session.prompt(text('go'))).toBe('waiting')
    const id = (await session.snapshot()).pending[0].invocationId
    session.configure({ model: model(() => [done()]), tools: [tool({ version: '2', execute })] })
    await session.respond(id, { content: text('answer') })
    await expect(session.continue()).rejects.toThrow('capability changed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects forks inside a tool exchange and prevents tool output from replacing record identity', async () => {
    const session = await openAgentSession(
      options({
        tools: [
          tool({ execute: async () => ({ content: text('safe'), role: 'user', id: 'forged' }) })
        ],
        model: model((_request, index) => [index ? done() : call()])
      })
    )
    await session.prompt(text('go'))
    const snapshot = await session.snapshot()
    await expect(session.fork('bad-fork', snapshot.messages[1].id)).rejects.toThrow('pending')
    expect(snapshot.messages[2].role).toBe('tool')
    expect(snapshot.messages[2].id).not.toBe('forged')
  })
  it('streams, persists before effects, validates/authorizes the same immutable args and meters each call', async () => {
    const store = memory(),
      events: string[] = []
    let authorized: unknown
    const session = await openAgentSession(
      options({
        store,
        instructions: 'Host policy',
        tools: [
          tool({
            validate: () => ({ nested: { value: 7 } }),
            authorize: async (args) => {
              authorized = args
              expect(Object.isFrozen(args)).toBe(true)
              return true
            },
            execute: async (args, context) => {
              expect(args).toBe(authorized)
              expect((await store.load('session'))?.pending[0].status).toBe('started')
              expect(context.invocationId).toContain('/call')
              return { content: text('7') }
            }
          })
        ],
        model: model((request, index) => {
          expect(request.instructions).toBe('Host policy')
          expect(request.tools[0].name).toBe('work')
          if (!index)
            return [
              { type: 'reasoning-delta', text: 'private' },
              { type: 'text-delta', text: 'working' },
              { ...call(), usage: { inputTokens: 10, outputTokens: 3 } }
            ]
          expect(request.messages.at(-1)?.content).toEqual(text('7'))
          return [done('answer')]
        }),
        onEvent: (event) => {
          if (event.type === 'model') events.push(event.event.type)
        }
      })
    )
    expect(await session.prompt(text('start'))).toBe('complete')
    expect(events).toEqual(['reasoning-delta', 'text-delta', 'finish', 'finish'])
    const snapshot = await session.snapshot()
    expect(snapshot.requests.map((request) => request.usage)).toEqual([
      { inputTokens: 10, outputTokens: 3 },
      undefined
    ])
    expect(snapshot.pending).toEqual([])
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant'
    ])
  })

  it.each(['denied', 'invalid', 'missing'])(
    'returns %s tool results without executing and lets the model repair',
    async (kind) => {
      const execute = vi.fn(async () => ({ content: text('unexpected') }))
      const session = await openAgentSession(
        options({
          tools:
            kind === 'missing'
              ? []
              : [
                  tool({
                    execute,
                    authorize: async () => kind !== 'denied',
                    validate: (input) => {
                      if (kind === 'invalid') throw new Error('private')
                      return input
                    }
                  })
                ],
          model: model((request, index) => {
            if (!index) return [call()]
            expect(request.messages.at(-1)?.isError).toBe(true)
            return [done('repaired')]
          })
        })
      )
      expect(await session.prompt(text('start'))).toBe('complete')
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it('persists a human interaction, reloads it from disk, accepts one answer, and continues without rerunning the tool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-interaction-'))
    try {
      const path = join(directory, 'checkpoint.json')
      const store: AgentStore = {
        load: async () => {
          try {
            return JSON.parse(await readFile(path, 'utf8'))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          }
        },
        commit: async (id, revision, next) => {
          if (((await store.load(id))?.revision ?? null) !== revision) return false
          await writeFile(path, JSON.stringify(next))
          return true
        }
      }
      const execute = vi.fn(async () => ({
        waiting: { kind: 'question', choices: ['table', 'list'] }
      }))
      const initial = await openAgentSession(
        options({ store, tools: [tool({ execute })], model: model(() => [call()]) })
      )
      expect(await initial.prompt(text('choose format'))).toBe('waiting')
      const pending = (await initial.snapshot()).pending[0]
      await initial.dispose()
      const resumed = await openAgentSession(
        options({
          store,
          tools: [tool({ execute })],
          model: model((request) => {
            expect(request.messages.at(-1)?.content).toEqual(text('table'))
            return [done('table selected')]
          })
        })
      )
      await expect(resumed.prompt(text('wrong'))).rejects.toThrow('pending')
      await expect(resumed.respond('wrong', { content: text('list') })).rejects.toThrow('identity')
      await resumed.respond(pending.invocationId, { content: text('table') })
      await expect(
        resumed.respond(pending.invocationId, { content: text('again') })
      ).rejects.toThrow('identity')
      expect(await resumed.continue()).toBe('complete')
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cancels a stream, waits for cleanup, then accepts a new prompt on the same session', async () => {
    const started = deferred<void>(),
      drained = deferred<void>()
    const session = await openAgentSession(
      options({
        model: model(async function* (_request, index, signal) {
          if (index) {
            yield done('after stop')
            return
          }
          started.resolve()
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true })
          )
          await drained.promise
          yield done('late')
        })
      })
    )
    const turn = session.prompt(text('first'))
    await started.promise
    session.cancel()
    await expect(session.prompt(text('too early'))).rejects.toThrow('busy')
    drained.resolve()
    expect(await turn).toBe('cancelled')
    expect(await session.prompt(text('next'))).toBe('complete')
    const snapshot = await session.snapshot()
    expect(snapshot.requests.map((request) => request.status)).toEqual(['interrupted', 'completed'])
    expect(JSON.stringify(snapshot.messages)).not.toContain('late')
  })

  it('cancels approval without effects and clears admission for the next turn', async () => {
    const waiting = deferred<void>(),
      execute = vi.fn()
    const session = await openAgentSession(
      options({
        tools: [
          tool({
            execute,
            authorize: async (_args, { signal }) => {
              waiting.resolve()
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true })
              )
              return true
            }
          })
        ],
        model: model((_request, index) => [index ? done() : call()])
      })
    )
    const turn = session.prompt(text('first'))
    await waiting.promise
    session.cancel()
    expect(await turn).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
    expect(await session.prompt(text('next'))).toBe('complete')
  })

  it('blocks uncertain effects until host reconciliation; never repeats execution', async () => {
    const execute = vi.fn(async () => {
      throw new Error('effect may have happened')
    })
    const session = await openAgentSession(
      options({
        tools: [tool({ execute })],
        model: model((_r, index) => [index ? done() : call()])
      })
    )
    await expect(session.prompt(text('effect'))).rejects.toThrow('may have happened')
    const snapshot = await session.snapshot()
    expect(snapshot.run?.status).toBe('blocked')
    await expect(session.continue()).rejects.toThrow('uncertain')
    await session.reconcile(snapshot.pending[0].invocationId, { content: text('verified receipt') })
    expect(await session.continue()).toBe('complete')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('leaves uncertain writes for reload instead of overwriting or repeating effects', async () => {
    const store = memory(),
      commit = store.commit
    const execute = vi.fn(async () => ({ content: text('effect') }))
    store.commit = async (id, revision, next) => {
      const result = await commit(id, revision, next)
      if (next.messages.some((message) => message.role === 'tool'))
        throw new Error('lost acknowledgement')
      return result
    }
    const session = await openAgentSession(
      options({ store, tools: [tool({ execute })], model: model(() => [call()]) })
    )
    await expect(session.prompt(text('work'))).rejects.toThrow('lost acknowledgement')
    await expect(session.continue()).rejects.toThrow('Reload')
    store.commit = commit
    const resumed = await openAgentSession(options({ store }))
    const saved = await resumed.snapshot()
    await resumed.recover(saved.run!.id)
    expect(await resumed.prompt(text('new'))).toBe('complete')
    expect(execute).toHaveBeenCalledOnce()
    expect(
      (await resumed.snapshot()).messages.filter((message) => message.role === 'tool')
    ).toHaveLength(1)
  })

  it('fences a previous worker after explicit recovery without executing its late tool call', async () => {
    const store = memory(),
      gate = deferred<void>(),
      entered = deferred<void>(),
      execute = vi.fn()
    const first = await openAgentSession(
      options({
        store,
        tools: [tool({ execute })],
        model: model(async function* () {
          entered.resolve()
          await gate.promise
          yield call()
        })
      })
    )
    const pending = first.prompt(text('first'))
    await entered.promise
    const second = await openAgentSession(options({ store }))
    await expect(second.prompt(text('conflict'))).rejects.toThrow('recovery')
    await expect(second.recover('wrong')).rejects.toThrow('identity')
    await second.recover((await second.snapshot()).run!.id)
    expect(await second.prompt(text('after takeover'))).toBe('complete')
    gate.resolve()
    await expect(pending).rejects.toThrow('Stale')
    expect(execute).not.toHaveBeenCalled()
  })

  it('switches adapters without leaking opaque provider state; preserves portable text/media/history', async () => {
    const session = await openAgentSession(
      options({ model: model(() => [{ ...done(), providerState: { signature: 'vendor-only' } }]) })
    )
    const media: ContentBlock[] = [
      { type: 'image', mimeType: 'image/png', source: { ref: 'authorized:figure' } },
      { type: 'file', mimeType: 'application/pdf', source: { ref: 'authorized:paper' } }
    ]
    await session.prompt(media)
    session.configure({
      instructions: 'new policy',
      model: model((request) => {
        expect(request.instructions).toBe('new policy')
        expect(request.messages[0].content).toEqual(media)
        expect(request.messages.some((message) => message.providerState)).toBe(false)
        return [done('model-b')]
      }, 'model-b')
    })
    expect(await session.prompt(text('continue'))).toBe('complete')
    expect((await session.snapshot()).messages[1].providerState?.value).toEqual({
      signature: 'vendor-only'
    })
  })

  it('rejects unsupported media before making a provider request', async () => {
    const provider = model(() => [done()])
    provider.capabilities.images = false
    const stream = vi.spyOn(provider, 'stream')
    const session = await openAgentSession(options({ model: provider }))
    await expect(
      session.prompt([{ type: 'image', mimeType: 'image/png', source: 'ref' }])
    ).rejects.toThrow('images')
    expect(stream).not.toHaveBeenCalled()
    expect((await session.snapshot()).requests).toEqual([])
  })

  it('forks only a completed boundary, preserves selected history and isolates subsequent messages', async () => {
    const store = memory(),
      parent = await openAgentSession(options({ store }))
    await parent.prompt(text('ROOT'))
    const boundary = (await parent.snapshot()).messages.at(-1)!.id
    await parent.prompt(text('PARENT_ONLY'))
    await parent.fork('fork', boundary)
    const child = await openAgentSession(
      options({
        store,
        sessionId: 'fork',
        model: model((request) => {
          expect(JSON.stringify(request.messages)).toContain('ROOT')
          expect(JSON.stringify(request.messages)).not.toContain('PARENT_ONLY')
          return [done('CHILD_ONLY')]
        })
      })
    )
    await child.prompt(text('child'))
    expect(JSON.stringify((await parent.snapshot()).messages)).not.toContain('CHILD_ONLY')
    await expect(parent.fork('fork')).rejects.toThrow('already exists')
  })

  it('isolates fork return values and model requests while sharing only frozen store inputs', async () => {
    const store = memory()
    const commit = store.commit
    let committed: AgentCheckpoint | undefined
    store.commit = async (id, revision, next) => {
      if (id === 'child') committed = next
      return commit(id, revision, next)
    }
    const parent = await openAgentSession(options({ store }))
    try {
      await parent.prompt([{ type: 'image', mimeType: 'image/png', source: { nested: ['image'] } }])
      const fork = await parent.fork('child')
      expect(fork.messages).toEqual(committed!.messages)
      expect(fork.messages[0].content).not.toBe(committed!.messages[0].content)
      expect(Object.isFrozen(committed!.messages[0].content[0])).toBe(true)
      expect(Object.isFrozen(fork.messages[0].content[0])).toBe(true)
      store.rows.delete('session')
      const child = await openAgentSession(
        options({
          store,
          sessionId: 'child',
          model: model((request) => {
            expect(Object.isFrozen(request.messages[0].content)).toBe(true)
            expect(() => {
              request.messages[0].content.length = 0
            }).toThrow()
            return [done()]
          })
        })
      )
      try {
        await child.prompt(text('continue after parent deletion'))
        expect((await child.snapshot()).messages[0]).toEqual(fork.messages[0])
      } finally {
        await child.dispose()
      }
    } finally {
      await parent.dispose()
    }
  })

  it('compacts balanced history, preserves originals, reloads the summary and prices instructions/tools', async () => {
    const store = memory(),
      session = await openAgentSession(
        options({
          store,
          instructions: 'trusted',
          tools: [tool()],
          model: model((_r, i) => [i === 0 ? call() : done('long '.repeat(120))])
        })
      )
    await session.prompt(text('old '.repeat(120)))
    await session.prompt(text('recent'))
    const original = (await session.snapshot()).messages
    const measure = vi.fn((request: ModelRequest) => {
      expect(request.instructions).toBe('trusted')
      expect(request.tools).toHaveLength(1)
      return JSON.stringify(request).length
    })
    const result = await session.compact({
      inputBudget: 1300,
      keepRecentItems: 1,
      measure,
      summarize: async () => 'goal and evidence'
    })
    expect(result.status).toBe('committed')
    expect((await session.snapshot()).messages).toEqual(original)
    const reopened = await openAgentSession(
      options({
        store,
        model: model((request) => {
          expect(request.messages[0].role).toBe('summary')
          expect(request.messages[0].content).toEqual(text('goal and evidence'))
          return [done()]
        })
      })
    )
    expect(await reopened.prompt(text('after reload'))).toBe('complete')
  })

  it('keeps parent and child permissions/state separate and waits for real child execution', async () => {
    const store = memory(),
      seen: string[] = []
    const child = await openAgentSession(
      options({
        store,
        sessionId: 'child',
        tools: [
          tool({
            authorize: async (_args, ctx) => {
              seen.push(ctx.sessionId)
              return true
            },
            execute: async () => {
              const { stdout } = await promisify(execFile)(process.execPath, [
                '-e',
                'process.stdout.write(String(17*19))'
              ])
              return { content: text(stdout) }
            }
          })
        ],
        model: model((request, index) => {
          if (!index) return [call()]
          expect(request.messages.at(-1)?.content).toEqual(text('323'))
          return [done('323')]
        })
      })
    )
    const parent = await openAgentSession(
      options({
        store,
        tools: [
          tool({
            name: 'delegate',
            authorize: async (_args, ctx) => {
              seen.push(ctx.sessionId)
              return true
            },
            execute: async (_args, { signal }) => {
              const abort = (): void => child.cancel()
              signal.addEventListener('abort', abort, { once: true })
              try {
                await child.prompt(text('multiply'))
                return { content: (await child.snapshot()).messages.at(-1)!.content }
              } finally {
                signal.removeEventListener('abort', abort)
                await child.dispose()
              }
            }
          })
        ],
        model: model((request, index) => {
          if (!index) return [call('delegate')]
          expect(request.messages.at(-1)?.content).toEqual(text('323'))
          return [done('parent done')]
        })
      })
    )
    expect(await parent.prompt(text('delegate'))).toBe('complete')
    expect(seen).toEqual(['session', 'child'])
    expect((await parent.snapshot()).requests).toHaveLength(2)
    expect((await child.snapshot()).requests).toHaveLength(2)
  })

  it('isolates observer errors from execution and rejects overlapping turns', async () => {
    const observerError = vi.fn(),
      gate = deferred<void>(),
      entered = deferred<void>()
    const session = await openAgentSession(
      options({
        onEvent: () => {
          throw new Error('UI unavailable')
        },
        onObserverError: observerError,
        model: model(async function* () {
          entered.resolve()
          await gate.promise
          yield done()
        })
      })
    )
    const turn = session.prompt(text('first'))
    await entered.promise
    await expect(session.continue()).rejects.toThrow('busy')
    gate.resolve()
    expect(await turn).toBe('complete')
    expect(observerError).toHaveBeenCalled()
  })

  it.each(['missing', 'duplicate', 'length'])(
    'handles a %s finish without falsely completing or executing a partial tool',
    async (kind) => {
      const execute = vi.fn()
      const session = await openAgentSession(
        options({
          tools: [tool({ execute })],
          model: model(() =>
            kind === 'missing'
              ? [{ type: 'tool-delta', index: 0, arguments: '{' }]
              : kind === 'duplicate'
                ? [done(), done()]
                : [{ type: 'finish', reason: 'length', content: text('partial') }]
          )
        })
      )
      if (kind === 'length') expect(await session.prompt(text('go'))).toBe('budget')
      else await expect(session.prompt(text('go'))).rejects.toThrow()
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it('rejects a future checkpoint version and honors durable caller budget admission', async () => {
    const store = memory()
    const session = await openAgentSession(
      options({
        store,
        admit: () => {
          throw new Error('capacity')
        }
      })
    )
    await expect(session.prompt(text('go'))).rejects.toThrow('capacity')
    expect((await session.snapshot()).requests).toHaveLength(0)
    store.rows.get('session')!.version = 2 as 1
    await expect(openAgentSession(options({ store }))).rejects.toThrow('checkpoint')
  })
})
