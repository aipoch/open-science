/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it, vi } from 'vitest'
import { PdfTranslationOwner } from './index'
import type { PdfTranslationCheckpoints } from './checkpoints'
import type { PdfTranslationCheckpoint } from '../../../shared/pdf-translation'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import type { ExplicitAgentBackendTarget } from '../../settings/backend-target'
import {
  ProviderTextGenerationService,
  type ProviderTextGenerationRequest
} from './text-generation'
import { ProviderTextGenerationError } from '@aipoch/providers/client'
vi.mock('electron', () => ({ net: {} }))

const input = {
  resourceRequestKey: 'paper/version-1',
  fingerprint: 'sha',
  language: '中文',
  glossary: [{ source: 'ATP', target: '三磷酸腺苷' }],
  sources: ['ATP increased.']
}
const setup = (checkpoints?: PdfTranslationCheckpoints) => {
  if (checkpoints && !checkpoints.contentKey)
    checkpoints.contentKey = async (source) => JSON.stringify(source)
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'reader', surface: 'electron' })
  const target: ExplicitAgentBackendTarget = {
    frameworkId: 'claude-code',
    providerId: 'provider',
    model: { kind: 'required', id: 'model' },
    reasoningEffort: 'default'
  }
  const runner = {
    run: vi.fn().mockResolvedValue({ text: 'ATP 增加。', stopReason: 'end_turn' }),
    supportsTarget: vi.fn().mockReturnValue(true),
    shutdown: vi.fn(),
    sweepStaleProfiles: vi.fn()
  }
  const captureTarget = vi.fn().mockResolvedValue(target)
  const finishUsage = vi.fn().mockResolvedValue(undefined)
  const usage = {
    start: vi.fn().mockResolvedValue(finishUsage),
    recover: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined)
  }
  return {
    caller,
    registry,
    runner,
    captureTarget,
    target,
    usage,
    finishUsage,
    owner: new PdfTranslationOwner({ captureTarget, runner, usage, checkpoints })
  }
}

describe('PDF translation owner', () => {
  const workspaceSource = {
    kind: 'upload-version' as const,
    projectId: 'project',
    sourceFileId: 'file',
    versionId: 'version',
    checksum: 'a'.repeat(64),
    name: 'paper.pdf',
    path: 'upload-version:version'
  }

  it.each(['upload-version', 'artifact-version'] as const)(
    'opens and appends checkpoints for a %s',
    async (kind) => {
      let checkpoint = {
        version: 1,
        key: '110ce2bd-7610-453e-abfd-dbd905d1e8c5',
        revision: 0,
        documentSource: { ...workspaceSource, kind },
        checksum: workspaceSource.checksum,
        fingerprint: input.fingerprint,
        language: input.language,
        glossary: input.glossary,
        targetKey: 'b'.repeat(64),
        model: { frameworkId: 'claude-code' },
        sources: input.sources,
        translations: [],
        translatedSourceIndices: []
      } as PdfTranslationCheckpoint
      const storage = {
        open: vi.fn(async () => checkpoint),
        append: vi.fn(async (_saved, sourceIndex: number, translation: string) => {
          checkpoint = {
            ...checkpoint,
            revision: 1,
            translations: [translation],
            translatedSourceIndices: [sourceIndex]
          }
          return checkpoint
        }),
        read: vi.fn(async () => checkpoint)
      }
      const h = setup(storage as unknown as PdfTranslationCheckpoints)
      const request = { ...input, documentSource: { ...workspaceSource, kind } }
      const operation = await h.owner.begin(request, h.caller.lease)
      expect(storage.open).toHaveBeenCalledWith(request, expect.any(String), expect.any(Object))
      expect(operation.checkpoint).toEqual({ key: checkpoint.key, revision: 0 })
      try {
        await expect(
          h.owner.translate(
            { operationId: operation.operationId, sourceIndex: 0, source: input.sources[0] },
            h.caller.lease
          )
        ).resolves.toBe('ATP 增加。')
        expect(storage.append).toHaveBeenCalledWith(
          expect.objectContaining({ documentSource: request.documentSource }),
          0,
          'ATP 增加。',
          expect.any(AbortSignal),
          undefined
        )
        await expect(
          h.owner.readCheckpoint(request.documentSource, h.caller.lease)
        ).resolves.toEqual(checkpoint)
        expect(storage.read).toHaveBeenCalledWith(request.documentSource, undefined)
        await h.owner.readCheckpoint(request.documentSource, h.caller.lease, checkpoint.key)
        expect(storage.read).toHaveBeenLastCalledWith(request.documentSource, checkpoint.key)
      } finally {
        h.owner.close(operation.operationId, h.caller.lease)
      }
    }
  )

  it('rejects a workspace source identity failure before invoking a model', async () => {
    const open = vi.fn().mockRejectedValue(new Error('Translation source changed'))
    const h = setup({ open } as unknown as PdfTranslationCheckpoints)
    await expect(
      h.owner.begin({ ...input, documentSource: workspaceSource }, h.caller.lease)
    ).rejects.toThrow('checkpoint-failed')
    expect(h.runner.run).not.toHaveBeenCalled()
    expect(h.usage.start).not.toHaveBeenCalled()
  })

  it.each([
    { documentSource: { ...workspaceSource, checksum: 'not-a-checksum' } },
    { attachmentVersionId: 'version', documentSource: workspaceSource },
    { documentSource: { ...workspaceSource, projectId: undefined } }
  ])('rejects invalid workspace input before capturing a target %j', async (change) => {
    const h = setup()
    await expect(h.owner.begin({ ...input, ...change } as never, h.caller.lease)).rejects.toThrow(
      'Invalid PDF translation source'
    )
    expect(h.captureTarget).not.toHaveBeenCalled()
  })
  it('rejects another caller and cancels pending inference on disconnect', async () => {
    const h = setup()
    const { operationId } = await h.owner.begin(input, h.caller.lease)
    const other = h.registry.acquire({ leaseId: 'other', surface: 'electron' })
    h.owner.close(operationId, other.lease)
    await expect(
      h.owner.translate({ operationId, sourceIndex: 0, source: input.sources[0] }, other.lease)
    ).rejects.toThrow('unavailable')
    h.runner.run.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')))
        )
    )
    const pending = h.owner.translate(
      { operationId, sourceIndex: 0, source: input.sources[0] },
      h.caller.lease
    )
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(h.runner.run).toHaveBeenCalled())
    h.caller.release()
    await rejected
    await expect(
      h.owner.translate({ operationId, sourceIndex: 0, source: input.sources[0] }, h.caller.lease)
    ).rejects.toThrow('unavailable')
  })
})

it('pins an explicitly selected Agent target and rejects silent fallback to the main model', async () => {
  const h = setup()
  const agentModel = {
    frameworkId: 'opencode' as const,
    providerId: 'selected-provider',
    modelId: 'chosen-model',
    reasoningEffort: 'low' as const
  }
  await expect(h.owner.begin({ ...input, agentModel }, h.caller.lease)).rejects.toThrow(
    '[pdf-translation:model-changed]'
  )
  expect(h.runner.run).not.toHaveBeenCalled()
  const explicitTarget = {
    frameworkId: agentModel.frameworkId,
    providerId: agentModel.providerId,
    model: { kind: 'required' as const, id: agentModel.modelId },
    reasoningEffort: agentModel.reasoningEffort
  }
  h.captureTarget.mockResolvedValue(explicitTarget)
  const admission = await h.owner.begin({ ...input, agentModel }, h.caller.lease)
  expect(h.captureTarget).toHaveBeenLastCalledWith(agentModel)
  expect(admission.model).toMatchObject({ ...agentModel, mode: 'agent' })
  await h.owner.translate(
    { operationId: admission.operationId, sourceIndex: 0, source: input.sources[0] },
    h.caller.lease
  )
  expect(h.runner.run).toHaveBeenCalledWith(expect.objectContaining({ target: explicitTarget }))
  h.owner.close(admission.operationId, h.caller.lease)
})

it.each([
  { frameworkId: 'invalid', providerId: 'provider', reasoningEffort: 'default' },
  { frameworkId: 'opencode', providerId: '', reasoningEffort: 'default' },
  { frameworkId: 'opencode', providerId: 'provider', reasoningEffort: 'invalid' }
])('rejects malformed Agent model selections before capture: %j', async (agentModel) => {
  const h = setup()
  await expect(
    h.owner.begin({ ...input, agentModel } as Parameters<typeof h.owner.begin>[0], h.caller.lease)
  ).rejects.toThrow('Invalid PDF translation source.')
  expect(h.captureTarget).not.toHaveBeenCalled()
})

it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
  'retains host admission and translation through %s',
  async (frameworkId) => {
    const h = setup()
    const target = { ...h.target, frameworkId }
    h.captureTarget.mockResolvedValue(target)
    const agentModel = {
      frameworkId,
      providerId: 'provider',
      modelId: 'model',
      reasoningEffort: 'default' as const
    }
    try {
      const admitted = await h.owner.begin({ ...input, agentModel }, h.caller.lease)
      expect(h.captureTarget).toHaveBeenCalledWith(agentModel)
      await expect(
        h.owner.translate(
          { operationId: admitted.operationId, sourceIndex: 0, source: input.sources[0] },
          h.caller.lease
        )
      ).resolves.toBe('ATP 增加。')
      expect(h.runner.run).toHaveBeenCalledWith(expect.objectContaining({ target }))
    } finally {
      await h.owner.shutdown()
      h.registry.dispose()
    }
  }
)

it('returns only public model identity and reports a deadline distinctly from cancellation', async () => {
  const h = setup()
  const admission = await h.owner.begin(input, h.caller.lease)
  expect(admission.model).toEqual({
    frameworkId: 'claude-code',
    modelId: 'model',
    providerId: 'provider',
    reasoningEffort: 'default',
    mode: 'agent'
  })
  h.runner.run.mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')))
      })
  )
  vi.useFakeTimers()
  try {
    const pending = h.owner.translate(
      { operationId: admission.operationId, sourceIndex: 0, source: input.sources[0] },
      h.caller.lease
    )
    const rejected = expect(pending).rejects.toThrow('[pdf-translation:timeout]')
    await vi.advanceTimersByTimeAsync(180000)
    await rejected
  } finally {
    vi.useRealTimers()
    h.owner.close(admission.operationId, h.caller.lease)
  }
})

it.each([
  { type: 'codex-isolated' },
  { type: 'claude-shared' },
  { type: 'custom', vendorId: 'kimiforcode' }
] as const)('rejects subscription direct targets at admission: %j', async (provider) => {
  const h = setup()
  const apiRunner = { supportsTarget: vi.fn(() => true), run: vi.fn() }
  const owner = new PdfTranslationOwner({
    usage: h.usage,
    captureTarget: h.captureTarget,
    runner: h.runner,
    apiRunner,
    // @ts-expect-error Exercise the runtime boundary with an invalid subscription target.
    captureApiTarget: async () => ({ providerId: 'subscription', model: 'model', provider })
  })
  await expect(owner.begin({ ...input, targetId: 'api' }, h.caller.lease)).rejects.toThrow(
    '[pdf-translation:unsupported-model]'
  )
  expect(apiRunner.run).not.toHaveBeenCalled()
})

it('refuses to substitute a different API provider or model after selection', async () => {
  const h = setup()
  const apiRunner = { supportsTarget: vi.fn(() => true), run: vi.fn() }
  const owner = new PdfTranslationOwner({
    usage: h.usage,
    captureTarget: h.captureTarget,
    runner: h.runner,
    apiRunner,
    captureApiTarget: async () => ({
      providerId: 'different-provider',
      model: 'different-model',
      provider: { type: 'custom' }
    })
  })
  await expect(
    owner.begin(
      {
        ...input,
        targetId: 'api',
        apiModel: { providerId: 'selected-provider', modelId: 'selected-model' }
      },
      h.caller.lease
    )
  ).rejects.toThrow('[pdf-translation:model-changed]')
  expect(apiRunner.run).not.toHaveBeenCalled()
})

it('admits direct API independently of ACP and refuses cross-mode resume', async () => {
  const h = setup()
  const apiTarget = {
    providerId: 'provider',
    model: 'model',
    provider: {
      type: 'custom' as const,
      model: 'model',
      key: 'secret',
      baseUrl: 'https://api.example',
      apiEndpoints: ['chat-completions' as const]
    }
  }
  const captureApiTarget = vi.fn(async () => apiTarget)
  const apiRunner = {
    supportsTarget: vi.fn(() => true),
    run: vi.fn(async (request: ProviderTextGenerationRequest) => {
      request.onUsage?.({ inputTokens: 12, cacheTokens: 3, outputTokens: 2 })
      return { text: '<think>private reasoning</think>直接译文', stopReason: 'end_turn' as const }
    })
  }
  const owner = new PdfTranslationOwner({
    usage: h.usage,
    captureTarget: h.captureTarget,
    runner: h.runner,
    captureApiTarget,
    apiRunner
  })
  const apiModel = { providerId: 'provider', modelId: 'model' }
  const first = await owner.begin({ ...input, targetId: 'api', apiModel }, h.caller.lease)
  expect(captureApiTarget).toHaveBeenCalledWith(apiModel)
  expect(first.model).toEqual({
    frameworkId: 'direct-api',
    providerId: 'provider',
    modelId: 'model',
    mode: 'api'
  })
  expect(h.captureTarget).not.toHaveBeenCalled()
  expect(
    await owner.translate(
      { operationId: first.operationId, sourceIndex: 0, source: input.sources[0] },
      h.caller.lease
    )
  ).toBe('直接译文')
  expect(apiRunner.run).toHaveBeenCalledWith(
    expect.objectContaining({
      target: apiTarget,
      maxOutputTokens: 65536,
      prompt: expect.stringContaining('nearbySourceUnits')
    })
  )
  expect(h.runner.run).not.toHaveBeenCalled()
  expect(h.finishUsage).toHaveBeenCalledWith({
    status: 'completed',
    model: undefined,
    usage: { inputTokens: 12, cacheTokens: 3, outputTokens: 2 }
  })
  owner.close(first.operationId, h.caller.lease)
  const numeric = await owner.begin(
    { ...input, targetId: 'api', sources: ['21 Moderate'] },
    h.caller.lease
  )
  await expect(
    owner.translate(
      { operationId: numeric.operationId, sourceIndex: 0, source: '21 Moderate' },
      h.caller.lease
    )
  ).rejects.toThrow('incomplete-output')
  expect(h.finishUsage).toHaveBeenLastCalledWith({
    status: 'failed',
    model: undefined,
    usage: { inputTokens: 12, cacheTokens: 3, outputTokens: 2 }
  })
  owner.close(numeric.operationId, h.caller.lease)
  await expect(
    owner.begin({ ...input, targetId: 'agent', expectedTargetKey: first.targetKey }, h.caller.lease)
  ).rejects.toThrow('model changed')
  await owner.shutdown()
})

it('keeps legacy default identities but fences explicit thinking and transport changes on retry', async () => {
  const h = setup()
  const target: import('./text-generation').ProviderTextGenerationTarget = {
    providerId: 'provider',
    model: 'model',
    provider: {
      type: 'custom',
      baseUrl: 'https://api.example',
      apiEndpoints: ['chat-completions'],
      key: 'secret'
    }
  }
  const captureApiTarget = vi.fn(async () => target)
  const owner = new PdfTranslationOwner({
    usage: h.usage,
    captureTarget: h.captureTarget,
    runner: h.runner,
    captureApiTarget,
    apiRunner: { supportsTarget: () => true, run: vi.fn() }
  })
  const begin = () => owner.begin({ ...input, targetId: 'api' }, h.caller.lease)
  const legacy = await begin()
  owner.close(legacy.operationId, h.caller.lease)
  captureApiTarget.mockResolvedValue({ ...target, reasoningEffort: 'default' })
  const unchanged = await begin()
  expect(unchanged.targetKey).toBe(legacy.targetKey)
  owner.close(unchanged.operationId, h.caller.lease)
  captureApiTarget.mockResolvedValue({ ...target, reasoningEffort: 'none' })
  await expect(
    owner.begin({ ...input, targetId: 'api', expectedTargetKey: legacy.targetKey }, h.caller.lease)
  ).rejects.toThrow('model-changed')
  const explicit = await begin()
  owner.close(explicit.operationId, h.caller.lease)
  captureApiTarget.mockResolvedValue({
    ...target,
    reasoningEffort: 'none',
    provider: {
      ...target.provider,
      reasoningEffortTransport: 'minimax'
    }
  })
  await expect(
    owner.begin(
      { ...input, targetId: 'api', expectedTargetKey: explicit.targetKey },
      h.caller.lease
    )
  ).rejects.toThrow('model-changed')
  expect(h.usage.start).not.toHaveBeenCalled()
  expect(h.runner.run).not.toHaveBeenCalled()
})

it.each(['chat-completions', 'messages', 'responses'] as const)(
  'cleans %s inline thinking before acceptance and keeps billing on reasoning-only failure',
  async (protocol) => {
    const h = setup()
    let answer = '<think>private reasoning</think>ATP 增加。'
    const fetchImpl = vi.fn(async () =>
      Response.json(
        protocol === 'chat-completions'
          ? {
              choices: [{ finish_reason: 'stop', message: { content: answer } }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                completion_tokens_details: { reasoning_tokens: 15 }
              }
            }
          : protocol === 'messages'
            ? {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: answer }],
                usage: { input_tokens: 10, output_tokens: 20 }
              }
            : {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: answer }]
                  }
                ],
                usage: {
                  input_tokens: 10,
                  output_tokens: 20,
                  output_tokens_details: { reasoning_tokens: 15 }
                }
              }
      )
    )
    const owner = new PdfTranslationOwner({
      usage: h.usage,
      captureTarget: h.captureTarget,
      runner: h.runner,
      captureApiTarget: async () => ({
        providerId: 'provider',
        model: 'model',
        provider: {
          type: 'custom',
          key: 'key',
          baseUrl: 'https://api.example',
          apiEndpoints: [protocol]
        }
      }),
      apiRunner: new ProviderTextGenerationService(fetchImpl)
    })
    const { operationId } = await owner.begin({ ...input, targetId: 'api' }, h.caller.lease)
    try {
      const run = () =>
        owner.translate({ operationId, sourceIndex: 0, source: input.sources[0] }, h.caller.lease)
      await expect(run()).resolves.toBe('ATP 增加。')
      expect(h.finishUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'completed',
          usage: expect.objectContaining({ inputTokens: 10, outputTokens: 20 })
        })
      )
      answer = '<think>unfinished private reasoning'
      await expect(run()).rejects.toThrow('incomplete-output')
      expect(h.finishUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'failed',
          usage: expect.objectContaining({ inputTokens: 10, outputTokens: 20 })
        })
      )
      expect(h.runner.run).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      owner.close(operationId, h.caller.lease)
    }
  }
)

it('uses corrective feedback and a capped larger budget on API truncation without leaking the failed output', async () => {
  const h = setup()
  const target = {
    providerId: 'provider',
    model: 'model',
    provider: {
      type: 'custom' as const,
      key: 'secret',
      baseUrl: 'https://api.example',
      apiEndpoints: ['chat-completions' as const]
    }
  }
  const captureApiTarget = vi.fn(async () => target)
  const apiRunner = {
    supportsTarget: vi.fn(() => true),
    run: vi.fn(async (request: ProviderTextGenerationRequest) => {
      request.onUsage?.({ inputTokens: 4, outputTokens: 8, cacheTokens: 0 })
      throw new ProviderTextGenerationError('incomplete-output', 'private provider payload')
    })
  }
  const owner = new PdfTranslationOwner({
    usage: h.usage,
    captureTarget: h.captureTarget,
    runner: h.runner,
    captureApiTarget,
    apiRunner
  })
  const { operationId } = await owner.begin({ ...input, targetId: 'api' }, h.caller.lease)
  const request = { operationId, sourceIndex: 0, source: input.sources[0] }
  await expect(owner.translate(request, h.caller.lease)).rejects.toThrow('incomplete-output')
  captureApiTarget.mockRejectedValue(new Error('settings changed'))
  await expect(owner.translate(request, h.caller.lease)).rejects.toThrow('incomplete-output')
  expect(apiRunner.run.mock.calls.map(([r]) => r.maxOutputTokens)).toEqual([65536, 65536])
  expect(apiRunner.run.mock.calls[1][0].target).toBe(target)
  expect(JSON.parse(apiRunner.run.mock.calls[1][0].prompt).retryFeedback).toEqual({
    sourceIndex: 0,
    reason: 'incomplete-output'
  })
  expect(apiRunner.run.mock.calls[1][0].prompt).not.toContain('private provider payload')
  expect(h.usage.start).toHaveBeenCalledTimes(2)
  expect(h.finishUsage).toHaveBeenCalledTimes(2)
  expect(h.finishUsage).toHaveBeenLastCalledWith({
    status: 'failed',
    model: undefined,
    usage: { inputTokens: 4, outputTokens: 8, cacheTokens: 0 }
  })
  owner.close(operationId, h.caller.lease)
})

it.each(['none', 'low', 'default'] as const)(
  'uses model-default reasoning for correction only when the first pass disabled it (%s)',
  async (reasoningEffort) => {
    const h = setup()
    const target = Object.freeze({
      providerId: 'provider',
      model: 'model',
      reasoningEffort,
      provider: {
        type: 'custom' as const,
        key: 'secret',
        baseUrl: 'https://api.example',
        apiEndpoints: ['chat-completions' as const]
      }
    })
    const captureApiTarget = vi.fn(async () => target)
    const run = vi
      .fn<
        (request: ProviderTextGenerationRequest) => Promise<{
          text: string
          stopReason: 'end_turn'
        }>
      >()
      .mockResolvedValueOnce({ text: '患者', stopReason: 'end_turn' })
      .mockResolvedValueOnce({ text: '<q0>12名患者</q0>', stopReason: 'end_turn' })
      .mockResolvedValueOnce({ text: '细胞', stopReason: 'end_turn' })
    const owner = new PdfTranslationOwner({
      usage: h.usage,
      captureTarget: h.captureTarget,
      runner: h.runner,
      captureApiTarget,
      apiRunner: { supportsTarget: () => true, run }
    })
    const { operationId } = await owner.begin(
      { ...input, sources: ['12 patients', 'Cell'], targetId: 'api' },
      h.caller.lease
    )
    const request = { operationId, sourceIndex: 0, source: '12 patients' }
    try {
      await expect(owner.translate(request, h.caller.lease)).rejects.toThrow('incomplete-output')
      captureApiTarget.mockRejectedValue(new Error('Settings changed after admission'))
      await expect(owner.translate(request, h.caller.lease)).resolves.toBe('12名患者')
      await expect(
        owner.translate({ operationId, sourceIndex: 1, source: 'Cell' }, h.caller.lease)
      ).resolves.toBe('细胞')
      expect(run.mock.calls.map(([request]) => request.target.reasoningEffort)).toEqual([
        reasoningEffort,
        reasoningEffort === 'none' ? 'default' : reasoningEffort,
        reasoningEffort
      ])
      expect(run.mock.calls[0][0].target).toBe(target)
      expect(run.mock.calls[1][0].target.provider).toBe(target.provider)
      expect(run.mock.calls[2][0].target).toBe(target)
      expect(captureApiTarget).toHaveBeenCalledOnce()
      expect(h.usage.start).toHaveBeenCalledTimes(3)
      expect(h.finishUsage.mock.calls.map(([result]) => result.status)).toEqual([
        'failed',
        'completed',
        'completed'
      ])
    } finally {
      owner.close(operationId, h.caller.lease)
    }
  }
)

it('preserves redacted Agent diagnostics at the translation IPC boundary', async () => {
  const h = setup()
  h.runner.run.mockRejectedValue(
    new Error('Agent transport: upstream overloaded\nAuthorization: Bearer synthetic-agent-secret')
  )
  const { operationId } = await h.owner.begin(input, h.caller.lease)
  try {
    const error = await h.owner
      .translate({ operationId, sourceIndex: 0, source: input.sources[0] }, h.caller.lease)
      .catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Agent transport: upstream overloaded')
    expect((error as Error).message).not.toContain('synthetic-agent-secret')
    expect(h.runner.run).toHaveBeenCalledOnce()
  } finally {
    h.owner.close(operationId, h.caller.lease)
  }
})

it.each([false, true])(
  'bounds batch context and rejects context IDs as translations (extra context ID: %s)',
  async (extraContextId) => {
    const h = setup()
    const sources = [
      'Before '.repeat(400),
      ...Array<string>(4).fill('ATP increased.'),
      'After '.repeat(400),
      'Trailing context.'
    ]
    h.runner.run
      .mockResolvedValueOnce({
        text: JSON.stringify([
          ...(extraContextId ? [{ sourceIndex: 0, translation: '前文' }] : []),
          ...[1, 2, 3, 4].map((sourceIndex) => ({ sourceIndex, translation: 'ATP 增加。' }))
        ]),
        stopReason: 'end_turn'
      })
      .mockResolvedValue({ text: 'ATP 增加。', stopReason: 'end_turn' })
    const { operationId } = await h.owner.begin(
      { ...input, sources, batchShortSources: true },
      h.caller.lease
    )
    try {
      await expect(
        h.owner.translate({ operationId, sourceIndex: 1, source: sources[1] }, h.caller.lease)
      ).resolves.toBe('ATP 增加。')
      const prompt = JSON.parse(h.runner.run.mock.calls[0][0].prompt)
      expect(prompt.units.map((unit: { sourceIndex: number }) => unit.sourceIndex)).toEqual([
        1, 2, 3, 4
      ])
      expect(prompt.nearbySourceUnits).toEqual([
        { index: 0, text: sources[0].slice(-1500), truncated: true },
        { index: 5, text: sources[5].slice(0, 1500), truncated: true },
        { index: 6, text: sources[6], truncated: false }
      ])
      expect(h.runner.run.mock.calls[0][0].systemPrompt).toContain(
        'never translate them or include their indices'
      )
      await h.owner.translate({ operationId, sourceIndex: 2, source: sources[2] }, h.caller.lease)
      expect(h.runner.run).toHaveBeenCalledTimes(extraContextId ? 3 : 1)
    } finally {
      h.owner.close(operationId, h.caller.lease)
    }
  }
)

it('falls back from runner-level incomplete output once without failing every later batch', async () => {
  const h = setup()
  const sources = Array<string>(8).fill('ATP increased.')
  const error = new ProviderTextGenerationError('incomplete-output', 'truncated batch')
  Object.defineProperty(error, 'usage', {
    value: { inputTokens: 40, cacheTokens: 0, outputTokens: 5 }
  })
  h.runner.run.mockRejectedValueOnce(error).mockImplementation(async ({ prompt }) => {
    const request = JSON.parse(prompt)
    return {
      text: request.units
        ? JSON.stringify(
            request.units.map(({ sourceIndex }: { sourceIndex: number }) => ({
              sourceIndex,
              translation: 'ATP 增加。'
            }))
          )
        : 'ATP 增加。',
      stopReason: 'end_turn'
    }
  })
  const { operationId } = await h.owner.begin(
    { ...input, sources, batchShortSources: true },
    h.caller.lease
  )
  try {
    for (const [sourceIndex, source] of sources.entries())
      await expect(
        h.owner.translate({ operationId, sourceIndex, source }, h.caller.lease)
      ).resolves.toBe('ATP 增加。')
    expect(h.runner.run).toHaveBeenCalledTimes(6)
    expect(
      h.runner.run.mock.calls.slice(1, 5).every(([request]) => !JSON.parse(request.prompt).units)
    ).toBe(true)
    expect(
      JSON.parse(h.runner.run.mock.calls[5][0].prompt).units.map(
        ({ sourceIndex }: { sourceIndex: number }) => sourceIndex
      )
    ).toEqual([4, 5, 6, 7])
    expect(h.finishUsage.mock.calls.map(([result]) => result.status)).toEqual([
      'failed',
      ...Array(5).fill('completed')
    ])
    expect(h.finishUsage.mock.calls[0][0].usage).toEqual({
      inputTokens: 40,
      cacheTokens: 0,
      outputTokens: 5
    })
  } finally {
    h.owner.close(operationId, h.caller.lease)
  }
})

it('rejects malformed or revoked edition selection before changing a source binding', async () => {
  const storage = { contentKey: vi.fn(async () => 'content'), select: vi.fn(), list: vi.fn() }
  const h = setup(storage as unknown as PdfTranslationCheckpoints)
  try {
    await expect(
      h.owner.selectEdition({ source: '', translationId: 'edition' }, h.caller.lease)
    ).rejects.toThrow()
    expect(storage.contentKey).not.toHaveBeenCalled()
    h.registry.dispose()
    await expect(
      h.owner.selectEdition({ source: 'version', translationId: 'edition' }, h.caller.lease)
    ).rejects.toThrow()
    await expect(h.owner.listEditions('version', h.caller.lease)).rejects.toThrow()
    expect(storage.select).not.toHaveBeenCalled()
    expect(storage.list).not.toHaveBeenCalled()
  } finally {
    await h.owner.shutdown()
  }
})

it('does not call a provider if the durable attempt cannot be recorded', async () => {
  const h = setup()
  h.usage.start.mockRejectedValue(new Error('database unavailable'))
  const { operationId } = await h.owner.begin(input, h.caller.lease)
  await expect(
    h.owner.translate({ operationId, sourceIndex: 0, source: input.sources[0] }, h.caller.lease)
  ).rejects.toThrow('database unavailable')
  expect(h.runner.run).not.toHaveBeenCalled()
})
