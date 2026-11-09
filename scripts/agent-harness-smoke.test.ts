import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSmokeOptions } from './agent-harness-smoke.mjs'
import { fixtureModel, runHarnessSmoke } from './agent-harness-smoke-runner.mjs'

const faults = vi.hoisted(() => ({ status: '', session: false }))
vi.mock('@aipoch/durable-files', async (original) => {
  const real = await original<typeof import('@aipoch/durable-files')>()
  return {
    ...real,
    writeDurableJsonFile: async (...args: Parameters<typeof real.writeDurableJsonFile>) => {
      const payload = JSON.parse(args[1])
      const matches = faults.session
        ? payload.session?.conversationGraph?.messages.some((message) =>
            message.harnessTurn?.requests.some((request) => request.status === faults.status)
          )
        : payload.status === faults.status
      if (faults.status && matches) throw new Error('fixture storage failure')
      return real.writeDurableJsonFile(...args)
    }
  }
})

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-smoke-test-'))
  faults.status = ''
  faults.session = false
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
const options = (): {
  mode: string
  endpoint: string
  model: string
  key: string
  output: string
} => ({
  mode: 'fixture',
  endpoint: 'https://fixture.invalid',
  model: 'fixture-model',
  key: 'private-fixture-key',
  output: join(directory, 'evidence')
})
const artifacts = async (): Promise<unknown[]> =>
  Promise.all(
    (await readdir(options().output))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => JSON.parse(await readFile(join(options().output, name), 'utf8')))
  )
const persistedJournal = async (): Promise<
  import('../src/shared/harness-turn-contract').HarnessTurnJournal
> =>
  JSON.parse(
    await readFile(join(options().output, 'sessions/harness-smoke/harness-smoke.json'), 'utf8')
  ).session.conversationGraph.messages.find((message) => message.id === 'answer').harnessTurn

describe('harness smoke', () => {
  it('compacts through a metered request and reloads the durable summary before tool execution', async () => {
    const upstream = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.tools) {
        const stored = await persistedJournal()
        expect(stored.compactions).toHaveLength(1)
        expect(stored.summaryRequestIds).toHaveLength(1)
        expect(body.messages[0].content).toContain('Untrusted summary')
        expect(JSON.stringify(body.messages).length).toBeLessThan(2000)
      } else {
        expect(body.messages[0].role).toBe('system')
        expect(body.messages[1].content.length).toBeGreaterThan(20_000)
      }
      return fixtureModel(url, init)
    })
    const report = await runHarnessSmoke(
      { ...options(), compact: true },
      new AbortController().signal,
      upstream
    )
    expect(report).toMatchObject({
      status: 'passed',
      compaction: { count: 1 },
      toolCalls: 1,
      sessionUsage: { turnUsage: { turnCount: 3, inputTokens: 60, outputTokens: 12 } }
    })
    expect(upstream).toHaveBeenCalledTimes(3)
    expect((await persistedJournal()).status).toBe('complete')
    expect(parseSmokeOptions(['--output=result', '--compact'], {}).compact).toBe(true)
    expect(() => parseSmokeOptions(['--output=result', '--compact=true'], {})).toThrow()
  })

  it('rejects a summary that loses evidence references without executing a business tool', async () => {
    const report = await runHarnessSmoke(
      { ...options(), compact: true },
      new AbortController().signal,
      async () =>
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ summary: 'A summary', sourceIds: [] })
              }
            }
          ],
          usage: { prompt_tokens: 20, completion_tokens: 4 }
        })
    )
    expect(report).toMatchObject({
      status: 'failed',
      toolCalls: 0,
      compaction: { count: 0 },
      sessionUsage: { turnUsage: { turnCount: 1 } }
    })
    expect((await persistedJournal()).compactions).toBeUndefined()
  })

  it('explicitly requests separate reasoning without dropping it from tool replay', async () => {
    const upstream = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      expect(body.reasoning_split).toBe(true)
      if (body.messages.at(-1).role === 'tool')
        expect(body.messages[1].reasoning_content).toBe('Read the values before adding them.')
      return fixtureModel(url, init)
    })
    const report = await runHarnessSmoke(
      { ...options(), reasoningSplit: true },
      new AbortController().signal,
      upstream
    )
    expect(report.status).toBe('passed')
    expect(report.reasoningSplit).toBe(true)
    expect(parseSmokeOptions(['--output=result', '--reasoning-split'], {}).reasoningSplit).toBe(
      true
    )
    expect(() => parseSmokeOptions(['--output=result', '--reasoning-split=false'], {})).toThrow()
  })
  it('runs the actual CLI in fixture mode without account configuration', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['scripts/agent-harness-smoke.mjs', `--output=${options().output}`],
      { cwd: process.cwd(), timeout: 30_000 }
    )
    expect(stdout).toContain('"status":"passed"')
    expect(JSON.parse(await readFile(join(options().output, 'report.json'), 'utf8'))).toMatchObject(
      {
        mode: 'fixture',
        status: 'passed',
        toolCalls: 1,
        outputMatched: true
      }
    )
  })

  it('writes started receipts before dispatch and retains only non-sensitive usage evidence', async () => {
    const upstream = vi.fn(async (url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-fixture-key')
      const recorded = await artifacts()
      expect(
        (await persistedJournal()).requests.some((request) => request.status === 'started')
      ).toBe(true)
      expect(recorded.some((event) => (event as { status?: string }).status === 'started')).toBe(
        true
      )
      const body = JSON.parse(init.body)
      expect(body.max_tokens).toBe(256)
      if (body.messages.at(-1).role === 'tool')
        expect(body.messages[1].reasoning_content).toBe('Read the values before adding them.')
      return fixtureModel(url, init)
    })
    const result = await runHarnessSmoke(options(), new AbortController().signal, upstream)
    expect(result.status).toBe('passed')
    expect(result.sessionUsage.turnUsage).toMatchObject({
      inputTokens: 40,
      cacheTokens: 0,
      outputTokens: 8,
      turnCount: 2
    })
    expect(result.sessionUsage.modelCallUsage.map((call) => call.id)).toEqual(
      result.requests.map((request) => request.requestId)
    )
    expect(upstream).toHaveBeenCalledTimes(2)
    expect((await persistedJournal()).status).toBe('complete')
    const recorded = await artifacts()
    expect(recorded).toHaveLength(3)
    expect(JSON.stringify(recorded)).not.toMatch(
      /private-fixture-key|fixture\.invalid|Read the values|messages|authorization/
    )
    expect(result.requests.every((request: { usageKnown: boolean }) => request.usageKnown)).toBe(
      true
    )
  })

  it.each(['tool', 'arguments', 'answer'] as const)(
    'rejects an invalid %s without extra requests',
    async (failure) => {
      const upstream = vi.fn(async (url, init) => {
        const response = await (await fixtureModel(url, init)).json()
        const message = response.choices[0].message
        if (message.tool_calls) {
          if (failure === 'tool') message.tool_calls[0].function.name = 'unexpected_tool'
          if (failure === 'arguments')
            message.tool_calls[0].function.arguments = '{"path":"secret"}'
        } else if (failure === 'answer') message.content = 'incorrect'
        return Response.json(response)
      })
      const result = await runHarnessSmoke(options(), new AbortController().signal, upstream)
      expect(result.status).toBe('failed')
      expect(result.sessionUsage.turnUsage?.turnCount).toBe(failure === 'answer' ? 2 : 1)
      expect(upstream).toHaveBeenCalledTimes(failure === 'answer' ? 2 : 1)
      expect(result.toolCalls).toBe(failure === 'answer' ? 1 : 0)
    }
  )

  it('reports unknown usage without inventing zeros', async () => {
    const result = await runHarnessSmoke(
      options(),
      new AbortController().signal,
      async (url, init) => {
        const response = await (await fixtureModel(url, init)).json()
        delete response.usage
        return Response.json(response)
      }
    )
    expect(result.status).toBe('passed')
    expect(result.sessionUsage).toEqual({
      turnUsage: undefined,
      modelCallUsage: undefined,
      turnUsageUnavailable: true
    })
    expect(result.requests.every((request: { usageKnown: boolean }) => !request.usageKnown)).toBe(
      true
    )
  })

  it.each(['started', 'completed'])(
    'stops on authoritative Session %s write failure without resending',
    async (status) => {
      faults.status = status
      faults.session = true
      const upstream = vi.fn(fixtureModel)
      const result = await runHarnessSmoke(options(), new AbortController().signal, upstream)
      expect(result.status).toBe('failed')
      expect(upstream).toHaveBeenCalledTimes(status === 'started' ? 0 : 1)
      expect(result.sessionUsage.turnUsageUnavailable).toBe(true)
      if (status === 'completed')
        expect((await persistedJournal()).requests[0].status).toBe('started')
    }
  )

  it.each(['started', 'completed'])(
    'fails closed on %s receipt export failure and never resends',
    async (status) => {
      faults.status = status
      const upstream = vi.fn(fixtureModel)
      const result = await runHarnessSmoke(options(), new AbortController().signal, upstream)
      expect(result.status).toBe('failed')
      expect(result.sessionUsage.turnUsageUnavailable).toBe(status === 'started' ? true : undefined)
      expect(upstream).toHaveBeenCalledTimes(status === 'started' ? 0 : 1)
      if (status === 'completed') {
        expect(result.requests).toEqual([
          expect.objectContaining({ status: 'completed', usageKnown: true })
        ])
        expect(await artifacts()).toContainEqual(expect.objectContaining({ status: 'started' }))
      }
    }
  )

  it('records an HTTP failure without upstream content and without retrying', async () => {
    const upstream = vi.fn(async () => new Response('private-fixture-key', { status: 503 }))
    const result = await runHarnessSmoke(options(), new AbortController().signal, upstream)
    expect(result.status).toBe('failed')
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(await artifacts()).toContainEqual(
      expect.objectContaining({ status: 'failed', httpStatus: 503 })
    )
    expect(JSON.stringify(await artifacts())).not.toContain('private-fixture-key')
  })

  it('cancels an in-flight run and retains its interrupted receipt', async () => {
    const controller = new AbortController()
    const result = await runHarnessSmoke(options(), controller.signal, async (url, init) => {
      controller.abort()
      return fixtureModel(url, init)
    })
    expect(result.status).toBe('interrupted')
    expect(result.requests).toEqual([
      expect.objectContaining({ status: 'interrupted', usageKnown: false })
    ])
  })

  it('refuses to overwrite an existing experiment', async () => {
    await runHarnessSmoke(options(), new AbortController().signal)
    const before = await artifacts()
    const upstream = vi.fn()
    await expect(
      runHarnessSmoke(options(), new AbortController().signal, upstream)
    ).rejects.toThrow()
    expect(upstream).not.toHaveBeenCalled()
    expect(await artifacts()).toEqual(before)
  })

  it('requires explicit live configuration and keeps credentials out of arguments', () => {
    expect(parseSmokeOptions(['--output=result'], {})).toMatchObject({
      mode: 'fixture',
      model: 'fixture-model'
    })
    expect(
      parseSmokeOptions(
        ['--live', '--output=result', '--endpoint=https://provider.invalid', '--model=m'],
        { OPEN_SCIENCE_HARNESS_API_KEY: 'key' }
      )
    ).toMatchObject({ mode: 'live', model: 'm', key: 'key' })
    for (const args of [
      [],
      ['--live', '--output=result'],
      ['--output=result', '--key=secret'],
      ['--output=a', '--output=b'],
      ['--output=result', '--model=m']
    ]) {
      expect(() => parseSmokeOptions(args, {})).toThrow()
    }
    expect(() =>
      parseSmokeOptions(
        [
          '--live',
          '--output=result',
          '--endpoint=https://user:password@provider.invalid',
          '--model=m'
        ],
        { OPEN_SCIENCE_HARNESS_API_KEY: 'key' }
      )
    ).toThrow()
  })
})
