import { describe, expect, it } from 'vitest'

import { sanitizeAcpModelCallUsage, toAcpTurnTokenUsage } from './acp'
import type { AcpRuntimeEvent } from './acp'

const eventBase = {
  id: 'event-1',
  timestamp: 1,
  level: 'info'
} as const

// @ts-expect-error artifact events require their run and artifact payload
const artifactWithoutPayload: AcpRuntimeEvent = { ...eventBase, kind: 'artifact' }

// @ts-expect-error message events require a role and text
const messageWithoutContent: AcpRuntimeEvent = { ...eventBase, kind: 'message' }

// @ts-expect-error permission events require their request identity
const permissionWithoutRequestId: AcpRuntimeEvent = { ...eventBase, kind: 'permission' }

// @ts-expect-error tool events cannot carry artifact payloads
const toolWithArtifactPayload: AcpRuntimeEvent = {
  ...eventBase,
  kind: 'tool',
  toolCallId: 'tool-1',
  artifacts: []
}

describe('ACP turn token usage', () => {
  it('preserves cache details only when the agent reports both read and write categories', () => {
    expect(
      toAcpTurnTokenUsage({
        totalTokens: 160,
        inputTokens: 100,
        cachedReadTokens: 30,
        cachedWriteTokens: 20,
        outputTokens: 10
      })
    ).toEqual({
      inputTokens: 100,
      cacheTokens: 50,
      cachedReadTokens: 30,
      cachedWriteTokens: 20,
      outputTokens: 10
    })

    expect(
      toAcpTurnTokenUsage({
        totalTokens: 140,
        inputTokens: 100,
        cachedReadTokens: 30,
        outputTokens: 10
      })
    ).toEqual({ inputTokens: 100, cacheTokens: 30, outputTokens: 10 })
  })

  it('normalizes model-call identities before durable projection', () => {
    const call = {
      id: '  call-1  ',
      index: 0,
      sourceInvocationId: '   ',
      inputTokens: 4,
      cacheTokens: 2,
      outputTokens: 3
    }

    expect(sanitizeAcpModelCallUsage(call)).toEqual({
      id: 'call-1',
      index: 0,
      inputTokens: 4,
      cacheTokens: 2,
      outputTokens: 3
    })
    expect(sanitizeAcpModelCallUsage({ ...call, id: '   ' })).toBeUndefined()
  })
})

describe('AcpRuntimeEvent contract', () => {
  it('rejects payloads that do not match their event kind', () => {
    expect([
      artifactWithoutPayload,
      messageWithoutContent,
      permissionWithoutRequestId,
      toolWithArtifactPayload
    ]).toHaveLength(4)
  })
})
