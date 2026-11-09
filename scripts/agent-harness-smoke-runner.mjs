/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone smoke runner. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import { HarnessSessionOwner } from '../src/main/settings/harness-session-owner.ts'
import { ProviderTransportOwner } from '../src/main/settings/provider-transport-owner.ts'
import { ProtocolForwardingBridge } from '../src/main/settings/protocol-forwarding-bridge.ts'
import { SettingsRepository } from '../src/main/settings/repository.ts'
import { projectHarnessTurnUsage } from '../src/main/settings/harness-turn-usage.ts'
import { runHarnessTurn } from '../src/main/settings/harness-turn.ts'
import { SessionRepository } from '../src/main/session-persistence/repository.ts'
import { initDataRoot } from '../src/main/storage-root.ts'
import { createLinearConversationGraph } from '../src/shared/conversation-graph.ts'
import { randomUUID } from 'node:crypto'
import { countMessagesInputTokens } from '@aipoch/providers/protocol'
import { harnessContextMessages } from '../src/main/settings/harness-context.ts'

const TOOL = 'read_fixture_values'
const VALUES = [3, 5, 8]
const tools = [
  {
    type: 'function',
    function: {
      name: TOOL,
      description: 'Read the fixed smoke-test values.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true
    }
  }
]

export async function fixtureModel(_url, init) {
  const body = JSON.parse(init.body)
  if (body.messages[0]?.role === 'system' && body.messages[0].content.startsWith('Summarize')) {
    const source = JSON.parse(body.messages[1].content)
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              summary:
                'Fixture values are 3, 5, 8. Read the tool and compute their sum. Permission must still be checked.',
              sourceIds: source.map((item) => item.id)
            })
          }
        }
      ],
      usage: { prompt_tokens: 20, completion_tokens: 4 }
    })
  }
  const done = body.messages.at(-1)?.role === 'tool'
  return Response.json({
    choices: [
      {
        finish_reason: done ? 'stop' : 'tool_calls',
        message: {
          role: 'assistant',
          content: done ? '16' : null,
          ...(done
            ? {}
            : {
                reasoning_content: 'Read the values before adding them.',
                tool_calls: [
                  {
                    id: 'smoke-call',
                    type: 'function',
                    function: { name: TOOL, arguments: '{}' }
                  }
                ]
              })
        }
      }
    ],
    usage: { prompt_tokens: 20, completion_tokens: 4 }
  })
}

/** Uses an isolated account and Session; never modifies the user's application data. */
export async function runHarnessSmoke(
  options,
  signal,
  upstream = options.mode === 'fixture' ? fixtureModel : fetch
) {
  // Refuse an existing directory so reruns cannot erase an interrupted attempt's evidence.
  await mkdir(options.output, { mode: 0o700 })
  const temporary = await mkdtemp(join(tmpdir(), 'open-science-harness-smoke-'))
  const reportPath = join(options.output, 'report.json')
  let owner
  let status = 'failed'
  let toolCalls = 0
  let outputMatched = false
  const observed = new Map()
  let usageScope
  let requestCount = 0
  let compactionCount = 0
  const report = () => ({
    version: 1,
    mode: options.mode,
    model: options.model,
    reasoningSplit: options.reasoningSplit === true,
    compaction: {
      enabled: options.compact === true,
      count: compactionCount,
      measurement: 'o200k_base estimate; not a MiniMax capacity guarantee'
    },
    status,
    toolCalls,
    outputMatched,
    sessionUsage: usageScope
      ? projectHarnessTurnUsage({
          ...usageScope,
          requestCount,
          observations: [...observed.values()]
        })
      : { turnUsageUnavailable: true },
    requests: [...observed.values()].map((event) => ({
      requestId: event.requestId,
      status: event.status,
      usageKnown: event.usage !== undefined
    }))
  })
  try {
    const repository = new SettingsRepository(temporary)
    await repository.upsertProvider({
      id: 'harness-smoke',
      name: 'Harness smoke',
      type: 'custom',
      baseUrl: options.endpoint,
      model: options.model,
      apiEndpoints: ['chat-completions']
    })
    const transports = new ProviderTransportOwner({
      createProtocolForwardingBridge: (targets, id) =>
        new ProtocolForwardingBridge(targets, id, upstream)
    })
    owner = new HarnessSessionOwner(repository, {
      acquireHarness: (target, acquisition) =>
        transports.acquireHarness(
          { ...target, provider: { ...target.provider, key: options.key } },
          acquisition
        )
    })
    const session = await owner.open(
      { providerId: 'harness-smoke', model: options.model, maxSteps: options.compact ? 4 : 2 },
      signal
    )
    // This isolated experiment uses the real Session format; app composition uses its coordinator.
    initDataRoot(options.output)
    const sessions = new SessionRepository(options.output)
    const now = Date.now()
    const prompt = `Call ${TOOL} exactly once with empty arguments. Then return only the sum of its values as a decimal integer, without prose.`
    const seedMessages = [
      ...(options.compact
        ? [
            {
              id: 'background',
              role: 'user',
              content:
                'Synthetic fixture context: values 3, 5, 8; goal is sum after a permitted read. Evidence remains in the original record. '.repeat(
                  200
                ),
              status: 'complete',
              eventIds: [],
              createdAt: now,
              updatedAt: now
            }
          ]
        : []),
      {
        id: 'prompt',
        role: 'user',
        content: prompt,
        status: 'complete',
        eventIds: [],
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'answer',
        role: 'agent',
        content: '',
        status: 'streaming',
        eventIds: [],
        createdAt: now,
        updatedAt: now
      }
    ]
    const graph = createLinearConversationGraph({
      sessionId: 'harness-smoke',
      messages: seedMessages,
      createdAt: now,
      updatedAt: now
    })
    graph.runtimeSegments = []
    for (const message of graph.messages) delete message.runtimeSegmentId
    await sessions.saveSession({
      id: 'harness-smoke',
      projectId: 'harness-smoke',
      title: 'Harness smoke',
      cwd: options.output,
      status: 'idle',
      messages: seedMessages,
      conversationGraph: graph,
      createdAt: now,
      updatedAt: now
    })
    const journalScope = {
      projectId: 'harness-smoke',
      sessionId: 'harness-smoke',
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.frames[0].activeBranchId,
      promptMessageId: 'prompt',
      messageId: 'answer',
      generation: randomUUID(),
      route: session.route
    }
    const readSessionSnapshot = async (projectId, sessionId) => {
      const loaded = await sessions.loadSessionWithDiagnostics(projectId, sessionId, {
        preserveRuntimeState: true
      })
      if (loaded.status !== 'found') return undefined
      compactionCount =
        loaded.session.conversationGraph.messages.find((message) => message.id === 'answer')
          ?.harnessTurn?.compactions?.length ?? 0
      return loaded.session
    }
    const persistence = {
      readSessionSnapshot,
      mutateRuntimeSession: async (scope, mutate) => {
        const loaded = await readSessionSnapshot(scope.projectId, scope.sessionId)
        if (!loaded) throw new Error('Smoke Session is unavailable')
        return sessions.saveSession(mutate(loaded), loaded.revision)
      }
    }
    const observe = async (event) => {
      usageScope ??= { turnId: event.turnId, route: session.route }
      if (!/^[a-f0-9-]{36}$/.test(event.requestId)) throw new Error('Invalid request identity')
      if (event.status === 'started' && !observed.has(event.requestId)) requestCount++
      observed.set(event.requestId, event)
      // This export follows the shared turn runner's authoritative Session write.
      await writeDurableJsonFile(
        join(options.output, `${event.requestId}.json`),
        `${JSON.stringify(event, null, 2)}\n`
      )
    }
    const outcome = await runHarnessTurn({
      session,
      scope: journalScope,
      persistence,
      observe,
      maxOutputTokens: 256,
      reasoningSplit: options.reasoningSplit,
      tools: [
        {
          ...tools[0].function,
          validate: (args) => {
            if (
              !args ||
              typeof args !== 'object' ||
              Array.isArray(args) ||
              Object.keys(args).length ||
              toolCalls
            )
              throw new Error('Invalid smoke tool invocation')
            return args
          },
          // This experiment authorizes only its fixed in-memory fixture.
          authorize: async () => true,
          execute: async () => {
            toolCalls++
            return JSON.stringify({ values: VALUES })
          }
        }
      ],
      ...(options.compact
        ? {
            compaction: {
              inputBudget: 1024,
              keepRecentItems: 1,
              maxOutputTokens: 2048,
              measure: (items) =>
                countMessagesInputTokens({
                  system: JSON.stringify({
                    model: options.model,
                    stream: false,
                    n: 1,
                    max_tokens: 256,
                    tool_choice: 'auto',
                    ...(options.reasoningSplit ? { reasoning_split: true } : {})
                  }),
                  messages: harnessContextMessages(items),
                  tools
                })
            }
          }
        : {})
    })
    const finished = await readSessionSnapshot(journalScope.projectId, journalScope.sessionId)
    outputMatched = toolCalls === 1 && finished?.messages.at(-1)?.content?.trim() === '16'
    if (outcome === 'complete' && !outputMatched) throw new Error('Unexpected smoke result')
    status = outcome === 'complete' ? 'passed' : outcome === 'cancelled' ? 'interrupted' : 'failed'
  } catch {
    status = signal.aborted ? 'interrupted' : 'failed'
  } finally {
    try {
      await owner?.dispose()
    } catch {
      status = 'failed'
    }
    try {
      await rm(temporary, { recursive: true, force: true })
    } catch {
      status = 'failed'
    }
  }
  // If this write fails, leave individual request receipts intact and fail the command.
  await writeDurableJsonFile(reportPath, `${JSON.stringify(report(), null, 2)}\n`)
  return report()
}
