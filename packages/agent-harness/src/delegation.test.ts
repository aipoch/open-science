import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDelegationTool } from './delegation'
import { createMemoryAgentStore } from './memory-store'
import { createJournalAgentStore } from './journal-store'
import { openAgentSession } from './session'
import type {
  AgentSessionOptions,
  AgentModel,
  AgentTool,
  ModelRequest,
  ToolContext,
  Json,
  ContentBlock
} from './session-types'

const context = (signal = new AbortController().signal, invocationId = 'call'): ToolContext => ({
  sessionId: 'parent',
  runId: 'run',
  invocationId,
  signal,
  update: vi.fn()
})
const model = (
  reply: (request: ModelRequest, signal: AbortSignal) => Promise<string> | string
): AgentModel => ({
  id: 'test',
  capabilities: { tools: true, images: false, files: false },
  async *stream(request, signal) {
    yield {
      type: 'finish',
      reason: 'complete',
      content: [{ type: 'text', text: await reply(request, signal) }],
      usage: { inputTokens: 10, outputTokens: 2 }
    }
  }
})
const sessionOptions = (child: AgentModel): Omit<AgentSessionOptions, 'sessionId'> => ({
  model: child,
  maxSteps: 3,
  maxOutputTokens: 100
})

describe('independent delegated agent tool', () => {
  it('isolates history/capabilities, bounds UTF-8 results and retains child usage/evidence', async () => {
    const store = createMemoryAgentStore()
    const child = model((request) => {
      expect(request.messages.map((m) => m.content)).toEqual([
        [{ type: 'text', text: 'Inspect fixture' }]
      ])
      expect(request.tools).toEqual([])
      expect(request.instructions).toBe('Reviewer instructions')
      return '结果结果结果'
    })
    const owner = createDelegationTool({
      agents: {
        reviewer: {
          description: 'Review',
          session: { ...sessionOptions(child), store, instructions: 'Reviewer instructions' }
        }
      },
      authorize: async () => true,
      maxResultBytes: 7
    })
    const result = await owner.tool.execute(
      { agent: 'reviewer', task: 'Inspect fixture' },
      context()
    )
    if ('waiting' in result) throw new Error('Unexpected wait')
    const receipt = JSON.parse((result.content[0] as { text: string }).text)
    expect(receipt).toMatchObject({
      result: '结果',
      status: 'complete',
      truncated: true,
      requests: [{ usage: { inputTokens: 10, outputTokens: 2 } }]
    })
    expect((await store.load(receipt.taskId))?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: '结果结果结果' }
    ])
    await expect(
      owner.tool.execute({ agent: 'reviewer', task: 'Inspect fixture' }, context())
    ).rejects.toThrow('already exists')
    await owner.dispose()
  })

  it('runs parent authorization before creating a child', async () => {
    const child = vi.fn(() => 'child')
    const owner = createDelegationTool({
      agents: { worker: { description: '', session: sessionOptions(model(child)) } },
      authorize: async () => false
    })
    let calls = 0
    const parent: AgentModel = {
      ...model(() => ''),
      async *stream() {
        yield calls++ === 0
          ? {
              type: 'finish',
              reason: 'tools',
              content: [],
              calls: [
                { id: 'call', name: 'delegate_task', arguments: { agent: 'worker', task: 'work' } }
              ]
            }
          : { type: 'finish', reason: 'complete', content: [{ type: 'text', text: 'Denied' }] }
      }
    }
    const session = await openAgentSession({
      ...sessionOptions(parent),
      sessionId: 'parent',
      tools: [owner.tool]
    })
    expect(await session.prompt([{ type: 'text', text: 'private parent history' }])).toBe(
      'complete'
    )
    expect(child).not.toHaveBeenCalled()
    await session.dispose()
    await owner.dispose()
  })

  it('completes parallel delegated tasks through the parent loop without copying child history', async () => {
    let entered = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const owner = createDelegationTool({
      agents: {
        worker: {
          description: 'Inspect text',
          session: sessionOptions(
            model(async (request) => {
              expect(request.messages).toHaveLength(1)
              if (++entered === 2) release()
              await barrier
              return 'CHILD_FINAL'
            })
          )
        }
      },
      authorize: async () => true,
      maxConcurrent: 2
    })
    let calls = 0
    const parent: AgentModel = {
      ...model(() => ''),
      async *stream(request) {
        if (calls++ === 0) {
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: ['a', 'b'].map((id) => ({
              id,
              name: 'delegate_task',
              arguments: { agent: 'worker', task: id }
            }))
          }
        } else {
          const results = request.messages.filter((message) => message.role === 'tool')
          expect(results).toHaveLength(2)
          const receipts = results.map((message) =>
            JSON.parse((message.content[0] as { text: string }).text)
          )
          expect(new Set(receipts.map((receipt) => receipt.taskId)).size).toBe(2)
          expect(
            receipts.every(
              (receipt) => receipt.result === 'CHILD_FINAL' && receipt.requests.length === 1
            )
          ).toBe(true)
          expect(request.messages.filter((message) => message.role === 'user')).toHaveLength(1)
          yield {
            type: 'finish',
            reason: 'complete',
            content: [{ type: 'text', text: 'Both tasks completed' }]
          }
        }
      }
    }
    const session = await openAgentSession({
      ...sessionOptions(parent),
      sessionId: 'parent',
      tools: [owner.tool]
    })
    try {
      expect(await session.prompt([{ type: 'text', text: 'Parent private instructions' }])).toBe(
        'complete'
      )
      expect(entered).toBe(2)
    } finally {
      release()
      await session.dispose()
      await owner.dispose()
    }
  })

  it('propagates cancellation and keeps capacity until child cleanup settles', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const draining = new Promise<void>((resolve) => {
      release = resolve
    })
    const child = model(async (_request, signal) => {
      entered()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
      await draining
      return 'cancelled'
    })
    const owner = createDelegationTool({
      agents: { worker: { description: '', session: sessionOptions(child) } },
      authorize: async () => true,
      maxConcurrent: 1
    })
    const abort = new AbortController()
    const running = owner.tool.execute({ agent: 'worker', task: 'work' }, context(abort.signal))
    await started
    abort.abort()
    expect(
      await owner.tool.execute({ agent: 'worker', task: 'work' }, context(undefined, 'other'))
    ).toMatchObject({ isError: true })
    let disposed = false
    const closing = owner.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await running
    await closing
    await expect(owner.tool.execute({ agent: 'worker', task: 'work' }, context())).rejects.toThrow(
      'disposed'
    )
  })

  it('enforces child guards and never treats uncertain effects as a completed task', async () => {
    const execute = vi.fn(async () => {
      throw new Error('lost tool receipt')
    })
    const work: AgentTool = {
      name: 'work',
      version: '1',
      description: '',
      parameters: {},
      validate: (x) => x,
      authorize: async () => true,
      execute
    }
    const child: AgentModel = {
      ...model(() => ''),
      async *stream() {
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [{ id: 'effect', name: 'work', arguments: {} }]
        }
      }
    }
    const blocked = createDelegationTool({
      agents: {
        worker: {
          description: '',
          session: { ...sessionOptions(child), tools: [work], guards: [() => 'deny'] }
        }
      },
      authorize: async () => true
    })
    expect(await blocked.tool.execute({ agent: 'worker', task: 'work' }, context())).toMatchObject({
      isError: true
    })
    expect(execute).not.toHaveBeenCalled()
    await blocked.dispose()
    const uncertain = createDelegationTool({
      agents: { worker: { description: '', session: { ...sessionOptions(child), tools: [work] } } },
      authorize: async () => true
    })
    await expect(
      uncertain.tool.execute({ agent: 'worker', task: 'work' }, context())
    ).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(1)
    await uncertain.dispose()
  })

  it('preserves bounded portable media and explicitly omits oversized/private references', async () => {
    const image: ContentBlock = {
      type: 'image',
      mimeType: 'image/png',
      source: 'data:image/png;base64,YQ=='
    }
    const file: ContentBlock = {
      type: 'file',
      mimeType: 'application/pdf',
      source: { url: 'https://example.com/result.pdf' }
    }
    const privateFile: ContentBlock = {
      type: 'file',
      mimeType: 'application/pdf',
      source: { adapterId: 'child', fileId: 'file_1' }
    }
    const large: ContentBlock = {
      type: 'image',
      mimeType: 'image/png',
      source: 'data:image/png;base64,' + 'YQ=='.repeat(100)
    }
    const content: ContentBlock[] = [
      { type: 'text', text: '结果' },
      large,
      image,
      privateFile,
      file
    ]
    const store = createMemoryAgentStore()
    const child: AgentModel = {
      ...model(() => ''),
      async *stream() {
        yield { type: 'finish', reason: 'complete', content }
      }
    }
    const owner = createDelegationTool({
      agents: { worker: { description: '', session: { ...sessionOptions(child), store } } },
      authorize: async () => true,
      maxResultBytes:
        Buffer.byteLength('结果') +
        Buffer.byteLength(JSON.stringify(image)) +
        Buffer.byteLength(JSON.stringify(file))
    })
    try {
      const result = await owner.tool.execute({ agent: 'worker', task: 'work' }, context())
      if ('waiting' in result) throw new Error('Unexpected wait')
      expect(result.content.slice(1)).toEqual([image, file])
      const receipt = JSON.parse((result.content[0] as { text: string }).text)
      expect(receipt).toMatchObject({ result: '结果', truncated: true, omittedMedia: 2 })
      expect((await store.load(receipt.taskId))?.messages.at(-1)?.content).toEqual(content)
    } finally {
      await owner.dispose()
    }
  })

  it('releases a waiting child and resumes both durable sessions without replaying the question', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-delegate-wait-'))
    const store = (): ReturnType<typeof createJournalAgentStore> =>
      createJournalAgentStore({ directory })
    const ask = vi.fn(async () => ({ waiting: { question: 'Which sample?' } }))
    const question: AgentTool = {
      name: 'ask',
      version: '1',
      description: '',
      parameters: {},
      validate: (x) => x,
      authorize: async () => true,
      execute: ask
    }
    const child: AgentModel = {
      ...model(() => ''),
      async *stream(request) {
        yield request.messages.some((message) => message.role === 'tool')
          ? {
              type: 'finish',
              reason: 'complete',
              content: [{ type: 'text', text: 'Sample A reviewed' }]
            }
          : {
              type: 'finish',
              reason: 'tools',
              content: [],
              calls: [{ id: 'ask', name: 'ask', arguments: {} }]
            }
      }
    }
    const childOptions = (): Omit<AgentSessionOptions, 'sessionId'> => ({
      ...sessionOptions(child),
      store: store(),
      tools: [question]
    })
    const makeOwner = (): ReturnType<typeof createDelegationTool> =>
      createDelegationTool({
        agents: { worker: { description: '', session: childOptions() } },
        authorize: async () => true,
        maxConcurrent: 1
      })
    const parentModel: AgentModel = {
      ...model(() => ''),
      async *stream(request) {
        yield request.messages.some((message) => message.role === 'tool')
          ? { type: 'finish', reason: 'complete', content: [{ type: 'text', text: 'Done' }] }
          : {
              type: 'finish',
              reason: 'tools',
              content: [],
              calls: [
                {
                  id: 'child',
                  name: 'delegate_task',
                  arguments: { agent: 'worker', task: 'Review sample' }
                }
              ]
            }
      }
    }
    let owner = makeOwner()
    let parent = await openAgentSession({
      ...sessionOptions(parentModel),
      sessionId: 'parent',
      store: store(),
      tools: [owner.tool]
    })
    let resumed: Awaited<ReturnType<typeof openAgentSession>> | undefined
    try {
      expect(await parent.prompt([{ type: 'text', text: 'Review' }])).toBe('waiting')
      const pending = (await parent.snapshot()).pending[0]
      const receipt = pending.interaction as {
        type: string
        taskId: string
        agent: string
        parentSessionId: string
        parentInvocationId: string
      }
      expect(receipt).toEqual({
        type: 'delegation',
        agent: 'worker',
        taskId: expect.stringMatching(/^delegate-/),
        parentSessionId: 'parent',
        parentInvocationId: pending.invocationId
      })
      // A wait releases execution capacity; only durable data remains owned by the host.
      const another = await owner.tool.execute(
        { agent: 'worker', task: 'Other sample' },
        context(undefined, 'other')
      )
      expect(another).toHaveProperty('waiting')
      await parent.dispose()
      await owner.dispose()
      owner = makeOwner()
      parent = await openAgentSession({
        ...sessionOptions(parentModel),
        sessionId: 'parent',
        store: store(),
        tools: [owner.tool]
      })
      resumed = await openAgentSession({ ...childOptions(), sessionId: receipt.taskId })
      const childPending = (await resumed.snapshot()).pending[0]
      expect(childPending.interaction).toEqual({ question: 'Which sample?' })
      await resumed.respond(childPending.invocationId, { content: [{ type: 'text', text: 'A' }] })
      await expect(resumed.respond(childPending.invocationId, { content: [] })).rejects.toThrow(
        'identity changed'
      )
      expect(await resumed.continue()).toBe('complete')
      const final = (await resumed.snapshot()).messages.at(-1)!.content
      await resumed.dispose()
      // Trusted host validates the receipt relationship and bounds the answer before submission.
      await parent.respond(pending.invocationId, { content: final })
      await expect(parent.respond(pending.invocationId, { content: [] })).rejects.toThrow(
        'identity changed'
      )
      expect(await parent.continue()).toBe('complete')
      expect(ask).toHaveBeenCalledTimes(2)
      expect((await parent.snapshot()).pending).toEqual([])
      await expect(
        owner.tool.execute(
          { agent: 'worker', task: 'Review sample' },
          { ...context(), invocationId: pending.invocationId }
        )
      ).rejects.toThrow('already exists')
    } finally {
      await resumed?.dispose()
      await parent.dispose()
      await owner.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not advertise recoverable waiting without a host-owned child store', async () => {
    const child: AgentModel = {
      ...model(() => ''),
      async *stream() {
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [{ id: 'ask', name: 'ask', arguments: {} }]
        }
      }
    }
    const owner = createDelegationTool({
      agents: {
        worker: {
          description: '',
          session: {
            ...sessionOptions(child),
            tools: [
              {
                name: 'ask',
                version: '1',
                description: '',
                parameters: {},
                validate: (x) => x,
                authorize: async () => true,
                execute: async () => ({ waiting: 'question' })
              }
            ]
          }
        }
      },
      authorize: async () => true
    })
    try {
      await expect(
        owner.tool.execute({ agent: 'worker', task: 'work' }, context())
      ).rejects.toThrow('host-supplied child store')
    } finally {
      await owner.dispose()
    }
  })

  it('waits for a host-owned child process to exit on repeated owner disposal', async () => {
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    let childProcess: ReturnType<typeof spawn> | undefined
    let exited = false
    let drain: Promise<void> | undefined
    const execute: AgentTool['execute'] = async (_input, context) => {
      const proc = spawn(
        process.execPath,
        ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      childProcess = proc
      drain = new Promise<void>((resolve, reject) => {
        proc.once('error', reject)
        proc.once('close', () => {
          exited = true
          resolve()
        })
      })
      const stop = (): void => {
        proc.kill()
      }
      context.signal.addEventListener('abort', stop, { once: true })
      if (context.signal.aborted) stop()
      proc.stdout!.once('data', ready)
      try {
        await drain
        return { content: [] }
      } finally {
        context.signal.removeEventListener('abort', stop)
      }
    }
    const child: AgentModel = {
      ...model(() => ''),
      async *stream() {
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [{ id: 'process', name: 'process', arguments: {} }]
        }
      }
    }
    const owner = createDelegationTool({
      agents: {
        worker: {
          description: '',
          session: {
            ...sessionOptions(child),
            tools: [
              {
                name: 'process',
                version: '1',
                description: '',
                parameters: {},
                validate: (x) => x,
                authorize: async () => true,
                execute
              }
            ]
          }
        }
      },
      authorize: async () => true
    })
    const running = owner.tool.execute({ agent: 'worker', task: 'work' }, context())
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error('Child did not start')
        })
      ])
      await Promise.all([owner.dispose(), owner.dispose()])
      expect(exited).toBe(true)
      expect(await running).toMatchObject({ isError: true })
    } finally {
      if (childProcess && !exited) childProcess.kill('SIGKILL')
      await drain
      await owner.dispose()
    }
  })

  it('rejects unknown agents, extra capabilities and invalid budgets', () => {
    const agents = { worker: { description: '', session: sessionOptions(model(() => 'ok')) } }
    expect(() =>
      createDelegationTool({ agents, authorize: async () => true, maxConcurrent: 0 })
    ).toThrow()
    const { tool } = createDelegationTool({ agents, authorize: async () => true })
    for (const input of [
      { agent: 'missing', task: 'work' },
      { agent: 'worker', task: ' ' },
      { agent: 'worker', task: 'work', tools: ['shell'] }
    ] as Json[])
      expect(() => tool.validate(input)).toThrow()
  })
})
