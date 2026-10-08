/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_TARGET,
  LOCAL_TARGET,
  createPdfTranslationAgentExecutor
} from './pdf-translation-agent'
import { createPdfTranslationSource } from './pdf-translation'
import { pdfTranslationFailure } from '../../../../../../shared/pdf-translation'

const source = createPdfTranslationSource({
  resourceRequestKey: 'paper/version',
  fingerprint: 'sha',
  pages: [],
  units: [
    { id: '1', source: 'ATP increased.', fragments: [] },
    { id: '2', source: 'table', fragments: [], sourceOnly: true }
  ]
})
const options = {
  targetId: 'agent',
  language: '中文',
  glossary: [{ source: 'ATP', target: '三磷酸腺苷' }]
}
const setup = () => {
  const runtime = {
    begin: vi.fn().mockResolvedValue({ operationId: 'operation', targetKey: 'model-key' }),
    translate: vi.fn().mockResolvedValue('ATP 增加。'),
    close: vi.fn().mockResolvedValue(undefined)
  }
  const signal = new AbortController()
  return { runtime, signal, executor: createPdfTranslationAgentExecutor(runtime) }
}
const request = (signal: AbortSignal) => ({
  target: AGENT_TARGET,
  language: options.language,
  glossary: options.glossary,
  sourceIndex: 0,
  source: source.units[0].source,
  signal
})

describe('PDF translation agent executor', () => {
  it('passes the selected API model through admission and retries', async () => {
    const h = setup()
    const selected = {
      ...options,
      targetId: 'api',
      apiModel: { providerId: 'provider', modelId: 'chosen' }
    }
    await h.executor.begin!(source, selected, h.signal.signal)
    expect(h.runtime.begin).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'api', apiModel: selected.apiModel })
    )
    await h.executor.end!(h.signal.signal)
    await h.executor.begin!(source, selected, new AbortController().signal)
    expect(h.runtime.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiModel: selected.apiModel, expectedTargetKey: 'model-key' })
    )
  })
  it.each(['upload-version', 'artifact-version'] as const)(
    'admits the immutable %s source without a literature attachment',
    async (kind) => {
      const h = setup()
      const documentSource = {
        kind,
        projectId: 'project-1',
        sourceFileId: 'file-1',
        versionId: 'version-1',
        sessionId: 'creator',
        checksum: 'a'.repeat(64),
        name: 'paper.pdf',
        path: `${kind}:version-1`
      }
      await h.executor.begin!(source, { ...options, documentSource }, h.signal.signal)
      expect(h.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ documentSource }))
      expect(h.runtime.begin.mock.calls[0][0]).not.toHaveProperty('attachmentVersionId')
      await expect(h.executor.translate(request(h.signal.signal))).resolves.toBe('ATP 增加。')
      await h.executor.end!(h.signal.signal)
    }
  )
  it('converts rejected answer results into the existing retry path and keeps the operation open', async () => {
    const h = setup()
    await h.executor.begin!(source, options, h.signal.signal)
    h.runtime.translate.mockResolvedValueOnce({
      failure: 'incomplete-output',
      diagnostic: { reasonCode: 'missing-numeric-literals', pageNumbers: [1], attempts: 2 },
      message:
        '[pdf-translation:incomplete-output] The translation omitted required numeric values.'
    })
    const error = await h.executor.translate(request(h.signal.signal)).catch((error) => error)
    expect(pdfTranslationFailure(error)).toBe('incomplete-output')
    expect(error.diagnostic).toEqual({
      reasonCode: 'missing-numeric-literals',
      pageNumbers: [1],
      attempts: 2
    })
    expect(error.message.match(/\[pdf-translation:incomplete-output\]/g)).toHaveLength(1)
    expect(h.runtime.close).not.toHaveBeenCalled()
    await expect(h.executor.translate(request(h.signal.signal))).resolves.toBe('ATP 增加。')
    await h.executor.end!(h.signal.signal)
  })
  it('binds a document once and closes after its paragraphs finish', async () => {
    const h = setup()
    await h.executor.begin!(source, options, h.signal.signal)
    expect(h.runtime.begin).toHaveBeenCalledWith({
      resourceRequestKey: source.resourceRequestKey,
      fingerprint: source.fingerprint,
      targetId: 'agent',
      batchShortSources: true,
      language: options.language,
      glossary: options.glossary,
      sources: ['ATP increased.'],
      sourceLocations: [{ pageNumbers: [], fragmentCount: 0 }]
    })
    expect(await h.executor.translate(request(h.signal.signal))).toBe('ATP 增加。')
    expect(h.runtime.translate).toHaveBeenCalledWith({
      operationId: 'operation',
      sourceIndex: 0,
      source: 'ATP increased.'
    })
    await h.executor.translate({ ...request(h.signal.signal), replaceExisting: true })
    expect(h.runtime.translate).toHaveBeenLastCalledWith({
      operationId: 'operation',
      sourceIndex: 0,
      source: 'ATP increased.',
      replaceExisting: true
    })
    await h.executor.end!(h.signal.signal)
    await h.executor.end!(h.signal.signal)
    expect(h.runtime.close).toHaveBeenCalledOnce()
  })
  it('keeps the admitted model and checkpoint after cancelling before the first paragraph', async () => {
    const h = setup()
    const checkpoint = { key: '11111111-1111-4111-8111-111111111111', revision: 1 }
    h.runtime.begin.mockResolvedValue({
      operationId: 'operation',
      targetKey: 'model-key',
      checkpoint
    })
    await h.executor.begin!(source, options, h.signal.signal)
    h.signal.abort()
    await h.executor.end!(h.signal.signal)
    expect(h.runtime.translate).not.toHaveBeenCalled()
    const retry = new AbortController()
    await h.executor.begin!(source, options, retry.signal)
    expect(h.runtime.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedTargetKey: 'model-key', checkpoint })
    )
    await h.executor.end!(retry.signal)
    const fresh = new AbortController()
    await h.executor.begin!(source, { ...options }, fresh.signal)
    expect(h.runtime.begin.mock.lastCall![0]).not.toHaveProperty('expectedTargetKey')
    expect(h.runtime.begin.mock.lastCall![0]).not.toHaveProperty('checkpoint')
    await h.executor.end!(fresh.signal)
  })
  it('closes an operation that finishes admission after cancellation', async () => {
    const h = setup()
    let resolve!: (value: { operationId: string; targetKey: string }) => void
    h.runtime.begin.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const pending = h.executor.begin!(source, options, h.signal.signal)
    const rejected = expect(pending).rejects.toThrow()
    h.signal.abort()
    resolve({ operationId: 'late', targetKey: 'model-key' })
    await rejected
    expect(h.runtime.close).toHaveBeenCalledWith({ operationId: 'late' })
    h.runtime.begin.mockResolvedValue({ operationId: 'retry', targetKey: 'current-model' })
    const retry = new AbortController()
    await h.executor.begin!(source, options, retry.signal)
    expect(h.runtime.begin.mock.lastCall![0]).not.toHaveProperty('expectedTargetKey')
    await h.executor.end!(retry.signal)
  })
  it('does not let cancelled late admission overwrite the model pinned by a newer retry', async () => {
    const h = setup()
    let resolve!: (value: { operationId: string; targetKey: string }) => void
    h.runtime.begin
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue({ operationId: 'new-operation', targetKey: 'new-model-key' })
    const pending = h.executor.begin!(source, options, h.signal.signal)
    const rejected = expect(pending).rejects.toThrow()
    h.signal.abort()
    const retry = new AbortController()
    await h.executor.begin!(source, options, retry.signal)
    resolve({ operationId: 'old-operation', targetKey: 'old-model-key' })
    await rejected
    expect(h.runtime.close).toHaveBeenCalledExactlyOnceWith({ operationId: 'old-operation' })
    await h.executor.translate(request(retry.signal))
    expect(h.runtime.translate).toHaveBeenLastCalledWith(
      expect.objectContaining({ operationId: 'new-operation' })
    )
    await h.executor.end!(retry.signal)
    const next = new AbortController()
    await h.executor.begin!(source, options, next.signal)
    expect(h.runtime.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedTargetKey: 'new-model-key' })
    )
    await h.executor.end!(next.signal)
  })
  it('cancels through the main operation and ignores a late translation', async () => {
    const h = setup()
    await h.executor.begin!(source, options, h.signal.signal)
    let resolve!: (value: string) => void
    h.runtime.translate.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const pending = h.executor.translate(request(h.signal.signal))
    const rejected = expect(pending).rejects.toThrow()
    h.signal.abort()
    resolve('late')
    await rejected
    expect(h.runtime.close).toHaveBeenCalledOnce()
  })
  it('requires preparation and rejects implicit target fallback', async () => {
    const h = setup()
    await expect(h.executor.translate(request(h.signal.signal))).rejects.toThrow('not prepared')
    await expect(
      h.executor.translate({
        ...request(h.signal.signal),
        target: { ...AGENT_TARGET, id: 'other' }
      })
    ).rejects.toThrow('Unsupported')
    expect(h.runtime.translate).not.toHaveBeenCalled()
  })
})

it('carries the selected API route and rejects a mismatched route within a run', async () => {
  const h = setup()
  const api = h.executor.targets.find((target) => target.id === 'api')!
  await h.executor.begin!(source, { ...options, targetId: 'api' }, h.signal.signal)
  expect(h.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'api' }))
  await expect(h.executor.translate(request(h.signal.signal))).rejects.toThrow('not prepared')
  expect(h.runtime.translate).not.toHaveBeenCalled()
  expect(await h.executor.translate({ ...request(h.signal.signal), target: api })).toBe(
    'ATP 增加。'
  )
  h.signal.abort()
  expect(h.runtime.close).toHaveBeenCalledOnce()
})

it('passes the selected independent request limit to the owner', async () => {
  const h = setup()
  await h.executor.begin!(source, { ...options, concurrency: 4 }, h.signal.signal)
  expect(h.runtime.begin).toHaveBeenCalledWith(
    expect.objectContaining({ concurrency: 4, batchShortSources: true })
  )
  await h.executor.end!(h.signal.signal)
})

it('carries the explicit Agent model without leaking it into Direct API requests', async () => {
  const h = setup()
  const agentModel = {
    frameworkId: 'opencode' as const,
    providerId: 'other-provider',
    modelId: 'chosen-model',
    reasoningEffort: 'default' as const
  }
  await h.executor.begin!(source, { ...options, agentModel }, h.signal.signal)
  expect(h.runtime.begin).toHaveBeenCalledWith(
    expect.objectContaining({ targetId: 'agent', agentModel })
  )
  await h.executor.end!(h.signal.signal)
  await h.executor.begin!(
    source,
    { ...options, targetId: 'api', agentModel },
    new AbortController().signal
  )
  expect(h.runtime.begin.mock.calls.at(-1)?.[0]).not.toHaveProperty('agentModel')
})

it('exposes skip only when supported and binds it to a newly admitted operation', async () => {
  const h = setup()
  expect(h.executor.skip).toBeUndefined()
  const skip = vi.fn().mockResolvedValue(undefined)
  const executor = createPdfTranslationAgentExecutor({ ...h.runtime, skip })
  const fresh = new AbortController().signal
  await expect(executor.skip!(request(fresh))).rejects.toThrow('not prepared')
  expect(skip).not.toHaveBeenCalled()
  await executor.begin!(source, options, fresh)
  await executor.skip!(request(fresh))
  expect(skip).toHaveBeenCalledWith({
    operationId: 'operation',
    sourceIndex: 0,
    source: source.units[0].source
  })
  expect(h.runtime.translate).not.toHaveBeenCalled()
  await executor.end!(fresh)
  await expect(executor.skip!(request(fresh))).rejects.toThrow('not prepared')
})

it('routes installed local translation through the owner without provider selection or batching', async () => {
  const h = setup()
  expect(h.executor.targets.map((target) => target.id)).toEqual(['api', 'agent'])
  const local = LOCAL_TARGET
  expect(local.mode).toBe('local')
  await h.executor.begin!(
    source,
    { ...options, targetId: 'local', concurrency: 1 },
    h.signal.signal
  )
  expect(h.runtime.begin).toHaveBeenCalledWith(
    expect.objectContaining({ targetId: 'local', batchShortSources: false, concurrency: 1 })
  )
  expect(h.runtime.begin.mock.calls[0][0]).not.toHaveProperty('agentModel')
  expect(h.runtime.begin.mock.calls[0][0]).not.toHaveProperty('apiModel')
  await expect(h.executor.translate({ ...request(h.signal.signal), target: local })).resolves.toBe(
    'ATP 增加。'
  )
  h.signal.abort()
  await h.executor.end!(h.signal.signal)
  expect(h.runtime.close).toHaveBeenCalledExactlyOnceWith({ operationId: 'operation' })
})
