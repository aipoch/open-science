import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { toolResultPage, toolResultView } from './tool-results'
import { openAgentSession } from './session'
import { createJournalAgentStore } from './journal-store'
import { createMemoryAgentStore } from './memory-store'
import type {
  AgentMessage,
  AgentModel,
  ModelRequest,
  ModelEvent,
  AgentSessionOptions
} from './session-types'

const text = (value: string): AgentMessage['content'] => [{ type: 'text', text: value }]
const measure = (request: ModelRequest): number => Buffer.byteLength(JSON.stringify(request))
const summary =
  '## Goal\nKeep working.\n## Progress\nPrior effects complete.\n## Evidence\nRecorded.\n## Next\nFollow the preserved user request.'

it('keeps bounded Unicode head/tail and media while the original middle remains readable', () => {
  const original = {
    content: [
      ...text('🙂'.repeat(12000) + 'EXACT_MIDDLE=42' + '終'.repeat(12000)),
      { type: 'image' as const, mimeType: 'image/png', source: 'original-bytes' }
    ],
    isError: true
  }
  const measureText = (blocks: AgentMessage['content']): number =>
    Buffer.byteLength(JSON.stringify(blocks))
  const view = toolResultView(original, 'invocation', 2048, measureText)!
  expect(measureText(view)).toBeLessThanOrEqual(2048)
  expect(view).toContainEqual(original.content[1])
  expect(JSON.stringify(view)).not.toContain('EXACT_MIDDLE=42')
  expect(JSON.stringify(view)).not.toMatch(/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/)
  const page = toolResultPage(
    { id: 'result', role: 'tool', invocationId: 'invocation', ...original },
    12000,
    16,
    () => true
  )
  expect(page.text).toBe('EXACT_MIDDLE=42終')
  expect(page).toMatchObject({ isError: true, nextOffset: 12016 })
  expect(original.content[0]).toEqual(
    text('🙂'.repeat(12000) + 'EXACT_MIDDLE=42' + '終'.repeat(12000))[0]
  )
})

it('bounds newline-heavy previews and validates page ranges without rewriting small results', () => {
  const small = { content: text('small') }
  expect(
    toolResultView(small, 'i', 1000, (blocks) => JSON.stringify(blocks).length)
  ).toBeUndefined()
  const view = toolResultView(
    { content: text('line\n'.repeat(3000)) },
    'i',
    50000,
    (blocks) => JSON.stringify(blocks).length
  )!
  const shown = view.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
  expect(shown.split('\n').length).toBeLessThanOrEqual(2000)
  const message: AgentMessage = {
    id: 'r',
    invocationId: 'i',
    role: 'tool',
    content: [...text('甲🙂'), ...text('乙')]
  }
  expect(toolResultPage(message, 1, 3, () => true)).toMatchObject({
    text: '🙂\n乙',
    nextOffset: null,
    totalCharacters: 4
  })
  for (const [offset, limit] of [
    [-1, 2],
    [0, 0],
    [0, 8193],
    [5, 1],
    [0.5, 2]
  ])
    expect(() => toolResultPage(message, offset, limit, () => true)).toThrow()
  expect(() => toolResultPage(message, 0, 2, () => false)).toThrow('budget')
})

it('reads the original middle without repeating an effect and preserves the preview on restart/fork', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-result-pages-'))
  try {
    const store = createJournalAgentStore({ directory })
    let effects = 0,
      calls = 0,
      originalInvocation = '',
      view: AgentMessage['content'] | undefined
    const original = 'x'.repeat(30000) + 'EXACT_MIDDLE=42' + 'y'.repeat(30000)
    const model: AgentModel = {
      id: 'fixture',
      capabilities: { tools: true, images: true, files: true },
      async *stream(request) {
        calls++
        if (calls === 1)
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [{ id: 'effect', name: 'effect', arguments: {} }]
          }
        else if (calls === 2) {
          const result = request.messages.find((message) => message.role === 'tool')!
          view = structuredClone(result.content)
          originalInvocation = result.invocationId!
          expect(JSON.stringify(view)).not.toContain('EXACT_MIDDLE=42')
          expect(JSON.stringify(view)).toContain('read_tool_result')
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [
              {
                id: 'page',
                name: 'read_tool_result',
                arguments: { invocationId: originalInvocation, offset: 30000, limit: 16 }
              }
            ]
          }
        } else {
          expect(JSON.stringify(request.messages.at(-1)?.content)).toContain('EXACT_MIDDLE=42')
          expect(
            request.messages.find((message) => message.invocationId === originalInvocation)?.content
          ).toEqual(view)
          yield { type: 'finish', reason: 'complete', content: text('done') }
        }
      }
    }
    const options: AgentSessionOptions = {
      sessionId: 'parent',
      store,
      model,
      maxSteps: 8,
      maxOutputTokens: 100,
      compaction: { inputBudget: 20000, keepRecentItems: 1, maxOutputTokens: 100, measure },
      toolResults: { authorize: async () => true },
      tools: [
        {
          name: 'effect',
          version: '1',
          description: 'effect',
          parameters: { type: 'object' },
          validate: (input) => input,
          authorize: async () => true,
          async execute() {
            effects++
            return { content: text(original) }
          }
        }
      ]
    }
    const session = await openAgentSession(options)
    expect(
      await session.prompt(text('Find the middle fact; execute the original tool once.'))
    ).toBe('complete')
    expect(effects).toBe(1)
    const saved = await session.snapshot()
    expect(
      saved.messages.find((message) => message.invocationId === originalInvocation)
    ).toMatchObject({ content: text(original), modelContent: view })
    session.configure({
      ...options,
      instructions: 'Changed instructions on another model route.',
      model: {
        ...model,
        id: 'changed-route',
        async *stream(request) {
          expect(request.tools.some((tool) => tool.name === 'read_tool_result')).toBe(true)
          expect(
            request.messages.find((message) => message.invocationId === originalInvocation)?.content
          ).toEqual(view)
          yield { type: 'finish', reason: 'complete', content: text('done') }
        }
      }
    })
    expect(await session.continue()).toBe('complete')
    await session.fork('child')
    await session.dispose()
    await expect(session.readToolResult(originalInvocation)).rejects.toThrow('disposed')
    const reopened = await openAgentSession({
      ...options,
      store: createJournalAgentStore({ directory })
    })
    expect((await reopened.readToolResult(originalInvocation, 30000, 16)).text).toContain(
      'EXACT_MIDDLE=42'
    )
    expect(
      (await reopened.snapshot()).messages.find(
        (message) => message.invocationId === originalInvocation
      )?.modelContent
    ).toEqual(view)
    await reopened.dispose()
    const child = await openAgentSession({
      ...options,
      sessionId: 'child',
      store: createJournalAgentStore({ directory })
    })
    expect((await child.readToolResult(originalInvocation, 30000, 16)).text).toContain(
      'EXACT_MIDDLE=42'
    )
    await child.dispose()
    const stranger = await openAgentSession({ ...options, sessionId: 'stranger' })
    await expect(stranger.readToolResult(originalInvocation)).rejects.toThrow('Unknown tool result')
    await stranger.dispose()
    expect(effects).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps the latest user verbatim through repeated automatic compactions within one turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-retained-user-'))
  try {
    let effects = 0,
      summaries = 0
    const latest = 'Never publish. Finish only after seven inspections.'
    const model: AgentModel = {
      id: 'fixture',
      capabilities: { tools: true, images: false, files: false },
      async *stream(request) {
        if (
          JSON.stringify(request.messages.at(-1)?.content).includes(
            'Create a compact continuation checkpoint'
          )
        ) {
          summaries++
          yield { type: 'finish', reason: 'complete', content: text(summary) }
          return
        }
        expect(
          request.messages.filter(
            (message) =>
              message.role === 'user' &&
              message.content[0].type === 'text' &&
              message.content[0].text === latest
          )
        ).toHaveLength(1)
        if (effects < 7)
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [{ id: String(effects), name: 'inspect', arguments: {} }]
          }
        else yield { type: 'finish', reason: 'complete', content: text('done') }
      }
    }
    const options: AgentSessionOptions = {
      sessionId: 's',
      store: createJournalAgentStore({ directory }),
      model,
      maxSteps: 12,
      maxOutputTokens: 100,
      compaction: { inputBudget: 4500, keepRecentItems: 1, maxOutputTokens: 200, measure },
      tools: [
        {
          name: 'inspect',
          version: '1',
          description: 'inspect',
          parameters: { type: 'object' },
          validate: (input) => input,
          authorize: async () => true,
          async execute() {
            effects++
            return { content: text(`completed ${effects}:` + 'x'.repeat(1400)) }
          }
        }
      ]
    }
    const session = await openAgentSession(options)
    expect(await session.prompt(text(latest))).toBe('complete')
    expect(summaries).toBeGreaterThanOrEqual(2)
    expect(effects).toBe(7)
    await session.dispose()
    const resumed = await openAgentSession({
      ...options,
      store: createJournalAgentStore({ directory })
    })
    expect(await resumed.continue()).toBe('complete')
    expect(effects).toBe(7)
    await resumed.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('settles a crashed intrinsic read without repeating an effect or inheriting authorization', async () => {
  const store = createMemoryAgentStore()
  let crash = true,
    effects = 0,
    authorizations = 0
  const options: AgentSessionOptions = {
    sessionId: 'crashed-reader',
    store: {
      load: store.load,
      commit: async (id, revision, state) => {
        if (crash && state.messages.filter((message) => message.role === 'tool').length === 2)
          throw new Error('simulated result write failure')
        return store.commit(id, revision, state)
      }
    },
    maxSteps: 5,
    maxOutputTokens: 100,
    compaction: { inputBudget: 20000, keepRecentItems: 1, maxOutputTokens: 100, measure },
    toolResults: {
      authorize: async () => {
        authorizations++
        return true
      }
    },
    tools: [
      {
        name: 'effect',
        version: '1',
        description: 'effect',
        parameters: { type: 'object' },
        validate: (input) => input,
        authorize: async () => true,
        execute: async () => {
          effects++
          return { content: text('evidence') }
        }
      }
    ],
    model: {
      id: 'fixture',
      capabilities: { tools: true, images: false, files: false },
      async *stream(request): AsyncGenerator<ModelEvent> {
        const results = request.messages.filter((message) => message.role === 'tool')
        if (results.length > 1 && !results.at(-1)!.isError) {
          expect(JSON.stringify(results.at(-1)!.content)).toContain('evidence')
          yield { type: 'finish', reason: 'complete', content: text('done') }
        } else
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [
              {
                id: `call-${results.length}`,
                name: results.length ? 'read_tool_result' : 'effect',
                arguments: results.length ? { invocationId: results[0].invocationId! } : {}
              }
            ]
          }
      }
    }
  }
  const first = await openAgentSession(options)
  await expect(first.prompt(text('read evidence'))).rejects.toThrow(
    'simulated result write failure'
  )
  await first.dispose()
  crash = false
  const resumed = await openAgentSession(options)
  const before = await resumed.inspect()
  expect(before.pending[0].status).toBe('started')
  await resumed.recover(before.run!.id)
  expect((await resumed.inspect()).pending).toEqual([])
  expect(authorizations).toBe(1)
  expect((await resumed.snapshot()).messages.at(-1)).toMatchObject({ role: 'tool', isError: true })
  expect(await resumed.continue()).toBe('complete')
  expect(authorizations).toBe(2)
  expect(effects).toBe(1)
  await resumed.dispose()
})

it.each(['denied', 'cancelled'] as const)(
  'honors host %s authorization for original-result reads',
  async (outcome) => {
    let calls = 0,
      authorized = 0
    const session = await openAgentSession({
      sessionId: 'private',
      maxSteps: 3,
      maxOutputTokens: 100,
      compaction: { inputBudget: 20000, keepRecentItems: 1, maxOutputTokens: 100, measure },
      toolResults: {
        authorize: async (_args, context) => {
          authorized++
          expect(context.sessionId).toBe('private')
          if (outcome === 'cancelled') session.cancel()
          return outcome === 'cancelled'
        }
      },
      model: {
        id: 'fixture',
        capabilities: { tools: true, images: false, files: false },
        async *stream(request) {
          if (++calls === 1)
            yield {
              type: 'finish',
              reason: 'tools',
              content: [],
              calls: [
                {
                  id: 'read',
                  name: 'read_tool_result',
                  arguments: { invocationId: 'another-session' }
                }
              ]
            }
          else {
            const result = request.messages.find((message) => message.role === 'tool')!
            expect(result.isError).toBe(true)
            expect(JSON.stringify(result.content)).toMatch(/denied/i)
            // Execution would instead return the bounded unavailable-result error.
            expect(JSON.stringify(result.content)).not.toContain('unavailable')
            yield { type: 'finish', reason: 'complete', content: text('done') }
          }
        }
      }
    })
    expect(await session.prompt(text('read'))).toBe(
      outcome === 'cancelled' ? 'cancelled' : 'complete'
    )
    expect(authorized).toBe(1)
    if (outcome === 'cancelled') expect(calls).toBe(1)
    await session.dispose()
  }
)

it.each(['invalid-text', 'tool-proposal', 'transport-error'] as const)(
  'resumes after %s summary failure and journal reopen without repeating an effect',
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-summary-recovery-'))
    let effects = 0,
      reads = 0,
      summaries = 0
    const events: string[] = []
    const original = 'x'.repeat(30000) + 'RECOVERY_RECEIPT=42' + 'y'.repeat(30000)
    const finish = (value: string): ModelEvent => ({
      type: 'finish',
      reason: 'complete',
      content: text(value)
    })
    const common: Omit<AgentSessionOptions, 'model' | 'store'> = {
      sessionId: 'recovery',
      maxSteps: 4,
      maxOutputTokens: 256,
      toolResults: {
        authorize: async () => {
          reads++
          return true
        }
      },
      tools: [
        {
          name: 'effect',
          version: '1',
          description: 'Execute once',
          parameters: {},
          validate: (value) => value,
          authorize: async () => true,
          execute: async () => {
            effects++
            return { content: text(original) }
          }
        }
      ],
      compaction: {
        inputBudget: 50000,
        keepRecentItems: 1,
        keepRecentTokens: 1,
        maxOutputTokens: 256,
        measure
      },
      onEvent(event) {
        if (event.type === 'compaction') events.push(event.status)
      }
    }
    const capabilities = { tools: true, images: false, files: false }
    let seeded = false
    let session = await openAgentSession({
      ...common,
      store: createJournalAgentStore({ directory }),
      model: {
        id: 'fixture',
        capabilities,
        async *stream() {
          if (!seeded) {
            seeded = true
            yield {
              type: 'finish',
              reason: 'tools',
              content: [],
              calls: [{ id: 'effect-once', name: 'effect', arguments: {} }]
            }
          } else yield finish('archived observation '.repeat(500))
        }
      }
    })
    try {
      expect(await session.prompt(text('Perform the operation once.'))).toBe('complete')
      const before = await session.snapshot()
      const result = before.messages.find((message) => message.role === 'tool')!
      expect(result.modelContent).toBeDefined()
      expect(JSON.stringify(result.modelContent)).not.toContain('RECOVERY_RECEIPT=42')
      await session.dispose()
      const options: AgentSessionOptions = {
        ...common,
        store: createJournalAgentStore({ directory }),
        compaction: { ...common.compaction!, inputBudget: 4000 },
        model: {
          id: 'fixture',
          capabilities,
          async *stream(request) {
            if (JSON.stringify(request.messages.at(-1)).includes('Create a compact continuation')) {
              summaries++
              if (summaries === 1) {
                if (failure === 'transport-error') throw new Error('summary transport failed')
                yield failure === 'invalid-text'
                  ? { ...finish('unstructured'), usage: { inputTokens: 31, outputTokens: 7 } }
                  : {
                      type: 'finish',
                      reason: 'tools',
                      content: [],
                      calls: [{ id: 'must-not-run', name: 'effect', arguments: {} }],
                      usage: { inputTokens: 31, outputTokens: 7 }
                    }
              } else yield finish(summary)
            } else if (request.messages.at(-1)?.role === 'user') {
              expect(request.messages.at(-1)?.content).toEqual(
                text('Retrieve the missing receipt.')
              )
              yield {
                type: 'finish',
                reason: 'tools',
                content: [],
                calls: [
                  {
                    id: 'read-receipt',
                    name: 'read_tool_result',
                    arguments: { invocationId: result.invocationId!, offset: 30000, limit: 19 }
                  }
                ]
              }
            } else {
              expect(JSON.stringify(request.messages.at(-1))).toContain('RECOVERY_RECEIPT=42')
              yield finish('RECOVERY_RECEIPT=42')
            }
          }
        }
      }
      session = await openAgentSession(options)
      await expect(session.prompt(text('Retrieve the missing receipt.'))).rejects.toThrow(
        failure === 'invalid-text'
          ? 'Invalid continuation summary'
          : failure === 'tool-proposal'
            ? 'tool-free summary'
            : 'summary transport failed'
      )
      const rejected = await session.snapshot()
      expect(rejected.messages.slice(0, before.messages.length)).toEqual(before.messages)
      expect(rejected.compactions).toEqual([])
      expect(rejected.pending).toEqual([])
      expect(rejected.requests.at(-1)).toMatchObject({ purpose: 'compaction', status: 'failed' })
      if (failure !== 'transport-error')
        expect(rejected.requests.at(-1)?.usage).toEqual({ inputTokens: 31, outputTokens: 7 })
      expect(effects).toBe(1)
      expect(summaries).toBe(1)
      expect(reads).toBe(0)
      await session.dispose()
      session = await openAgentSession({
        ...options,
        store: createJournalAgentStore({ directory })
      })
      expect(await session.continue()).toBe('complete')
      const recovered = await session.snapshot()
      expect(recovered.messages.slice(0, rejected.messages.length)).toEqual(rejected.messages)
      expect(
        recovered.requests
          .filter((request) => request.purpose === 'compaction')
          .map((request) => request.status)
      ).toEqual(['failed', 'completed'])
      expect(recovered.messages.filter((message) => message.role === 'user')).toHaveLength(2)
      expect(await session.readToolResult(result.invocationId!, 30000, 19)).toMatchObject({
        text: 'RECOVERY_RECEIPT=42'
      })
      expect(effects).toBe(1)
      expect(reads).toBe(1)
      expect(summaries).toBe(2)
      expect(events).toEqual(['started', 'failed', 'started', 'finished'])
    } finally {
      await session.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
