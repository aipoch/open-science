import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import {
  createAgentRunner,
  createDelegationTool,
  compactContext,
  executeToolCall,
  openAgentSession,
  createMemoryAgentStore,
  createJsonFileAgentStore,
  createJournalAgentStore
} from '@aipoch/agent-harness'
const require = createRequire(import.meta.url)
assert.equal(require('@aipoch/agent-harness').createDelegationTool, createDelegationTool)
assert.equal(require('@aipoch/agent-harness').createAgentRunner, createAgentRunner)
assert.equal(require('@aipoch/agent-harness').executeToolCall, executeToolCall)
assert.equal(require('@aipoch/agent-harness').openAgentSession, openAgentSession)
assert.equal(require('@aipoch/agent-harness').createMemoryAgentStore, createMemoryAgentStore)
assert.equal(require('@aipoch/agent-harness').createJsonFileAgentStore, createJsonFileAgentStore)
assert.equal(require('@aipoch/agent-harness').createJournalAgentStore, createJournalAgentStore)
const journal = createJournalAgentStore({ directory: './journal', snapshotMinRevisions: 1 })
const baseline = {
  version: 1,
  sessionId: 'journal',
  revision: 0,
  messages: [],
  compactions: [],
  requests: [],
  pending: []
}
assert.equal(await journal.commit('journal', null, baseline), true)
const recorded = {
  ...baseline,
  revision: 1,
  messages: [{ id: 'message', role: 'user', content: [{ type: 'text', text: 'evidence' }] }]
}
assert.equal(await journal.commit('journal', 0, recorded), true)
assert.deepEqual(
  await createJournalAgentStore({ directory: './journal' }).load('journal'),
  recorded
)
assert.equal(await journal.commit('journal', 0, recorded), false)
require('node:child_process').execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict'; import {createJournalAgentStore} from '@aipoch/agent-harness'; const store=createJournalAgentStore({directory:'./journal'}); const state=await store.load('journal'); assert.equal(state.revision,1); assert.equal(await store.commit('journal',1,{...state,revision:2}),true);"
  ],
  { cwd: process.cwd(), stdio: 'inherit' }
)
assert.equal((await journal.load('journal')).revision, 2)
// Exercise the packed public delegation API, including portable final content.
const delegatedImage = {
  type: 'image',
  mimeType: 'image/png',
  source: 'data:image/png;base64,YQ=='
}
const delegation = createDelegationTool({
  agents: {
    worker: {
      description: 'fixture',
      session: {
        maxSteps: 1,
        maxOutputTokens: 16,
        model: {
          id: 'child',
          capabilities: { tools: false, images: true, files: false },
          async *stream() {
            yield { type: 'finish', reason: 'complete', content: [delegatedImage] }
          }
        }
      }
    }
  },
  authorize: async () => true
})
try {
  const result = await delegation.tool.execute(
    { agent: 'worker', task: 'render' },
    {
      sessionId: 'consumer',
      invocationId: 'delegate',
      runId: 'run',
      signal: new AbortController().signal,
      update() {
        // This fixture only returns final content.
      }
    }
  )
  assert.equal('waiting' in result, false)
  assert.deepEqual(result.content.slice(1), [delegatedImage])
  assert.equal(JSON.parse(result.content[0].text).status, 'complete')
} finally {
  await delegation.dispose()
}
const store = createMemoryAgentStore()
let modelCalls = 0,
  toolCalls = 0,
  transforms = 0,
  guards = 0
const session = await openAgentSession({
  sessionId: 'standalone',
  store,
  maxSteps: 3,
  maxOutputTokens: 128,
  instructions: 'Use only the supplied host capability.',
  transformContext: async (messages) => {
    transforms++
    assert.ok(Object.isFrozen(messages))
    return [
      { id: 'transient', role: 'user', content: [{ type: 'text', text: 'retrieved' }] },
      ...messages
    ]
  },
  admit: (request) => {
    assert.equal(request.messages[0].id, 'transient')
  },
  guards: [
    async (args) => {
      guards++
      assert.ok(Object.isFrozen(args))
      return 'abstain'
    }
  ],
  model: {
    id: 'consumer-fixture',
    capabilities: { tools: true, images: false, files: false },
    async *stream(request, signal) {
      signal.throwIfAborted()
      assert.equal(request.instructions, 'Use only the supplied host capability.')
      if (modelCalls++ === 0) {
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [{ id: 'call', name: 'sum', arguments: { values: [3, 5, 8] } }]
        }
      } else {
        assert.equal(request.messages.at(-1).content[0].text, '16')
        yield { type: 'text-delta', text: '16' }
        yield { type: 'finish', reason: 'complete', content: [{ type: 'text', text: '16' }] }
      }
    }
  },
  tools: [
    {
      name: 'sum',
      version: '1',
      description: 'Sum fixed test values',
      parameters: { type: 'object' },
      validate(args) {
        assert.deepEqual(args, { values: [3, 5, 8] })
        return args
      },
      authorize: async () => true,
      execute: async (args) => {
        toolCalls++
        return { content: [{ type: 'text', text: String(args.values.reduce((a, b) => a + b, 0)) }] }
      }
    }
  ]
})
assert.equal(await session.prompt([{ type: 'text', text: 'Sum the supplied values' }]), 'complete')
assert.equal(typeof session.steer, 'function')
assert.equal(toolCalls, 1)
assert.equal(transforms, 2)
assert.equal(guards, 1)
assert.equal((await session.snapshot()).requests.length, 2)
const inspection = await session.inspect({ requestsFrom: 1 })
assert.equal(inspection.requestCount, 2)
assert.equal(inspection.requests.length, 1)
assert.equal('messages' in inspection, false)
assert.equal(Object.isFrozen(inspection.requests), true)
assert.equal(
  (await store.load('standalone')).messages.some((message) => message.id === 'transient'),
  false
)
await session.dispose()
const ephemeral = await openAgentSession({
  sessionId: 'standalone',
  maxSteps: 1,
  maxOutputTokens: 16,
  model: {
    id: 'empty',
    capabilities: { tools: false, images: false, files: false },
    async *stream() {
      yield { type: 'finish', reason: 'complete', content: [{ type: 'text', text: 'fresh' }] }
    }
  }
})
assert.equal((await ephemeral.snapshot()).messages.length, 0)
assert.equal(await ephemeral.prompt([{ type: 'text', text: 'hello' }]), 'complete')
await ephemeral.dispose()
assert.equal(
  Object.keys(require.cache).some((path) => path.endsWith('/chat-completions.js')),
  false
)
assert.equal(
  Object.keys(require.cache).some((path) => path.endsWith('/mcp.js')),
  false
)
const { loadMcpTools } = await import('@aipoch/agent-harness/mcp')
assert.equal(require('@aipoch/agent-harness/mcp').loadMcpTools, loadMcpTools)
const mcpTools = await loadMcpTools({
  signal: new AbortController().signal,
  client: {
    listTools: async () => ({ tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] }),
    callTool: async () => ({ content: [{ type: 'text', text: 'mcp result' }] })
  },
  bind: () => ({ validate: (args) => args, authorize: async () => true })
})
assert.deepEqual(
  await mcpTools[0].execute(
    {},
    {
      sessionId: 's',
      runId: 'r',
      invocationId: 'i',
      signal: new AbortController().signal,
      update() {
        // This fixture returns its result directly and emits no progress updates.
      }
    }
  ),
  { content: [{ type: 'text', text: 'mcp result' }] }
)
assert.equal(
  Object.keys(require.cache).some((path) => path.includes('@modelcontextprotocol')),
  false
)
const { createChatCompletionsModel } = await import('@aipoch/agent-harness/chat-completions')
const { createResponsesModel } = await import('@aipoch/agent-harness/responses')
const { createMessagesModel } = await import('@aipoch/agent-harness/messages')
assert.equal(
  require('@aipoch/agent-harness/chat-completions').createChatCompletionsModel,
  createChatCompletionsModel
)
assert.equal(require('@aipoch/agent-harness/responses').createResponsesModel, createResponsesModel)
assert.equal(require('@aipoch/agent-harness/messages').createMessagesModel, createMessagesModel)
let wireCalls = 0
const native = createChatCompletionsModel({
  endpoint: 'https://fixture.example/chat/completions',
  model: 'fixture',
  apiKey: () => 'fixture-key',
  fetch: async (_, init) => {
    wireCalls++
    const body = JSON.parse(init.body)
    assert.equal(body.stream, true)
    assert.equal(body.stream_options.include_usage, true)
    const event = {
      choices: [{ index: 0, delta: { content: 'wire answer' }, finish_reason: 'stop' }]
    }
    return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    })
  }
})
const nativeSession = await openAgentSession({
  sessionId: 'native',
  model: native,
  maxSteps: 2,
  maxOutputTokens: 64
})
assert.equal(await nativeSession.prompt([{ type: 'text', text: 'hello' }]), 'complete')
assert.equal(wireCalls, 1)
assert.equal((await nativeSession.snapshot()).messages.at(-1).content[0].text, 'wire answer')
await nativeSession.dispose()
const receipts = []
assert.deepEqual(
  await executeToolCall({
    callId: 'call',
    input: {},
    signal: new AbortController().signal,
    validate: (args) => args,
    authorize: async () => false,
    execute: async () => {
      throw new Error('Denied tool must not execute')
    },
    record: async (receipt) => {
      receipts.push(receipt)
    }
  }),
  { status: 'denied', output: 'Permission denied' }
)
assert.equal(receipts[0].status, 'denied')
assert.ok(realpathSync(require.resolve('@aipoch/agent-harness')).startsWith(process.cwd() + sep))
assert.throws(() => require('@aipoch/agent-harness/src/index'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
})
const runner = createAgentRunner({ maxSteps: 2 })
assert.equal(await runner.run(async () => 'continue'), 'budget')
assert.equal(await runner.run(async () => 'complete'), 'complete')
await runner.dispose()
await assert.rejects(
  runner.run(async () => 'complete'),
  /disposed/
)
let proposal
const result = await compactContext({
  snapshot: {
    scope: { sessionId: 's', frameId: 'f', branchId: 'b', generation: 'g', routeId: 'r' },
    revision: 0,
    items: [
      { id: 'old', kind: 'message', role: 'user', text: 'long history' },
      { id: 'new', kind: 'message', role: 'user', text: 'now' }
    ]
  },
  summaryId: 'summary',
  inputBudget: 8,
  keepRecentItems: 1,
  signal: new AbortController().signal,
  measure: (items) => items.reduce((n, item) => n + item.text.length, 0),
  summarize: async () => 'brief',
  commit: async (candidate) => {
    proposal = candidate
    return true
  }
})
assert.deepEqual(result, { status: 'committed', tokens: 8, fitsBudget: true })
assert.deepEqual(proposal.sourceIds, ['old'])
console.log(
  'PASS: isolated ESM/CJS consumer, cross-process journal, memory stores, context transform, guards, streamed tools, Chat Completions subpath, compaction and private exports'
)
