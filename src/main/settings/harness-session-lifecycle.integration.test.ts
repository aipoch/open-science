import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HarnessSessionOwner } from './harness-session-owner'
import { SettingsRepository } from './repository'
import { ProviderRuntimeHealthOwner } from './provider-runtime-health-owner'
import { ProviderTransportOwner, type HarnessProviderLease } from './provider-transport-owner'
import { ProtocolForwardingBridge } from './protocol-forwarding-bridge'
import type { HarnessModelObservation } from './harness-model-request'

it.each(['config-edit', 'auth-failure'] as const)(
  'revokes real loopback traffic on %s without waiting on the triggering request',
  async (trigger) => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-lifecycle-'))
    const repository = new SettingsRepository(directory)
    const provider = {
      id: 'p1',
      name: 'Fixture',
      type: 'custom' as const,
      baseUrl: 'https://fixture.invalid',
      model: 'm',
      apiEndpoints: ['chat-completions' as const]
    }
    await repository.upsertProvider(provider)
    const health = new ProviderRuntimeHealthOwner(repository)
    let started!: () => void
    const upstreamStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let upstreamSignal: AbortSignal | null | undefined
    const upstream = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        upstreamSignal = init?.signal
        started()
        if (trigger === 'auth-failure')
          return Response.json({ error: { message: 'Invalid fixture key' } }, { status: 401 })
        await new Promise<void>((resolve) =>
          upstreamSignal!.addEventListener('abort', () => resolve(), { once: true })
        )
        throw new Error('upstream aborted')
      }
    )
    let connection!: HarnessProviderLease['connection']
    const owner = new HarnessSessionOwner(
      repository,
      new ProviderTransportOwner({
        onProviderFailure: (target, failure) => health.observe(target, failure),
        createProtocolForwardingBridge: (targets, id) => {
          const bridge = new ProtocolForwardingBridge(targets, id, upstream)
          const start = bridge.start.bind(bridge)
          vi.spyOn(bridge, 'start').mockImplementation(async () => {
            connection = await start()
            return connection
          })
          return bridge
        }
      })
    )
    try {
      const session = await owner.open(
        { providerId: 'p1', model: 'm', maxSteps: 2 },
        new AbortController().signal
      )
      const observations: HarnessModelObservation[] = []
      const turn = session.run(async (_signal, _index, model) => {
        await model.request({ messages: [] }, async (event) => {
          observations.push(event)
        })
        return 'complete'
      })
      await upstreamStarted
      if (trigger === 'config-edit')
        await repository.upsertProvider(
          { ...provider, baseUrl: 'https://changed.invalid' },
          'p1',
          {}
        )
      expect(await turn).toBe('cancelled')
      expect(observations.map((event) => event.status)).toEqual(['started', 'interrupted'])
      await session.dispose()
      expect(session.signal.aborted).toBe(true)
      if (trigger === 'config-edit') await expect.poll(() => upstreamSignal?.aborted).toBe(true)
      else
        expect((await repository.getSettings()).providers[0].lastValidationFailure?.category).toBe(
          'auth'
        )
      await expect(
        fetch(`${connection.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${connection.token}` },
          body: '{}'
        })
      ).rejects.toThrow()
      expect(upstream).toHaveBeenCalledTimes(1)
    } finally {
      await owner.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it('runs a tool exchange through the session request capability with route-scoped usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-tool-exchange-'))
  const repository = new SettingsRepository(directory)
  await repository.upsertProvider({
    id: 'p1',
    name: 'Fixture',
    type: 'custom',
    baseUrl: 'https://fixture.invalid',
    model: 'bound',
    apiEndpoints: ['chat-completions']
  })
  const upstream = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('bound')
    expect(body.stream).toBe(false)
    const done = body.messages.at(-1).role === 'tool'
    if (done) expect(body.messages.at(-1)).toMatchObject({ tool_call_id: 'call-1', content: '42' })
    return Response.json({
      choices: [
        {
          finish_reason: done ? 'stop' : 'tool_calls',
          message: {
            role: 'assistant',
            content: done ? '42 rows' : null,
            ...(done
              ? {}
              : {
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'count_rows', arguments: '{}' }
                    }
                  ]
                })
          }
        }
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 5 }
      }
    })
  })
  const owner = new HarnessSessionOwner(
    repository,
    new ProviderTransportOwner({
      createProtocolForwardingBridge: (targets, id) =>
        new ProtocolForwardingBridge(targets, id, upstream)
    })
  )
  try {
    const session = await owner.open(
      { providerId: 'p1', model: 'bound', maxSteps: 3 },
      new AbortController().signal
    )
    const messages: unknown[] = [{ role: 'user', content: 'Count rows' }]
    const observations: HarnessModelObservation[] = []
    expect(
      await session.run(async (_signal, _index, model) => {
        const result = await model.request(
          {
            messages,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'count_rows',
                  parameters: { type: 'object', properties: {}, additionalProperties: false }
                }
              }
            ]
          },
          async (event) => {
            observations.push(event)
          }
        )
        const message = result.response.choices[0].message
        messages.push(message)
        if (message.tool_calls?.length) {
          expect(message.tool_calls).toHaveLength(1)
          expect(message.tool_calls[0].function).toEqual({ name: 'count_rows', arguments: '{}' })
          // Fixture result only: production tool authorization and schema validation stay with the host.
          messages.push({ role: 'tool', tool_call_id: 'call-1', content: '42' })
          return 'continue'
        }
        expect(message.content).toBe('42 rows')
        return 'complete'
      })
    ).toBe('complete')
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(observations.map((event) => event.status)).toEqual([
      'started',
      'completed',
      'started',
      'completed'
    ])
    expect(new Set(observations.map((event) => event.turnId)).size).toBe(1)
    expect(observations.every((event) => event.route.id === session.route.id)).toBe(true)
    expect(observations[3].usage).toMatchObject({
      inputTokens: 15,
      cacheTokens: 5,
      outputTokens: 3
    })
    expect(observations[3].requestId).not.toBe(observations[1].requestId)
  } finally {
    await owner.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
