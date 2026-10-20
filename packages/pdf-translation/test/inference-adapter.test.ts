import { expect, it, vi } from 'vitest'
import { PdfTranslationOwner } from '../src/index.js'
import { pdfTranslationAgentModelSchema } from '../src/contracts.js'
import { TestCallerRegistry } from './support/callers.js'

it('translates through an independently supplied framework without a host framework registry', async () => {
  const agentModel = {
    frameworkId: 'independent-harness',
    providerId: 'provider',
    modelId: 'model',
    reasoningEffort: 'default' as const
  }
  const target = {
    frameworkId: agentModel.frameworkId,
    providerId: 'provider',
    model: { kind: 'required' as const, id: 'model' },
    reasoningEffort: agentModel.reasoningEffort
  }
  const runner = {
    run: vi.fn(async () => ({ text: '细胞。', stopReason: 'end_turn' })),
    supportsTarget: vi.fn(() => true),
    shutdown: vi.fn(async () => {}),
    sweepStaleProfiles: vi.fn(async () => {})
  }
  const captureTarget = vi.fn(async () => target)
  const owner = new PdfTranslationOwner({
    captureTarget,
    runner,
    usage: { start: async () => async () => {}, recover: async () => {}, flush: async () => {} }
  })
  const registry = new TestCallerRegistry()
  const { lease } = registry.acquire({ leaseId: 'standalone' })
  try {
    const result = await owner.begin(
      {
        resourceRequestKey: 'document',
        fingerprint: 'fingerprint',
        language: 'Chinese',
        glossary: [],
        sources: ['Cell.'],
        agentModel
      },
      lease
    )
    expect(captureTarget).toHaveBeenCalledWith(agentModel)
    expect(result.model).toMatchObject({ frameworkId: agentModel.frameworkId })
    await expect(
      owner.translate({ operationId: result.operationId, sourceIndex: 0, source: 'Cell.' }, lease)
    ).resolves.toBe('细胞。')
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ target }))
  } finally {
    await owner.shutdown()
    registry.dispose()
  }
})

it.each(['', ' ', 'x'.repeat(81)])('rejects an invalid adapter identifier %j', (frameworkId) => {
  expect(
    pdfTranslationAgentModelSchema.safeParse({
      frameworkId,
      providerId: 'provider',
      reasoningEffort: 'default'
    }).success
  ).toBe(false)
})
