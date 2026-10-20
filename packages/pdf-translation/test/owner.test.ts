/* Fixture builders preserve inferred mock signatures for behavioral assertions. */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it, vi } from 'vitest'
import { PdfTranslationOwner } from '../src/index.js'
import type { TranslationAgentTarget } from '../src/inference.js'
const input = {
  resourceRequestKey: 'reader/version',
  fingerprint: 'fp',
  language: '中文',
  glossary: [],
  sources: ['ATP increased by 12 percent.']
}
function setup() {
  const abort = new AbortController(),
    caller = {
      leaseId: 'reader',
      generation: 1,
      signal: abort.signal,
      isCurrent: () => !abort.signal.aborted
    }
  const target: TranslationAgentTarget = {
    frameworkId: 'claude-code',
    providerId: 'provider',
    model: { kind: 'required', id: 'model' },
    reasoningEffort: 'default'
  }
  const finish = vi.fn(async () => undefined),
    run = vi.fn(async () => ({
      text: 'ATP 增加了 12%。',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 8, cacheTokens: 0 }
    }))
  const owner = new PdfTranslationOwner({
    captureTarget: async () => target,
    runner: {
      run,
      supportsTarget: () => true,
      shutdown: async () => undefined,
      sweepStaleProfiles: async () => undefined
    },
    usage: {
      start: async () => finish,
      recover: async () => undefined,
      flush: async () => undefined
    }
  })
  return { owner, caller, abort, run, finish }
}
it('runs through public inference capabilities and accounts for one completed attempt', async () => {
  const h = setup()
  try {
    const { operationId } = await h.owner.begin(input, h.caller)
    expect(
      await h.owner.translate({ operationId, sourceIndex: 0, source: input.sources[0] }, h.caller)
    ).toBe('ATP 增加了 12%。')
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        usage: { inputTokens: 10, outputTokens: 8, cacheTokens: 0 }
      })
    )
    h.owner.close(operationId, h.caller)
  } finally {
    await h.owner.shutdown()
  }
})
it('fences a stale reader before any model request', async () => {
  const h = setup()
  h.abort.abort()
  await expect(h.owner.begin(input, h.caller)).rejects.toThrow()
  expect(h.run).not.toHaveBeenCalled()
  await h.owner.shutdown()
})
