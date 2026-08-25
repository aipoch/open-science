import { describe, expect, it, vi } from 'vitest'

import {
  diffOpenCodeTurnUsage,
  fetchOpenCodeUsageSnapshot,
  sumOpenCodeTurnUsage
} from './opencode-turn-usage'

const api = {
  baseUrl: 'http://127.0.0.1:4242',
  authorization: 'Basic secret'
}

describe('OpenCode turn usage', () => {
  it('fetches authenticated assistant usage from the session message API', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { info: { id: 'user-1', role: 'user' } },
            {
              info: {
                id: 'assistant-1',
                role: 'assistant',
                tokens: { input: 10, output: 4, cache: { read: 3, write: 2 } }
              }
            }
          ])
        )
    )

    const snapshot = await fetchOpenCodeUsageSnapshot(
      api,
      'session/with spaces',
      '/workspace with spaces',
      fetchImpl
    )

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(
        'http://127.0.0.1:4242/session/session%2Fwith%20spaces/message?directory=%2Fworkspace+with+spaces'
      ),
      expect.objectContaining({ headers: { authorization: 'Basic secret' } })
    )
    expect(snapshot?.assistantMessageIds).toEqual(new Set(['assistant-1']))
    expect(snapshot?.usageByMessageId.get('assistant-1')).toEqual({
      inputTokens: 10,
      cacheTokens: 5,
      cachedReadTokens: 3,
      cachedWriteTokens: 2,
      outputTokens: 4
    })
  })

  it.each([
    ['no cache fields', undefined, 0],
    ['only cache read', { read: 7 }, 7],
    ['only cache write', { write: 5 }, 5],
    ['null cache read', { read: null, write: 5 }, 5],
    ['null cache write', { read: 7, write: null }, 7]
  ])('keeps aggregate cache without inventing a split for %s', async (_label, cache, total) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              info: {
                id: 'assistant-1',
                role: 'assistant',
                tokens: { input: 10, output: 4, ...(cache === undefined ? {} : { cache }) }
              }
            }
          ])
        )
    )

    const snapshot = await fetchOpenCodeUsageSnapshot(api, 'session-1', '/workspace', fetchImpl)

    expect(snapshot?.usageByMessageId.get('assistant-1')).toEqual({
      inputTokens: 10,
      cacheTokens: total,
      outputTokens: 4
    })
  })

  it('sums only assistant messages created after the turn baseline', () => {
    const before = {
      assistantMessageIds: new Set(['old']),
      usageByMessageId: new Map([['old', { inputTokens: 99, cacheTokens: 9, outputTokens: 9 }]])
    }
    const after = {
      assistantMessageIds: new Set(['old', 'step-1', 'step-2']),
      usageByMessageId: new Map([
        ['old', { inputTokens: 99, cacheTokens: 9, outputTokens: 9 }],
        [
          'step-1',
          {
            inputTokens: 12,
            cacheTokens: 3,
            cachedReadTokens: 2,
            cachedWriteTokens: 1,
            outputTokens: 2
          }
        ],
        [
          'step-2',
          {
            inputTokens: 19,
            cacheTokens: 5,
            cachedReadTokens: 4,
            cachedWriteTokens: 1,
            outputTokens: 3
          }
        ]
      ])
    }

    expect(sumOpenCodeTurnUsage(before, after)).toEqual({
      inputTokens: 31,
      cacheTokens: 8,
      cachedReadTokens: 6,
      cachedWriteTokens: 2,
      outputTokens: 5,
      turnCount: 2
    })

    expect(diffOpenCodeTurnUsage(before, after)?.modelCalls).toEqual([
      {
        sourceInvocationId: 'step-1',
        inputTokens: 12,
        cacheTokens: 3,
        cachedReadTokens: 2,
        cachedWriteTokens: 1,
        outputTokens: 2,
        contextUsedTokens: 14
      },
      {
        sourceInvocationId: 'step-2',
        inputTokens: 19,
        cacheTokens: 5,
        cachedReadTokens: 4,
        cachedWriteTokens: 1,
        outputTokens: 3,
        contextUsedTokens: 23
      }
    ])
  })

  it('omits the cache split when any new assistant step lacks it', () => {
    expect(
      sumOpenCodeTurnUsage(
        { assistantMessageIds: new Set(), usageByMessageId: new Map() },
        {
          assistantMessageIds: new Set(['step-1', 'step-2']),
          usageByMessageId: new Map([
            [
              'step-1',
              {
                inputTokens: 12,
                cacheTokens: 3,
                cachedReadTokens: 2,
                cachedWriteTokens: 1,
                outputTokens: 2
              }
            ],
            ['step-2', { inputTokens: 19, cacheTokens: 5, outputTokens: 3 }]
          ])
        }
      )
    ).toEqual({
      inputTokens: 31,
      cacheTokens: 8,
      outputTokens: 5,
      turnCount: 2
    })
  })

  it('fails closed instead of publishing a partial sum', () => {
    expect(
      sumOpenCodeTurnUsage(
        { assistantMessageIds: new Set(), usageByMessageId: new Map() },
        {
          assistantMessageIds: new Set(['complete', 'missing']),
          usageByMessageId: new Map([
            ['complete', { inputTokens: 12, cacheTokens: 3, outputTokens: 2 }]
          ])
        }
      )
    ).toBeUndefined()
  })

  it('treats an unavailable local API as an absent snapshot', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection closed')
    })

    await expect(
      fetchOpenCodeUsageSnapshot(api, 'session-1', '/workspace', fetchImpl)
    ).resolves.toBeUndefined()
  })
})
