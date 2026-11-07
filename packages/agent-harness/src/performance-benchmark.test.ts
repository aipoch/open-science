import { describe, expect, it } from 'vitest'
import { openAgentSession } from './session'
import { createAgentRunner } from './index'
import type {
  AgentMessage,
  AgentModel,
  AgentTool,
  ContentBlock,
  ModelEvent,
  ModelRequest,
  ModelUsage,
  ToolCall
} from './session-types'

type BenchmarkResult = {
  name: string
  modelSteps: number
  totalModelRequests: number
  compactionSteps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  wallMs: number
  steps: { step: number; inputTokens: number; outputTokens: number }[]
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })
const usageFor = (request: ModelRequest, outputTokens: number): ModelUsage => ({
  inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
  outputTokens
})

const createScriptedModel = (id: string): AgentModel => {
  let calls = 0
  return {
    id,
    capabilities: { tools: true, images: false, files: false },
    async *stream(request): AsyncIterable<ModelEvent> {
      const last = request.messages.at(-1)?.content[0]
      if (
        last?.type === 'text' &&
        last.text.startsWith('Create a compact continuation checkpoint')
      ) {
        yield {
          type: 'finish',
          reason: 'complete',
          content: [
            text(
              '## Goal\nVerify alpha.\n## Progress\nChecks completed.\n## Evidence\nRetained.\n## Next\nFinish checks.'
            )
          ],
          usage: usageFor(request, 32)
        }
        return
      }
      calls++
      if (calls <= 4) {
        const name = calls % 2 === 1 ? 'lookup' : 'verify'
        const call: ToolCall = { id: `${name}-${calls}`, name, arguments: { key: 'alpha' } }
        yield {
          type: 'finish',
          reason: 'tools',
          content: [],
          calls: [call],
          usage: usageFor(request, 8)
        }
      } else {
        yield {
          type: 'finish',
          reason: 'complete',
          content: [text('verified')],
          usage: usageFor(request, 4)
        }
      }
    }
  }
}

const createTool = (name: 'lookup' | 'verify'): AgentTool => ({
  name,
  version: '1',
  description: name,
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  validate: (value) => value,
  authorize: async () => true,
  execute: async () => ({ content: [text(`${name}:${'evidence '.repeat(1000)}`)] })
})

const initialPrompt = [
  text(
    'Verify alpha with the available lookup and verify tools. Preserve the evidence and answer only after both checks.'
  )
]

const sessionResult = async (name: string, compact: boolean): Promise<BenchmarkResult> => {
  const model = createScriptedModel(`${name}-model`)
  const started = performance.now()
  const session = await openAgentSession({
    sessionId: `${name}-${Date.now()}-${Math.random()}`,
    model,
    instructions: 'Use the supplied tools.',
    tools: [createTool('lookup'), createTool('verify')],
    maxSteps: 8,
    maxOutputTokens: 128,
    ...(compact
      ? {
          compaction: {
            inputBudget: 4000,
            keepRecentItems: 2,
            measure: (request: ModelRequest) =>
              Math.ceil(JSON.stringify(request.messages).length / 4),
            maxOutputTokens: 64
          }
        }
      : {})
  })
  await session.prompt(initialPrompt)
  const snapshot = await session.snapshot()
  await session.dispose()
  const requests = snapshot.requests
  const main = requests.filter((request) => request.purpose !== 'compaction')
  const usage = requests.flatMap((request) => (request.usage ? [request.usage] : []))
  const steps = main.flatMap((request, index) =>
    request.usage
      ? [
          {
            step: index + 1,
            inputTokens: request.usage.inputTokens,
            outputTokens: request.usage.outputTokens
          }
        ]
      : []
  )
  return {
    name,
    modelSteps: main.length,
    totalModelRequests: requests.length,
    compactionSteps: requests.filter((request) => request.purpose === 'compaction').length,
    toolCalls: snapshot.messages.filter((message) => message.role === 'tool').length,
    inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
    totalTokens: usage.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0),
    wallMs: Math.round((performance.now() - started) * 100) / 100,
    steps
  }
}

const directLoopResult = async (rollingCompaction = false): Promise<BenchmarkResult> => {
  const model = createScriptedModel('direct-loop-model')
  const tools = [createTool('lookup'), createTool('verify')]
  const messages: AgentMessage[] = [{ id: 'user-1', role: 'user', content: initialPrompt }]
  const started = performance.now()
  let inputTokens = 0
  let outputTokens = 0
  let modelSteps = 0
  let toolCalls = 0
  let totalModelRequests = 0
  let compactionSteps = 0
  const steps: BenchmarkResult['steps'] = []
  const runner = createAgentRunner({ maxSteps: 8 })
  await runner.run(async (signal) => {
    if (rollingCompaction && JSON.stringify(messages).length / 4 > 4000) {
      const source = messages.slice(0, -2)
      inputTokens += Math.ceil(JSON.stringify(source).length / 4)
      outputTokens += 12
      totalModelRequests++
      compactionSteps++
      messages.splice(0, source.length, {
        id: `summary-${compactionSteps}`,
        role: 'summary',
        content: [text('Retained evidence for the ongoing task.')]
      })
    }
    const request: ModelRequest = {
      requestId: `direct-${modelSteps}`,
      instructions: 'Use the supplied tools.',
      messages: structuredClone(messages),
      tools: tools.map(({ name, version, description, parameters }) => ({
        name,
        version,
        description,
        parameters
      })),
      maxOutputTokens: 128
    }
    totalModelRequests++
    let finish: Extract<ModelEvent, { type: 'finish' }> | undefined
    for await (const event of model.stream(request, signal))
      if (event.type === 'finish') finish = event
    if (!finish) throw new Error('Missing benchmark finish')
    modelSteps++
    inputTokens += finish.usage?.inputTokens ?? 0
    outputTokens += finish.usage?.outputTokens ?? 0
    steps.push({
      step: modelSteps,
      inputTokens: finish.usage?.inputTokens ?? 0,
      outputTokens: finish.usage?.outputTokens ?? 0
    })
    const assistant: AgentMessage = {
      id: `assistant-${modelSteps}`,
      role: 'assistant',
      content: finish.content,
      ...(finish.calls ? { calls: finish.calls } : {})
    }
    messages.push(assistant)
    if (finish.reason !== 'tools') return 'complete'
    for (const call of finish.calls ?? []) {
      const tool = tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`Unknown benchmark tool ${call.name}`)
      const result = await tool.execute(call.arguments, {
        sessionId: 'direct-loop',
        runId: 'direct-loop',
        invocationId: `${assistant.id}/${call.id}`,
        signal,
        update: () => undefined
      })
      if ('waiting' in result) throw new Error('Unexpected benchmark wait')
      messages.push({
        id: `tool-${++toolCalls}`,
        role: 'tool',
        invocationId: `${assistant.id}/${call.id}`,
        content: result.content
      })
    }
    return 'continue'
  })
  await runner.dispose()
  return {
    name: rollingCompaction ? 'rolling-compaction-baseline' : 'direct-loop-baseline',
    modelSteps,
    totalModelRequests,
    compactionSteps,
    toolCalls,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    wallMs: Math.round((performance.now() - started) * 100) / 100,
    steps
  }
}

describe('harness performance benchmark', () => {
  it('compares token and step costs under one identical scripted workload', async () => {
    const results = [
      await directLoopResult(),
      await directLoopResult(true),
      await sessionResult('session-no-compaction', false),
      await sessionResult('session-compaction', true)
    ]
    const compacted = results[3]
    const uncompressed = results[2]
    expect(results.map((result) => result.modelSteps)).toEqual([5, 5, 5, 5])
    expect(results.map((result) => result.toolCalls)).toEqual([4, 4, 4, 4])
    expect(results[1].compactionSteps).toBeGreaterThan(0)
    expect(compacted.compactionSteps).toBe(3)
    // Prefix caching affects billed input, not raw input; do not assert gross-token savings.
    expect(compacted.steps.at(-1)!.inputTokens).toBeLessThan(uncompressed.steps.at(-1)!.inputTokens)
    expect(compacted.totalModelRequests).toBe(uncompressed.totalModelRequests + 3)
    console.log(
      JSON.stringify({
        results,
        perStep: results.map(({ name, steps }) => ({ name, steps })),
        savings: {
          inputTokens: uncompressed.inputTokens - compacted.inputTokens,
          totalTokens: uncompressed.totalTokens - compacted.totalTokens,
          percentage: Math.round((1 - compacted.totalTokens / uncompressed.totalTokens) * 1000) / 10
        }
      })
    )
  })
})
