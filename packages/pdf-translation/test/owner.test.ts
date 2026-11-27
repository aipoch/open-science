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

it('keeps recognized inline formulas outside the requested translation and skips formula-only blocks', async () => {
  const h = setup()
  const source = 'Samples use [2, 5]m and ℓ∞.',
    formula = '3−q',
    sources = [source, formula]
  h.run.mockResolvedValueOnce({
    text: '样本使用 ⟦PDFMATHA⟧ 和 ⟦PDFMATHB⟧。',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 8, cacheTokens: 0 }
  })
  try {
    const { operationId } = await h.owner.begin(
      { ...input, sources, batchShortSources: true },
      h.caller
    )
    await expect(
      h.owner.translate({ operationId, sourceIndex: 0, source }, h.caller)
    ).resolves.toBe('样本使用 [2, 5]m 和 ℓ∞。')
    await expect(
      h.owner.translate({ operationId, sourceIndex: 1, source: formula }, h.caller)
    ).resolves.toBe(formula)
    expect(h.run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prompt: expect.stringContaining('"source":"Samples use ⟦PDFMATHA⟧ and ⟦PDFMATHB⟧."'),
        systemPrompt: expect.stringContaining('Copy each ⟦PDFMATH…⟧ formula placeholder')
      })
    )
  } finally {
    await h.owner.shutdown()
  }
})

it.each(['⟦PDFMATHB⟧ 和 ⟦PDFMATHA⟧', '⟦PDFMATHA⟧ 和 ⟦PDFMATHA⟧', '⟦PDFMATHA⟧'])(
  'rejects reordered, repeated or omitted formula placeholders (%s)',
  async (output) => {
    const h = setup()
    const source = 'Samples use [2, 5]m and ℓ∞.'
    h.run.mockResolvedValueOnce({
      text: '样本使用 ' + output + '。',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 8, cacheTokens: 0 }
    })
    try {
      const { operationId } = await h.owner.begin({ ...input, sources: [source] }, h.caller)
      await expect(
        h.owner.translate({ operationId, sourceIndex: 0, source }, h.caller)
      ).rejects.toMatchObject({ code: 'incomplete-output' })
    } finally {
      await h.owner.shutdown()
    }
  }
)

it('restores each prefetched formula against its own batch member', async () => {
  const h = setup()
  const sources = ['Estimate the scale.', 'Use the range [2, 5]m.']
  h.run.mockResolvedValueOnce({
    text: JSON.stringify([
      { sourceIndex: 0, translation: '估计尺度。' },
      { sourceIndex: 1, translation: '使用范围 ⟦PDFMATHA⟧。' }
    ]),
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 8, cacheTokens: 0 }
  })
  try {
    const { operationId } = await h.owner.begin(
      { ...input, sources, batchShortSources: true },
      h.caller
    )
    const translate = (sourceIndex: number) =>
      h.owner.translate({ operationId, sourceIndex, source: sources[sourceIndex] }, h.caller)
    await expect(translate(0)).resolves.toBe('估计尺度。')
    await expect(translate(1)).resolves.toBe('使用范围 [2, 5]m。')
    expect(h.run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prompt: expect.stringContaining('"source":"Use the range ⟦PDFMATHA⟧."'),
        systemPrompt: expect.stringContaining('Copy each ⟦PDFMATH…⟧ formula placeholder')
      })
    )
  } finally {
    await h.owner.shutdown()
  }
})

it('restores formulas and numeric phrases together on a numeric retry', async () => {
  const h = setup()
  const source = 'Use the range [2, 5]m with 12 samples.'
  h.run
    .mockResolvedValueOnce({
      text: '采用范围 ⟦PDFMATHA⟧ 进行采样。',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 8, cacheTokens: 0 }
    })
    .mockResolvedValueOnce({
      text: '在范围 ⟦PDFMATHA⟧ 内使用 <q0>12 个样本</q0>。',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 8, cacheTokens: 0 }
    })
  try {
    const { operationId } = await h.owner.begin({ ...input, sources: [source] }, h.caller)
    const request = { operationId, sourceIndex: 0, source }
    await expect(h.owner.translate(request, h.caller)).rejects.toMatchObject({
      code: 'incomplete-output'
    })
    await expect(h.owner.translate(request, h.caller)).resolves.toBe(
      '在范围 [2, 5]m 内使用 12 个样本。'
    )
    expect(h.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          '"source":"Use the range ⟦PDFMATHA⟧ with <q0>12 samples</q0>."'
        )
      })
    )
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
