import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createChatCompletionsModel } from './chat-completions'
import { createJsonFileAgentStore } from './file-store'
import { createJournalAgentStore } from './journal-store'
import { loadMcpTools } from './mcp'
import { openAgentSession, type AgentSession } from './session'
import type { AgentStore, ModelRequest } from './session-types'

type Strategy = 'off' | 'automatic'
type WireMessage = { role: string; content: string; tool_call_id?: string }
type WireRequest = { model: string; tools?: unknown[]; messages: WireMessage[] }
type Sample = {
  purpose: 'main' | 'summary'
  route: string
  inputUnits: number
  outputUnits: number
  idealCacheUnits: number
}
type Totals = { requests: number; inputUnits: number; outputUnits: number; idealCacheUnits: number }
type BenchmarkResult = {
  persistence: 'json' | 'journal'
  strategy: Strategy
  turns: number
  toolCalls: number
  listCalls: number
  main: Totals
  summary: Totals
  peakMainInputUnits: number
  checkpoint: {
    commits: number
    totalBytes: number
    finalBytes: number
    commitP50Ms: number
    commitP95Ms: number
    commitTotalMs: number
  }
  wallMs: number
  steps: Sample[]
}
const SUMMARY = 'Summarize the inspection task and retain evidence references.'
const percentile = (values: number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0
const round = (value: number): number => Math.round(value * 100) / 100

// This oracle measures exact wire-prefix reuse, not a provider's tokenizer, cache or billing.
function cacheOracle(): (request: WireRequest) => { inputUnits: number; idealCacheUnits: number } {
  const seen = new Map<string, string[]>()
  return (request: WireRequest): { inputUnits: number; idealCacheUnits: number } => {
    const prefix = JSON.stringify({ tools: request.tools ?? [], messages: request.messages })
    const previous = seen.get(request.model) ?? []
    let longest = 0
    for (const candidate of previous) {
      let index = 0
      while (
        index < Math.min(candidate.length, prefix.length) &&
        candidate[index] === prefix[index]
      )
        index++
      longest = Math.max(longest, index)
    }
    previous.push(prefix)
    seen.set(request.model, previous)
    return {
      inputUnits: Math.ceil(Buffer.byteLength(prefix) / 4),
      idealCacheUnits: Math.floor(Buffer.byteLength(prefix.slice(0, longest)) / 4)
    }
  }
}

async function workload(
  strategy: Strategy,
  turns: number,
  persistence: 'json' | 'journal' = 'json'
): Promise<BenchmarkResult> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-long-session-'))
  const samples: Sample[] = []
  const commits: { bytes: number; ms: number }[] = []
  let expectedWire: WireRequest | undefined
  const cache = cacheOracle()
  const mainPrefixChecks: boolean[] = []
  let listCalls = 0
  let toolCalls = 0
  let roundTrips = 0
  let sameRouteReopenAt = 0
  const answers: string[] = []
  let journalBytes = 0
  const disk =
    persistence === 'json'
      ? createJsonFileAgentStore({ directory })
      : createJournalAgentStore({
          directory,
          onWrite: (event) => {
            journalBytes += event.bytes
          }
        })
  const store: AgentStore = {
    load: disk.load,
    async commit(id, revision, next) {
      const started = performance.now()
      const beforeBytes = journalBytes
      const accepted = await disk.commit(id, revision, next)
      const ms = performance.now() - started
      // Count logical serialized payload, not physical disk blocks or fsync latency alone.
      if (accepted)
        commits.push({
          bytes:
            persistence === 'json'
              ? Buffer.byteLength(JSON.stringify(next))
              : journalBytes - beforeBytes,
          ms
        })
      return accepted
    }
  }
  const tools = await loadMcpTools({
    signal: new AbortController().signal,
    client: {
      async listTools() {
        listCalls++
        return {
          tools: [
            {
              name: 'inspect',
              description: 'Inspect an evidence record by number.',
              inputSchema: {
                type: 'object',
                properties: { record: { type: 'integer' } },
                required: ['record'],
                additionalProperties: false
              }
            }
          ]
        }
      },
      async callTool(_name, args) {
        toolCalls++
        return {
          content: [{ type: 'text', text: `value=${args.record}\n${'evidence '.repeat(455)}` }]
        }
      }
    },
    bind: () => ({
      validate: (args) => args,
      authorize: async () => true
    })
  })
  const transport: typeof fetch = async (_url, init) => {
    roundTrips++
    const wire = JSON.parse(String(init?.body)) as WireRequest
    const last = wire.messages.at(-1)!
    const summary = last.content.startsWith('Create a compact continuation checkpoint')
    if (summary && strategy === 'automatic') {
      const previous = expectedWire!
      expectedWire = undefined
      expect(wire.model).toBe(previous.model)
      expect(wire.tools ?? []).toEqual([])
      expect(wire.messages.slice(0, -1)).toEqual(previous.messages)
      mainPrefixChecks.push(true)
    }
    const measured = cache(wire)
    const record = /^inspect (\d+)$/.exec(last.content)?.[1]
    const answer = last.role === 'tool' ? /^value=(\d+)\n/.exec(last.content)?.[1] : undefined
    if (!summary && !record && !answer) throw new Error('Fixture lost the active task or result')
    const delta = summary
      ? {
          content:
            '## Goal\nInspect records.\n## Progress\nPrior inspections completed.\n## Evidence\nPrior evidence remains in the host.\n## Next\nContinue inspections.'
        }
      : record
        ? {
            tool_calls: [
              {
                index: 0,
                id: `inspect-${record}`,
                type: 'function',
                function: { name: 'inspect', arguments: JSON.stringify({ record: Number(record) }) }
              }
            ]
          }
        : { content: `verified ${answer}` }
    if (!summary && answer) answers.push(`verified ${answer}`)
    const outputUnits = summary ? 32 : record ? 20 : 4
    samples.push({
      purpose: summary ? 'summary' : 'main',
      route: wire.model,
      ...measured,
      outputUnits
    })
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            { index: 0, delta: {}, finish_reason: record && !summary ? 'tool_calls' : 'stop' }
          ],
          usage: {
            prompt_tokens: measured.inputUnits,
            completion_tokens: outputUnits,
            prompt_tokens_details: { cached_tokens: measured.idealCacheUnits }
          }
        })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const open = (route: string): Promise<AgentSession> => {
    let expectedMain: ModelRequest | undefined
    const adapter = createChatCompletionsModel({
      endpoint: 'https://fixture.invalid/chat/completions',
      model: route,
      apiKey: () => 'fixture-only',
      fetch: transport
    })
    const measure = (request: ModelRequest): number => {
      // Includes instructions/schema/media framing; units deliberately remain fixture estimates.
      const units = Math.ceil(
        Buffer.byteLength(
          JSON.stringify({
            instructions: request.instructions,
            messages: request.messages,
            tools: request.tools
          })
        ) / 4
      )
      if (units > 4096 && !expectedMain) expectedMain = request
      return units
    }
    return openAgentSession({
      sessionId: 'long-session',
      store,
      model: {
        ...adapter,
        async *stream(request: ModelRequest, signal: AbortSignal) {
          if (
            request.messages
              .at(-1)
              ?.content.some(
                (b) =>
                  b.type === 'text' && b.text.startsWith('Create a compact continuation checkpoint')
              )
          ) {
            expect(expectedMain).toBeDefined()
            expect(request.messages.slice(0, -1)).toEqual(
              expectedMain!.messages.slice(0, request.messages.length - 1)
            )
            const encodeOnly = createChatCompletionsModel({
              endpoint: 'https://fixture.invalid/chat/completions',
              model: route,
              apiKey: () => 'fixture-only',
              fetch: async (_url, init) => {
                expectedWire = JSON.parse(String(init?.body))
                return new Response(
                  'data: {"choices":[{"index":0,"delta":{"content":"encoded"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  { headers: { 'content-type': 'text/event-stream' } }
                )
              }
            })
            for await (const event of encodeOnly.stream(
              {
                ...expectedMain!,
                messages: expectedMain!.messages.slice(0, request.messages.length - 1)
              },
              signal
            )) {
              expect(event.type).toMatch(/text-delta|finish/)
            }
            expectedMain = undefined
          }
          yield* adapter.stream(request, signal)
        }
      },
      tools,
      instructions: 'Inspect each requested record once and report its value.',
      maxSteps: 3,
      maxOutputTokens: 128,
      ...(strategy === 'off'
        ? {}
        : {
            compaction: {
              inputBudget: 4096,
              keepRecentItems: 4,
              maxOutputTokens: 128,
              instructions: SUMMARY,
              measure
            }
          })
    })
  }
  let session: Awaited<ReturnType<typeof open>> | undefined
  const started = performance.now()
  try {
    session = await open('route-a')
    for (let turn = 0; turn < turns; turn++) {
      if (turn === turns / 2 || turn === (turns * 3) / 4) {
        await session.dispose()
        session = await open(turn === turns / 2 ? 'route-a' : 'route-b')
        if (turn === turns / 2) sameRouteReopenAt = samples.length
      }
      expect(await session.prompt([{ type: 'text', text: `inspect ${turn}` }])).toBe('complete')
    }
    const state = await session.snapshot()
    const mainSamples = samples.filter((sample) => sample.purpose === 'main')
    const summarySamples = samples.filter((sample) => sample.purpose === 'summary')
    expect(answers).toEqual(Array.from({ length: turns }, (_, index) => `verified ${index}`))
    expect(toolCalls).toBe(turns)
    expect(listCalls).toBe(1)
    expect(mainSamples).toHaveLength(turns * 2)
    expect(state.messages.filter((message) => message.role === 'tool')).toHaveLength(turns)
    expect(state.requests).toHaveLength(roundTrips)
    expect(state.requests.every((request) => request.status === 'completed')).toBe(true)
    expect(samples.find((sample) => sample.route === 'route-b')!.idealCacheUnits).toBe(0)
    expect(samples[sameRouteReopenAt].route).toBe('route-a')
    expect(samples[sameRouteReopenAt].idealCacheUnits).toBeGreaterThan(0)
    expect(state.requests.reduce((sum, request) => sum + request.usage!.inputTokens, 0)).toBe(
      samples.reduce((sum, sample) => sum + sample.inputUnits, 0)
    )
    if (strategy !== 'off') {
      expect(state.compactions.length).toBeGreaterThan(2)
      expect(summarySamples).toHaveLength(state.compactions.length)
      expect(Math.max(...mainSamples.map((sample) => sample.inputUnits))).toBeLessThan(4096)
    }
    if (strategy === 'automatic') expect(mainPrefixChecks).toHaveLength(summarySamples.length)
    const totals = (purpose: Sample['purpose']): Totals =>
      samples
        .filter((item) => item.purpose === purpose)
        .reduce(
          (total, item) => ({
            requests: total.requests + 1,
            inputUnits: total.inputUnits + item.inputUnits,
            outputUnits: total.outputUnits + item.outputUnits,
            idealCacheUnits: total.idealCacheUnits + item.idealCacheUnits
          }),
          { requests: 0, inputUnits: 0, outputUnits: 0, idealCacheUnits: 0 }
        )
    return {
      persistence,
      strategy,
      turns,
      toolCalls,
      listCalls,
      main: totals('main'),
      summary: totals('summary'),
      peakMainInputUnits: Math.max(...mainSamples.map((sample) => sample.inputUnits)),
      checkpoint: {
        commits: commits.length,
        totalBytes: commits.reduce((sum, commit) => sum + commit.bytes, 0),
        finalBytes: Buffer.byteLength(JSON.stringify(state)),
        commitP50Ms: round(
          percentile(
            commits.map((commit) => commit.ms),
            0.5
          )
        ),
        commitP95Ms: round(
          percentile(
            commits.map((commit) => commit.ms),
            0.95
          )
        ),
        commitTotalMs: round(commits.reduce((sum, commit) => sum + commit.ms, 0))
      },
      wallMs: round(performance.now() - started),
      steps: samples
    }
  } finally {
    await session?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('long MCP sessions with real file checkpoints and simulated provider usage', () => {
  for (const strategy of ['off', 'automatic'] as const) {
    it(`${strategy}: repeated compaction, reopen and route change`, async () => {
      const shorter = await workload(strategy, 24)
      const longer = await workload(strategy, 48)
      const journalShorter = await workload(strategy, 24, 'journal')
      const journalLonger = await workload(strategy, 48, 'journal')
      // Snapshot persistence still rewrites old evidence, even when model context is compacted.
      expect(longer.checkpoint.totalBytes / shorter.checkpoint.totalBytes).toBeGreaterThan(3)
      expect(journalLonger.checkpoint.totalBytes).toBeLessThan(longer.checkpoint.totalBytes / 8)
      expect(
        journalLonger.checkpoint.totalBytes / journalShorter.checkpoint.totalBytes
      ).toBeLessThan(3)
      expect(journalLonger.main).toEqual(longer.main)
      expect(journalLonger.summary.requests).toBe(longer.summary.requests)
      expect(journalLonger.summary.inputUnits).toBe(longer.summary.inputUnits)
      expect(journalLonger.toolCalls).toBe(longer.toolCalls)
      if (strategy === 'off')
        expect(longer.peakMainInputUnits).toBeGreaterThan(shorter.peakMainInputUnits * 1.8)
      const report = JSON.stringify({
        benchmark: 'long-session-fixture-v2',
        usage: 'UTF-8 bytes/4, ideal prefix oracle; NOT provider tokens/cache',
        results: [shorter, longer, journalShorter, journalLonger]
      })
      if (process.env.AGENT_HARNESS_BENCHMARK_REPORT_DIR)
        await writeFile(
          join(process.env.AGENT_HARNESS_BENCHMARK_REPORT_DIR, `${strategy}.json`),
          report + '\n'
        )
    }, 60_000)
  }
})
