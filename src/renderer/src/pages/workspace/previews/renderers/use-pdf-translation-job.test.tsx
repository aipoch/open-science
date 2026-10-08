// @vitest-environment jsdom
import { readPdfTranslationCases } from '../../../../../../../test/fixtures/pdf-translation/read-cases'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationError } from '../../../../../../shared/pdf-translation'
import { createPdfTranslationSource } from './pdf-translation'
import {
  restorePdfTranslationJob,
  usePdfTranslationJob,
  type PdfTranslationExecutor
} from './use-pdf-translation-job'
afterEach(cleanup)
const source = createPdfTranslationSource({
  resourceRequestKey: 'r',
  fingerprint: 'f',
  pages: [{ width: 100, height: 100 }],
  units: ['a', 'table', 'b'].map((id, index) => ({
    id,
    source: id,
    ...(id === 'table' ? { sourceOnly: true as const } : {}),
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 0, y: index / 4, width: 1, height: 0.1 },
        items: [{ index, text: id }]
      }
    ]
  }))
})
const options = {
  targetId: 'selected',
  language: 'Chinese',
  glossary: [{ source: 'a', target: '甲' }]
}
const targets = [{ id: 'selected', label: 'Chosen model', mode: 'agent' as const }]
it.each([0, 1])(
  'restores a pinned Agent model with %i saved paragraphs and requests unfinished sources',
  async (savedCount) => {
    const agentModel = {
      frameworkId: 'opencode' as const,
      providerId: 'saved-provider',
      modelId: 'saved-model',
      reasoningEffort: 'low' as const
    }
    const checkpoint = {
      version: 1 as const,
      key: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      attachmentVersionId: 'version',
      checksum: 'a'.repeat(64),
      fingerprint: source.fingerprint,
      language: 'Chinese',
      glossary: [],
      targetKey: 'b'.repeat(64),
      model: { ...agentModel, mode: 'agent' as const },
      sources: ['a', 'b'],
      translatedSourceIndices: [0].slice(0, savedCount),
      translations: ['甲'].slice(0, savedCount)
    }
    const begin = vi.fn(async () => {})
    const translate = vi.fn(async () => '乙')
    const executor = {
      targets: [{ id: 'agent', label: 'Agent', mode: 'agent' as const }],
      begin,
      translate
    }
    const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
    expect(result.current.state.status).toBe('cancelled')
    expect(result.current.state.done).toBe(savedCount)
    expect(result.current.state.options?.checkpoint).toEqual({
      key: checkpoint.key,
      revision: checkpoint.revision
    })
    expect(result.current.state.options?.agentModel).toEqual(agentModel)
    act(() => result.current.start(result.current.state.options!))
    await waitFor(() => expect(result.current.state.status).toBe('completed'))
    expect(begin).toHaveBeenCalledWith(
      source,
      expect.objectContaining({ agentModel }),
      expect.any(AbortSignal)
    )
    expect(translate).toHaveBeenCalledTimes(2 - savedCount)
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ source: 'b' }))
  }
)
it.each(['upload-version', 'artifact-version'] as const)(
  'resumes a saved %s translation with its full source identity',
  async (kind) => {
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
    const checkpoint = {
      version: 1 as const,
      key: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      documentSource,
      checksum: documentSource.checksum,
      fingerprint: source.fingerprint,
      language: 'Chinese',
      glossary: [],
      concurrency: 2 as const,
      targetKey: 'b'.repeat(64),
      model: {
        frameworkId: 'direct-api',
        mode: 'api' as const,
        providerId: 'saved-provider',
        modelId: 'saved-model'
      },
      sources: ['a', 'b'],
      translatedSourceIndices: [0],
      translations: ['甲']
    }
    const begin = vi.fn(async () => {}),
      translate = vi.fn(async ({ source }: { source: string }) => (source === 'b' ? '乙' : '甲'))
    const executor = {
      targets: [{ id: 'api', label: 'API', mode: 'api' as const }],
      begin,
      translate
    }
    const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
    expect(result.current.state.options?.documentSource).toEqual(documentSource)
    expect(result.current.state.options).not.toHaveProperty('attachmentVersionId')
    act(() => result.current.start(result.current.state.options!))
    await waitFor(() => expect(result.current.state.status).toBe('completed'))
    expect(begin).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        documentSource,
        concurrency: 2,
        apiModel: { providerId: 'saved-provider', modelId: 'saved-model' }
      }),
      expect.any(AbortSignal)
    )
    expect(translate.mock.calls.map(([request]) => request.source)).toEqual(['b'])
  }
)
it('reuses saved body translations after bibliography units become source-only', () => {
  const restored = restorePdfTranslationJob(source, {
    version: 1,
    key: '11111111-1111-4111-8111-111111111111',
    revision: 4,
    attachmentVersionId: 'v',
    checksum: 'a'.repeat(64),
    fingerprint: source.fingerprint,
    language: 'Chinese',
    glossary: [],
    targetKey: 'b'.repeat(64),
    model: { frameworkId: 'opencode' },
    sources: ['a', 'table', 'b'],
    translatedSourceIndices: [0, 1, 2],
    translations: ['甲', '旧参考文献译文', '乙']
  })
  expect(restored).toMatchObject({ status: 'completed', done: 2, total: 2 })
  expect(restored?.results?.units.map((unit) => unit.translation)).toEqual(['甲', '乙'])
})
it('requires explicit target/language and pins the exact options without translating source-only data', async () => {
  const translate = vi.fn(async ({ source }) => `译${source}`),
    executor: PdfTranslationExecutor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => {
    result.current.start({ ...options, targetId: '' })
    result.current.start({ ...options, language: ' ' })
  })
  expect(translate).not.toHaveBeenCalled()
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(translate.mock.calls.map(([r]) => r.source)).toEqual(['a', 'b'])
  expect(translate.mock.calls[0][0]).toMatchObject({
    target: targets[0],
    language: 'Chinese',
    glossary: [{ source: 'a', target: '甲' }]
  })
  expect(result.current.state.results?.source).toBe(source)
  expect(result.current.state.done).toBe(2)
})
it('keeps valid paragraphs and retries an incomplete paragraph once', async () => {
  const translate = vi
    .fn()
    .mockResolvedValueOnce('甲')
    .mockResolvedValueOnce(' ')
    .mockResolvedValueOnce('乙')
  const executor = { targets, translate },
    { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(translate.mock.calls.map(([r]) => r.source)).toEqual(['a', 'b', 'b'])
  expect(translate.mock.calls.map(([r]) => r.sourceIndex)).toEqual([0, 1, 1])
})

it('retries a transient network interruption once and continues later paragraphs', async () => {
  const translate = vi
    .fn()
    .mockRejectedValueOnce(new Error('[provider-failure:network:0] This operation was aborted'))
    .mockResolvedValueOnce('甲')
    .mockResolvedValueOnce('乙')
  const executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(translate.mock.calls.map(([request]) => request.sourceIndex)).toEqual([0, 0, 1])
  expect(result.current.state.done).toBe(2)
})

it('retains progress and stops after two network failures without marking the paragraph invalid', async () => {
  const translate = vi
    .fn()
    .mockResolvedValueOnce('甲')
    .mockRejectedValue(new Error('[provider-failure:network:0] disconnected'))
  const executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  expect(translate.mock.calls.map(([request]) => request.sourceIndex)).toEqual([0, 1, 1])
  expect(result.current.state).toMatchObject({ done: 1, providerFailure: { kind: 'network' } })
  expect(result.current.state.results?.failedUnitIds).toEqual([])
})

it('does not retry a network-looking failure after the user cancels', async () => {
  let reject!: (error: Error) => void
  const translate = vi.fn(
    () => new Promise<string>((_resolve, rejectRequest) => (reject = rejectRequest))
  )
  const executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  act(() => result.current.cancel())
  await act(async () => reject(new Error('[provider-failure:network:0] disconnected')))
  expect(result.current.state.status).toBe('cancelled')
  expect(translate).toHaveBeenCalledOnce()
})
it('marks a failed paragraph after two attempts and allows a targeted retry', async () => {
  const translate = vi
      .fn()
      .mockResolvedValueOnce('甲')
      .mockResolvedValueOnce(' ')
      .mockResolvedValueOnce(' ')
      .mockResolvedValueOnce('乙'),
    executor = { targets, translate },
    { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(result.current.state.done).toBe(1)
  act(() =>
    result.current.start({ ...options, glossary: [{ source: 'changed', target: 'changed' }] })
  )
  expect(translate).toHaveBeenCalledTimes(3)
  expect(result.current.state.results?.failedUnitIds).toEqual(['b'])
  act(() => result.current.retryUnit('b'))
  await waitFor(() => expect(result.current.state.done).toBe(2))
  expect(result.current.state.results?.failedUnitIds).toEqual([])
  expect(translate.mock.calls.map(([r]) => r.source)).toEqual(['a', 'b', 'b', 'b'])
})
it('cancels immediately and ignores a provider that resolves after cancellation', async () => {
  let finish!: (value: string) => void
  const translate = vi.fn<PdfTranslationExecutor['translate']>(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    ),
    executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => {
    result.current.start(options)
    result.current.start(options)
  })
  expect(translate).toHaveBeenCalledTimes(1)
  act(() => result.current.cancel())
  expect(translate.mock.calls[0][0].signal.aborted).toBe(true)
  await act(async () => finish('late'))
  expect(result.current.state.status).toBe('cancelled')
  expect(result.current.state.results).toBeUndefined()
})
it('retains the result snapshot across pause, resume admission and errors until new text arrives', async () => {
  let admit!: () => void
  let finish!: (value: string) => void
  const begin = vi.fn().mockResolvedValue(undefined)
  const translate = vi
    .fn()
    .mockResolvedValueOnce('甲')
    .mockImplementationOnce(() => new Promise<string>(() => {}))
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
  const executor = { targets, begin, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.done).toBe(1))
  const snapshot = result.current.state.results
  act(() => result.current.cancel())
  expect(result.current.state.results).toBe(snapshot)
  begin.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        admit = resolve
      })
  )
  act(() => result.current.start(options))
  expect(result.current.state.status).toBe('running')
  expect(result.current.state.results).toBe(snapshot)
  await act(async () => admit())
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  expect(result.current.state.results).toBe(snapshot)
  act(() => result.current.start(options))
  await waitFor(() => expect(translate).toHaveBeenCalledTimes(4))
  expect(result.current.state.results).toBe(snapshot)
  await act(async () => finish('乙'))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(result.current.state.results).not.toBe(snapshot)
  expect(snapshot?.units).toHaveLength(1)
  expect(result.current.state.results?.units).toHaveLength(2)
})

it('invalidates the run when source or capability is replaced and on unmount', async () => {
  let finish!: (value: string) => void
  const translate = vi.fn<PdfTranslationExecutor['translate']>(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    ),
    executor = { targets, translate }
  const view = renderHook(({ current }) => usePdfTranslationJob(current, executor), {
    initialProps: { current: source }
  })
  act(() => view.result.current.start(options))
  view.rerender({ current: createPdfTranslationSource(source) })
  expect(view.result.current.state.status).toBe('idle')
  expect(translate.mock.calls[0][0].signal.aborted).toBe(true)
  await act(async () => finish('late'))
  expect(view.result.current.state.results).toBeUndefined()
  act(() => view.result.current.start(options))
  view.unmount()
  expect(translate.mock.calls[1][0].signal.aborted).toBe(true)
})

it('aborts and clears retained results when the execution capability changes', async () => {
  let finish!: (value: string) => void
  const oldTranslate = vi.fn<PdfTranslationExecutor['translate']>(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const oldExecutor: PdfTranslationExecutor = { targets, translate: oldTranslate }
  const newExecutor: PdfTranslationExecutor = { targets, translate: vi.fn(async () => '新译文') }
  const view = renderHook(({ executor }) => usePdfTranslationJob(source, executor), {
    initialProps: { executor: oldExecutor }
  })
  act(() => view.result.current.start(options))
  view.rerender({ executor: newExecutor })
  expect(oldTranslate.mock.calls[0][0].signal.aborted).toBe(true)
  expect(view.result.current.state.status).toBe('idle')
  await act(async () => finish('旧译文'))
  expect(view.result.current.state.results).toBeUndefined()
  act(() => view.result.current.start(options))
  await waitFor(() => expect(view.result.current.state.status).toBe('completed'))
  expect(view.result.current.state.results?.units.map((unit) => unit.translation)).toEqual([
    '新译文',
    '新译文'
  ])
})

it('allows retry during old operation cleanup while retaining the pinned options identity', async () => {
  let finishClose!: () => void
  const end = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        })
    )
    .mockResolvedValue(undefined)
  const begin = vi.fn().mockResolvedValue(undefined)
  const translate = vi
    .fn()
    .mockResolvedValueOnce('甲')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce('乙')
  const executor = { targets, begin, translate, end }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  const pinned = result.current.state.options
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(begin.mock.calls[1][1]).toBe(pinned)
  expect(result.current.state.done).toBe(2)
  await act(async () => finishClose())
  expect(result.current.state.status).toBe('completed')
})

it.each([
  [new PdfTranslationError('timeout', 'deadline'), 'timeout'],
  [
    new Error('Error invoking remote method: [pdf-translation:model-changed] changed'),
    'model-changed'
  ],
  [new Error('provider error including api_key=private-credential'), 'unknown']
] as const)(
  'retains model identity and exposes only the classified failure: %s',
  async (error, failure) => {
    const model = { frameworkId: 'claude-code', modelId: 'chosen-model' }
    const executor = {
      targets,
      begin: vi.fn(async () => ({ model })),
      translate: vi.fn().mockResolvedValueOnce('甲').mockRejectedValueOnce(error)
    }
    const { result } = renderHook(() => usePdfTranslationJob(source, executor))
    act(() => result.current.start(options))
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(result.current.state).toMatchObject({ done: 1, model, failure })
    expect(JSON.stringify(result.current.state)).not.toContain('private-credential')
    executor.translate.mockResolvedValueOnce('乙')
    act(() => result.current.start(options))
    await waitFor(() => expect(result.current.state.status).toBe('completed'))
    expect(result.current.state.failure).toBeUndefined()
    expect(executor.translate.mock.calls.map(([request]) => request.source)).toEqual([
      'a',
      'b',
      'b'
    ])
  }
)

it.each([undefined, 'api'] as const)(
  'restores a saved %s prefix using fresh coordinates without automatic inference',
  async (mode) => {
    const checkpoint = {
      version: 1 as const,
      key: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      attachmentVersionId: 'v',
      checksum: 'a'.repeat(64),
      fingerprint: source.fingerprint,
      language: 'Chinese',
      glossary: [],
      targetKey: 'b'.repeat(64),
      model: { frameworkId: mode === 'api' ? 'direct-api' : 'opencode', ...(mode ? { mode } : {}) },
      sources: ['a', 'b'],
      translatedSourceIndices: [0],
      translations: ['甲']
    }
    const translate = vi.fn(async () => '乙')
    expect(
      restorePdfTranslationJob(source, { ...checkpoint, fingerprint: 'changed' })
    ).toBeUndefined()
    expect(
      restorePdfTranslationJob(source, { ...checkpoint, sources: ['changed', 'different'] })
    ).toBeUndefined()
    const executor = {
      targets: [{ id: mode ?? 'agent', label: 'Model', mode: mode ?? ('agent' as const) }],
      translate
    }
    const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
    expect(result.current.state.status).toBe('cancelled')
    expect(result.current.state.options?.targetId).toBe(mode ?? 'agent')
    expect(result.current.state.results?.source).toBe(source)
    expect(result.current.state.results?.units[0].id).toBe('a')
    expect(translate).not.toHaveBeenCalled()
    act(() => result.current.start(result.current.state.options!))
    await waitFor(() => expect(result.current.state.status).toBe('completed'))
    expect(translate).toHaveBeenCalledTimes(1)
    expect(translate.mock.calls[0]).toMatchObject([{ source: 'b' }])
    act(() => result.current.reset())
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.results).toBeUndefined()
  }
)

it('starts a confirmed replacement atomically and does not reuse results or duplicate requests', async () => {
  const translate = vi.fn(async ({ language, source }) => `${language}: ${source}`)
  const begin = vi.fn(async () => ({ model: { frameworkId: 'test', modelId: 'current' } }))
  const executor = { targets, translate, begin }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  const previous = result.current.state
  act(() => result.current.restart({ ...options, targetId: 'missing' }))
  expect(result.current.state).toBe(previous)
  const replacement = { ...options, language: 'Japanese' }
  act(() => {
    result.current.restart(replacement)
    result.current.restart(replacement)
  })
  expect(result.current.state.status).toBe('running')
  expect(result.current.state.done).toBe(0)
  expect(result.current.state.results).toBeUndefined()
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(begin).toHaveBeenCalledTimes(2)
  expect(translate).toHaveBeenCalledTimes(4)
  expect(result.current.state.options).toEqual(replacement)
  expect(result.current.state.results?.units.map((unit) => unit.translation)).toEqual([
    'Japanese: a',
    'Japanese: b'
  ])
})

it('restores exact matches after extraction changes and translates only missing units', async () => {
  const checkpoint = {
    version: 1 as const,
    key: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    attachmentVersionId: 'v',
    checksum: 'a'.repeat(64),
    fingerprint: source.fingerprint,
    language: 'Chinese',
    glossary: [],
    targetKey: 'b'.repeat(64),
    model: { frameworkId: 'direct-api', mode: 'api' as const },
    sources: ['b', 'changed old paragraph'],
    translatedSourceIndices: [0],
    translations: ['乙']
  }
  const translate = vi.fn(async () => '甲')
  const executor = {
    targets: [{ id: 'api', label: 'Direct API', mode: 'api' as const }],
    translate
  }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
  expect(result.current.state).toMatchObject({
    status: 'cancelled',
    done: 1,
    total: 2,
    options: { language: 'Chinese' }
  })
  expect(result.current.state.results?.units).toMatchObject([{ id: 'b', translation: '乙' }])
  expect(translate).not.toHaveBeenCalled()
  act(() => result.current.start(result.current.state.options!))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(translate.mock.calls).toMatchObject([[{ sourceIndex: 0, source: 'a' }]])
  expect(result.current.state.done).toBe(2)
})

it.each(['reacquired-resource', 'source', 'executor'] as const)(
  'restores the saved checkpoint when %s changes without accepting late results',
  async (change) => {
    const checkpoint = {
      version: 1 as const,
      key: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      attachmentVersionId: 'v',
      checksum: 'a'.repeat(64),
      fingerprint: source.fingerprint,
      language: 'Chinese',
      glossary: [],
      targetKey: 'b'.repeat(64),
      model: { frameworkId: 'opencode' },
      sources: ['a', 'b'],
      translatedSourceIndices: [0],
      translations: ['甲']
    }
    let finish!: (value: string) => void
    const translate = vi.fn<PdfTranslationExecutor['translate']>(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const executor = {
      targets: [{ id: 'agent', label: 'Agent', mode: 'agent' as const }],
      translate
    }
    const { result, rerender } = renderHook(
      ({ currentSource, currentExecutor }) =>
        usePdfTranslationJob(currentSource, currentExecutor, checkpoint),
      {
        initialProps: {
          currentSource: source as typeof source | undefined,
          currentExecutor: executor
        }
      }
    )
    expect(result.current.state.done).toBe(1)
    expect(translate).not.toHaveBeenCalled()
    act(() => result.current.start(result.current.state.options!))
    expect(translate).toHaveBeenCalledTimes(1)
    if (change === 'reacquired-resource')
      rerender({ currentSource: undefined, currentExecutor: executor })
    const nextSource =
      change === 'executor'
        ? source
        : createPdfTranslationSource({ ...source, resourceRequestKey: 'r:2' })
    const nextProps = {
      currentSource: nextSource,
      currentExecutor: change === 'executor' ? { ...executor } : executor
    }
    rerender(nextProps)
    expect(translate.mock.calls[0][0].signal.aborted).toBe(true)
    expect(result.current.state.status).toBe('cancelled')
    expect(result.current.state.done).toBe(1)
    expect(result.current.state.options?.language).toBe('Chinese')
    expect(result.current.state.results?.source).toBe(nextSource)
    await act(async () => finish('late'))
    expect(result.current.state.done).toBe(1)
    expect(translate).toHaveBeenCalledTimes(1)
    act(() => result.current.reset())
    rerender(nextProps)
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.results).toBeUndefined()
  }
)

// Exercise both late success and late failure against a newer completed run.
it.each(
  readPdfTranslationCases<{
    name: string
    phase: 'admission' | 'paragraph'
    outcome: 'resolve' | 'reject'
    replacement: 'resume' | 'new-translation'
  }>('cancelled-job-late-settlement.jsonl')
)('$name', async ({ phase, outcome, replacement }) => {
  let resolveOld!: (value: never) => void
  let rejectOld!: (reason: Error) => void
  const pending = new Promise<never>((resolve, reject) => {
    resolveOld = resolve
    rejectOld = reject
  })
  const begin = vi
    .fn<NonNullable<PdfTranslationExecutor['begin']>>()
    .mockResolvedValue({ model: { frameworkId: 'test', modelId: 'current' } })
  if (phase === 'admission') begin.mockImplementationOnce(() => pending)
  const translate = vi.fn<PdfTranslationExecutor['translate']>(
    async ({ source, language }) => `${language}:${source}`
  )
  if (phase === 'paragraph')
    translate.mockResolvedValueOnce('accepted:a').mockImplementationOnce(() => pending)
  const end = vi.fn(async (_signal: AbortSignal) => {
    void _signal
  })
  const executor: PdfTranslationExecutor = { targets, begin, translate, end }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() =>
    expect(phase === 'paragraph' ? translate.mock.calls.length : begin.mock.calls.length).toBe(
      phase === 'paragraph' ? 2 : 1
    )
  )
  const oldSignal = begin.mock.calls[0][2]
  act(() => result.current.cancel())
  expect(oldSignal.aborted).toBe(true)
  expect(result.current.state.done).toBe(phase === 'paragraph' ? 1 : 0)
  const nextOptions = replacement === 'resume' ? options : { ...options, language: 'Japanese' }
  act(() =>
    replacement === 'resume'
      ? result.current.start(nextOptions)
      : result.current.restart(nextOptions)
  )
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  const completed = result.current.state
  const expected =
    replacement === 'resume' && phase === 'paragraph'
      ? ['accepted:a', 'Chinese:b']
      : [`${nextOptions.language}:a`, `${nextOptions.language}:b`]
  expect(completed.results?.units.map((unit) => unit.translation)).toEqual(expected)
  expect(completed.model).toEqual({ frameworkId: 'test', modelId: 'current' })
  await act(async () => {
    if (outcome === 'resolve')
      resolveOld(
        (phase === 'admission'
          ? { model: { frameworkId: 'test', modelId: 'obsolete' } }
          : 'obsolete text') as never
      )
    else rejectOld(new Error('synthetic obsolete provider failure'))
  })
  expect(result.current.state).toBe(completed)
  expect(begin).toHaveBeenCalledTimes(2)
  expect(end.mock.calls.map(([signal]) => signal)).toHaveLength(2)
  expect(end.mock.calls.filter(([signal]) => signal === oldSignal)).toHaveLength(1)
  expect(begin.mock.calls[1][2].aborted).toBe(false)
  expect(translate.mock.calls.map(([request]) => request.source)).toEqual(
    phase === 'admission'
      ? ['a', 'b']
      : replacement === 'resume'
        ? ['a', 'b', 'b']
        : ['a', 'b', 'a', 'b']
  )
})

it.each(
  readPdfTranslationCases<{
    name: string
    responses: Array<
      'empty' | 'success' | 'incomplete-output' | 'timeout' | 'model-changed' | 'unknown'
    >
    status: 'completed' | 'error'
    calls: number
    failure?: string
  }>('paragraph-retry-limits-and-failure-classes.jsonl')
)('$name', async ({ responses, status, calls, failure }) => {
  const translate = vi.fn<PdfTranslationExecutor['translate']>().mockResolvedValueOnce('甲')
  for (const response of responses) {
    if (response === 'success' || response === 'empty')
      translate.mockResolvedValueOnce(response === 'success' ? '乙' : ' ')
    else
      translate.mockRejectedValueOnce(
        response === 'unknown'
          ? new Error('synthetic provider diagnostic api_key=confidential')
          : new PdfTranslationError(response, 'synthetic provider failure')
      )
  }
  translate.mockResolvedValue('乙')
  const executor = { targets, translate },
    { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe(status))
  expect(translate).toHaveBeenCalledTimes(1 + calls)
  expect(result.current.state.failure).toBe(failure)
  expect(JSON.stringify(result.current.state)).not.toContain('confidential')
  const skipped = status === 'completed' && responses.at(-1) !== 'success'
  expect(result.current.state.done).toBe(status === 'completed' && !skipped ? 2 : 1)
  if (skipped) {
    expect(result.current.state.results?.failedUnitIds).toEqual(['b'])
    act(() => result.current.retryUnit('b'))
    await waitFor(() => expect(result.current.state.done).toBe(2))
  }
  if (status === 'error') {
    act(() => result.current.start({ ...options, language: 'Japanese' }))
    expect(translate).toHaveBeenCalledTimes(1 + calls)
    act(() => result.current.start(options))
    await waitFor(() => expect(result.current.state.status).toBe('completed'))
    expect(translate).toHaveBeenCalledTimes(2 + calls)
  }
  expect(result.current.state.results?.units.map((unit) => unit.translation)).toEqual(['甲', '乙'])
  expect(
    translate.mock.calls
      .slice(1)
      .every(([request]) => request.sourceIndex === 1 && request.source === 'b')
  ).toBe(true)
})

it('keeps partial progress and exposes provider details without automatic overload retries', async () => {
  const executor = {
    targets,
    translate: vi
      .fn()
      .mockResolvedValueOnce('甲')
      .mockRejectedValueOnce(
        new Error(
          'Error invoking remote method: HTTP 529: overloaded [provider-failure:unavailable:529]'
        )
      )
  }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  expect(result.current.state).toMatchObject({
    done: 1,
    providerFailure: { kind: 'unavailable', status: 529 }
  })
  expect(result.current.state.errorDetails).toContain('overloaded')
  expect(executor.translate).toHaveBeenCalledTimes(2)
  executor.translate.mockResolvedValueOnce('乙')
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(result.current.state.providerFailure).toBeUndefined()
  expect(result.current.state.errorDetails).toBeUndefined()
  expect(executor.translate.mock.calls.map(([request]) => request.source)).toEqual(['a', 'b', 'b'])
})

it('retranslates only the chosen saved paragraph and retains it after a failed attempt', async () => {
  const translate = vi.fn().mockResolvedValueOnce('甲').mockResolvedValueOnce('乙')
  const executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  const previous = result.current.state.results
  translate.mockRejectedValueOnce(new Error('offline'))
  act(() => result.current.retryUnit('a'))
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  expect(result.current.state.results).toBe(previous)
  expect(result.current.state.retryUnitId).toBe('a')
  translate.mockResolvedValueOnce('新甲')
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(translate.mock.calls.map(([request]) => request.source)).toEqual(['a', 'b', 'a', 'a'])
  expect(translate.mock.calls[3][0]).toMatchObject({ sourceIndex: 0, replaceExisting: true })
  expect(result.current.state.results?.units.map((unit) => unit.translation)).toEqual([
    '新甲',
    '乙'
  ])
  expect(previous?.units.map((unit) => unit.translation)).toEqual(['甲', '乙'])
  expect(result.current.state.done).toBe(2)
  expect(result.current.state.retryUnitId).toBeUndefined()
  act(() => result.current.retryUnit('unknown'))
  expect(translate).toHaveBeenCalledTimes(4)
})

it('continues past a rejected block, keeps its original, and repairs only that block', async () => {
  let reject = true
  const translate = vi.fn<PdfTranslationExecutor['translate']>(async ({ source }) => {
    if (source === 'a' && reject) throw new PdfTranslationError('incomplete-output', 'invalid')
    return source === 'a' ? '甲' : '乙'
  })
  const executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(translate.mock.calls.map(([r]) => r.source)).toEqual(['a', 'a', 'b'])
  expect(result.current.state).toMatchObject({
    done: 1,
    total: 2,
    results: { failedUnitIds: ['a'], units: [{ id: 'b', translation: '乙' }] }
  })
  act(() => result.current.retryUnit('a'))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(result.current.state.results?.failedUnitIds).toEqual(['a'])
  reject = false
  act(() => result.current.retryUnit('a'))
  await waitFor(() => expect(result.current.state.done).toBe(2))
  expect(result.current.state.results?.failedUnitIds).toEqual([])
  expect(translate.mock.calls.at(-1)?.[0].replaceExisting).toBeUndefined()
  expect(translate.mock.calls.filter(([r]) => r.source === 'b')).toHaveLength(1)
})
it('restores skipped blocks without treating their originals as accepted translations', () => {
  const restored = restorePdfTranslationJob(source, {
    version: 1,
    key: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    attachmentVersionId: 'v',
    checksum: 'a'.repeat(64),
    fingerprint: 'f',
    language: 'Chinese',
    glossary: [],
    targetKey: 'b'.repeat(64),
    model: { frameworkId: 'opencode' },
    sources: ['a', 'b'],
    translations: ['乙'],
    translatedSourceIndices: [1],
    failedSourceIndices: [0]
  })
  expect(restored).toMatchObject({
    status: 'completed',
    done: 1,
    total: 2,
    results: { failedUnitIds: ['a'], units: [{ id: 'b', translation: '乙' }] }
  })
})

it.each([1, 2, 4] as const)(
  'limits independent calls to %ix, sorts results and skips failed units',
  async (concurrency) => {
    const manySource = createPdfTranslationSource({
      ...source,
      units: Array.from({ length: 8 }, (_, index) => ({
        ...source.units[0],
        id: `unit-${index}`,
        source: `Cell ${index}`
      }))
    })
    let running = 0
    let maximum = 0
    const releases = new Map<number, () => void>()
    const translate = vi.fn(async ({ sourceIndex }: { sourceIndex: number }) => {
      if (sourceIndex === 2)
        throw new PdfTranslationError('incomplete-output', 'Numeric values missing')
      running++
      maximum = Math.max(maximum, running)
      await new Promise<void>((resolve) => releases.set(sourceIndex, resolve))
      releases.delete(sourceIndex)
      running--
      return `译${sourceIndex}`
    })
    const executor = { targets, translate }
    const { result } = renderHook(() => usePdfTranslationJob(manySource, executor))
    act(() => result.current.start({ ...options, concurrency }))
    await waitFor(() => expect(maximum).toBe(concurrency))
    // Resolve backwards so the completion order differs from document order.
    while (result.current.state.status === 'running') {
      await act(async () => {
        const index = Math.max(...releases.keys())
        releases.get(index)?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const completed = result.current.state.results?.units ?? []
      expect(completed.map((unit) => unit.id)).toEqual(
        manySource.units
          .filter((unit) => completed.some((done) => done.id === unit.id))
          .map((unit) => unit.id)
      )
      for (const unit of completed) {
        const index = manySource.units.findIndex((sourceUnit) => sourceUnit.id === unit.id)
        expect(unit.translationSource).toBe(`Cell ${index}`)
        expect(unit.translation).toBe(`译${index}`)
      }
    }
    expect(result.current.state.status).toBe('completed')
    expect(result.current.state.done).toBe(7)
    expect(maximum).toBe(concurrency)
    expect(result.current.state.results?.failedUnitIds).toEqual(['unit-2'])
    expect(result.current.state.results?.units.map((unit) => unit.id)).toEqual(
      [0, 1, 3, 4, 5, 6, 7].map((index) => `unit-${index}`)
    )
    expect(translate.mock.calls.filter(([request]) => request.sourceIndex === 2)).toHaveLength(2)
  }
)

it('cancels every parallel lane and never admits another paragraph', async () => {
  const manySource = createPdfTranslationSource({
    ...source,
    units: Array.from({ length: 8 }, (_, index) => ({
      ...source.units[0],
      id: `unit-${index}`,
      source: `Cell ${index}`
    }))
  })
  const signals: AbortSignal[] = []
  const translate = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    signals.push(signal)
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
    return '译'
  })
  const end = vi.fn(async () => {})
  const executor = { targets, translate, end }
  const { result } = renderHook(() => usePdfTranslationJob(manySource, executor))
  act(() => result.current.start({ ...options, concurrency: 4 }))
  await waitFor(() => expect(translate).toHaveBeenCalledTimes(4))
  act(() => result.current.cancel())
  await waitFor(() => expect(end).toHaveBeenCalledTimes(1))
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(translate).toHaveBeenCalledTimes(4)
  expect(result.current.state.status).toBe('cancelled')
})

it('reports the timed-out lane instead of a sibling abort error', async () => {
  const rejectors: ((error: Error) => void)[] = []
  const translate = vi.fn(
    async ({ sourceIndex }: { sourceIndex: number }) =>
      new Promise<string>((_resolve, reject) => {
        rejectors[sourceIndex] = reject
      })
  )
  const executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start({ ...options, concurrency: 2 }))
  await waitFor(() => expect(translate).toHaveBeenCalledTimes(2))
  await act(async () => {
    rejectors[0](new PdfTranslationError('cancelled', 'PDF translation was cancelled.'))
    rejectors[1](new PdfTranslationError('timeout', 'Translation timed out.'))
  })
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  expect(result.current.state.failure).toBe('timeout')
})

it('treats a cancellation returned by the main process as cancelled', async () => {
  const translate = vi
    .fn<PdfTranslationExecutor['translate']>()
    .mockRejectedValue(new PdfTranslationError('cancelled', 'PDF translation was cancelled.'))
  const executor = { targets, translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('cancelled'))
  expect(result.current.state.failure).toBeUndefined()
})

it('ends sibling requests immediately after a fatal provider error', async () => {
  let rejectFatal!: (error: Error) => void
  let siblingSignal!: AbortSignal
  const translate = vi.fn(
    async ({ sourceIndex, signal }: { sourceIndex: number; signal: AbortSignal }) => {
      if (sourceIndex === 0)
        return new Promise<string>((_resolve, reject) => {
          rejectFatal = reject
        })
      siblingSignal = signal
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    }
  )
  const end = vi.fn(async () => {})
  const executor = { targets, translate, end }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start({ ...options, concurrency: 2 }))
  await waitFor(() => expect(translate).toHaveBeenCalledTimes(2))
  await act(async () =>
    rejectFatal(new Error('[provider-failure:authentication:0] Invalid credentials'))
  )
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  expect(siblingSignal.aborted).toBe(true)
  expect(result.current.state.providerFailure?.kind).toBe('authentication')
  expect(end).toHaveBeenCalledTimes(1)
})

it('opens a fresh operation, saves the skipped block, and resumes in document order', async () => {
  const document = createPdfTranslationSource({
    ...source,
    units: ['a', 'b', 'c'].map((id) => ({
      id,
      source: id,
      fragments: []
    }))
  })
  const begin = vi.fn<NonNullable<PdfTranslationExecutor['begin']>>(async () => {}),
    end = vi.fn(async () => {})
  const events: string[] = []
  const translate = vi.fn<PdfTranslationExecutor['translate']>(async ({ source }) => {
    events.push(source)
    if (source === 'b') throw new PdfTranslationError('timeout', 'deadline')
    return `译${source}`
  })
  const skip = vi.fn<NonNullable<PdfTranslationExecutor['skip']>>(async ({ source, signal }) => {
    expect(signal).toBe(begin.mock.calls.at(-1)![2])
    expect(signal.aborted).toBe(false)
    events.push(`skip:${source}`)
  })
  const executor: PdfTranslationExecutor = { targets, begin, end, translate, skip }
  const { result } = renderHook(() => usePdfTranslationJob(document, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  expect(result.current.state).toMatchObject({ done: 1, failedUnitId: 'b' })
  act(() => result.current.skipUnit('a'))
  expect(skip).not.toHaveBeenCalled()
  act(() => result.current.skipUnit('b'))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(begin).toHaveBeenCalledTimes(2)
  expect(end).toHaveBeenCalledTimes(2)
  expect(begin.mock.calls[0][2]).not.toBe(begin.mock.calls[1][2])
  expect(events).toEqual(['a', 'b', 'skip:b', 'c'])
  expect(result.current.state.results?.units.map(({ id }) => id)).toEqual(['a', 'c'])
  expect(result.current.state.results?.failedUnitIds).toEqual(['b'])
  translate.mockResolvedValue('译b')
  act(() => result.current.retryUnit('b'))
  await waitFor(() => expect(result.current.state.done).toBe(3))
  expect(result.current.state.results?.units.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
  expect(result.current.state.results?.failedUnitIds).toEqual([])
})

it('does not advance when saving a skip fails', async () => {
  const translate = vi
    .fn<PdfTranslationExecutor['translate']>()
    .mockRejectedValue(new PdfTranslationError('timeout', 'deadline'))
  const skip = vi.fn().mockRejectedValue(new PdfTranslationError('checkpoint-failed', 'storage'))
  const executor = { targets, translate, skip }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.failedUnitId).toBe('a'))
  act(() => result.current.skipUnit('a'))
  await waitFor(() => expect(result.current.state.failure).toBe('checkpoint-failed'))
  expect(translate).toHaveBeenCalledTimes(1)
  expect(result.current.state.failedUnitId).toBeUndefined()
  expect(result.current.state.results?.failedUnitIds).toBeUndefined()
})

it('ignores a late skip result after cancellation', async () => {
  const translate = vi
    .fn<PdfTranslationExecutor['translate']>()
    .mockRejectedValue(new PdfTranslationError('timeout', 'deadline'))
  let finish!: () => void
  const skip = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const executor = { targets, translate, skip }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(result.current.state.failedUnitId).toBe('a'))
  act(() => result.current.skipUnit('a'))
  await waitFor(() => expect(skip).toHaveBeenCalledTimes(1))
  act(() => result.current.cancel())
  await act(async () => finish())
  expect(result.current.state.status).toBe('cancelled')
  expect(translate).toHaveBeenCalledTimes(1)
  expect(result.current.state.results?.failedUnitIds).toBeUndefined()
})

it('restores failure reasons and cumulative attempts, then clears only the repaired paragraph', async () => {
  const diagnostic = {
    reasonCode: 'missing-numeric-literals' as const,
    pageNumbers: [1],
    attempts: 4
  }
  const checkpoint = {
    version: 1 as const,
    key: '11111111-1111-4111-8111-111111111111',
    revision: 4,
    attachmentVersionId: 'v',
    checksum: 'a'.repeat(64),
    fingerprint: 'f',
    language: 'Chinese',
    glossary: [],
    targetKey: 'b'.repeat(64),
    model: { frameworkId: 'opencode' },
    sources: ['a', 'b'],
    translations: ['乙'],
    translatedSourceIndices: [1],
    failedSourceIndices: [0],
    failures: [{ sourceIndex: 0, ...diagnostic }]
  }
  const translate = vi
    .fn<PdfTranslationExecutor['translate']>()
    .mockRejectedValueOnce(
      new PdfTranslationError('incomplete-output', 'rejected', { ...diagnostic, attempts: 5 })
    )
    .mockRejectedValueOnce(
      new PdfTranslationError('incomplete-output', 'rejected', {
        ...diagnostic,
        disposition: 'skipped',
        attempts: 6
      })
    )
    .mockResolvedValue('甲')
  const executor = { targets: [{ id: 'agent', label: 'Agent', mode: 'agent' as const }], translate }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(result.current.state.results?.failures).toEqual({ a: diagnostic })
  act(() => result.current.retryUnit('a'))
  await waitFor(() => expect(translate).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(result.current.state.results?.failures?.a).toEqual({
    ...diagnostic,
    disposition: 'skipped',
    attempts: 6
  })
  act(() => result.current.retryUnit('a'))
  await waitFor(() => expect(result.current.state.done).toBe(2))
  expect(result.current.state.results?.failures).toBeUndefined()
  expect(result.current.state.results?.failedUnitIds).toEqual([])
  expect(result.current.state.results?.units.map((unit) => unit.id)).toEqual(['a', 'b'])
  expect(translate.mock.calls.every(([request]) => request.source === 'a')).toBe(true)
})

it('restores layout diagnostics by translatable source order and clears only a retranslated passage', async () => {
  const failure = {
    code: 'overflow' as const,
    phase: 'planning' as const,
    pageNumbers: [1],
    fragmentCount: 1
  }
  const checkpoint = {
    version: 1 as const,
    key: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    attachmentVersionId: 'v',
    checksum: 'a'.repeat(64),
    fingerprint: 'f',
    language: 'Chinese',
    glossary: [],
    targetKey: 'b'.repeat(64),
    model: { frameworkId: 'opencode' },
    sources: ['a', 'b'],
    translatedSourceIndices: [0, 1],
    translations: ['甲', '乙'],
    layoutReports: [0, 1].map((sourceIndex) => ({
      sourceIndex,
      sourceHash: 'a'.repeat(64),
      translationHash: 'b'.repeat(64),
      generatedAt: 1,
      failure
    }))
  }
  const executor = {
    targets: [{ id: 'agent', label: 'Agent', mode: 'agent' as const }],
    translate: vi.fn(async () => '丙')
  }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
  expect(result.current.state.results?.layoutFailures).toEqual({ a: failure, b: failure })
  expect(result.current.state.results?.checkpoint).toEqual({ key: checkpoint.key, source: 'v' })
  act(() => result.current.retryUnit('b'))
  await waitFor(() => expect(result.current.state.results?.units[1].translation).toBe('丙'))
  expect(result.current.state.results?.layoutFailures).toEqual({ a: failure })
})

it('drains disjoint bounded batches in parallel and keeps presentation in source order', async () => {
  const manySource = createPdfTranslationSource({
    ...source,
    units: Array.from({ length: 12 }, (_, index) => ({
      ...source.units[0],
      id: `unit-${index}`,
      source: `Cell ${index}`
    }))
  })
  const releases = new Map<number, () => void>()
  const translate = vi.fn(async ({ sourceIndex }: { sourceIndex: number }) => {
    if (sourceIndex % 4 === 0)
      await new Promise<void>((resolve) => releases.set(sourceIndex, resolve))
    return `译${sourceIndex}`
  })
  const executor = { targets, translate, batchShortSources: true }
  const { result } = renderHook(() => usePdfTranslationJob(manySource, executor))
  act(() => result.current.start({ ...options, concurrency: 2 }))
  await waitFor(() => expect([...releases.keys()]).toEqual([0, 4]))
  await act(async () => releases.get(4)!())
  await waitFor(() => expect(releases.has(8)).toBe(true))
  expect(translate.mock.calls.map(([request]) => request.sourceIndex)).toEqual([0, 4, 5, 6, 7, 8])
  await act(async () => releases.get(8)!())
  await act(async () => releases.get(0)!())
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(result.current.state.results?.units.map(({ id }) => id)).toEqual(
    manySource.units.map(({ id }) => id)
  )
  expect(translate).toHaveBeenCalledTimes(12)
})

it('restores a local checkpoint without switching to Agent and resumes only unfinished paragraphs', async () => {
  const checkpoint = {
    version: 1 as const,
    key: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    attachmentVersionId: 'version',
    checksum: 'a'.repeat(64),
    fingerprint: source.fingerprint,
    language: 'Chinese',
    glossary: [],
    targetKey: 'b'.repeat(64),
    model: { frameworkId: 'local-onnx', modelId: 'qwen3-0.6b-q8', mode: 'local' as const },
    concurrency: 1 as const,
    sources: ['a', 'b'],
    translatedSourceIndices: [0],
    translations: ['甲']
  }
  const translate = vi.fn(async () => '乙')
  const executor = {
    targets: [{ id: 'local', label: 'Local model', mode: 'local' as const }],
    batchShortSources: true,
    translate
  }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
  expect(result.current.state.options?.targetId).toBe('local')
  expect(result.current.state.options).not.toHaveProperty('agentModel')
  act(() => result.current.start(result.current.state.options!))
  await waitFor(() => expect(result.current.state.status).toBe('completed'))
  expect(translate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: 'b' }))
})

it.each([
  { reasonCode: 'provider-failed', disposition: undefined },
  { reasonCode: 'timeout', disposition: undefined },
  { reasonCode: 'provider-failed', disposition: 'retryable' },
  { reasonCode: 'incomplete-output', disposition: 'retryable' },
  { reasonCode: 'provider-failed', disposition: 'skipped' }
] as const)(
  'restores $reasonCode/$disposition with the correct remaining work',
  async (failure) => {
    const checkpoint = {
      version: 1 as const,
      key: '11111111-1111-4111-8111-111111111111',
      revision: 2,
      attachmentVersionId: 'v',
      checksum: 'a'.repeat(64),
      fingerprint: source.fingerprint,
      language: 'Chinese',
      glossary: [],
      targetKey: 'b'.repeat(64),
      model: { frameworkId: 'opencode', mode: 'agent' as const },
      sources: ['a', 'b'],
      translations: ['甲'],
      translatedSourceIndices: [0],
      failedSourceIndices: [1],
      failures: [{ ...failure, sourceIndex: 1, pageNumbers: [1], attempts: 2 }]
    }
    const translate = vi.fn(async () => '乙')
    const executor = {
      targets: [{ id: 'agent', label: 'Model', mode: 'agent' as const }],
      translate
    }
    const { result } = renderHook(() => usePdfTranslationJob(source, executor, checkpoint))
    expect(result.current.state.status).toBe(
      failure.disposition === 'skipped' ? 'completed' : 'error'
    )
    expect(result.current.state.done).toBe(1)
    act(() => result.current.start(result.current.state.options!))
    await waitFor(() => expect(result.current.state.status).toBe('completed'))
    expect(translate.mock.calls).toHaveLength(failure.disposition === 'skipped' ? 0 : 1)
    if (failure.disposition !== 'skipped') {
      expect(translate.mock.calls[0]).toMatchObject([{ sourceIndex: 1, source: 'b' }])
      expect(result.current.state.results?.units.map((unit) => unit.translation)).toEqual([
        '甲',
        '乙'
      ])
      expect(result.current.state.results?.failures).toBeUndefined()
    }
  }
)

it('requires the exhausted-output skip to persist before declaring completion', async () => {
  const translate = vi.fn().mockResolvedValueOnce('甲').mockResolvedValue(' ')
  let rejectSkip!: (reason: Error) => void
  const skip = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSkip = reject
      })
  )
  const executor = { targets, translate, skip }
  const { result } = renderHook(() => usePdfTranslationJob(source, executor))
  act(() => result.current.start(options))
  await waitFor(() => expect(skip).toHaveBeenCalledOnce())
  expect(result.current.state.status).toBe('running')
  await act(async () => rejectSkip(new PdfTranslationError('checkpoint-failed', 'Write failed')))
  expect(result.current.state.status).toBe('error')
  expect(result.current.state.done).toBe(1)
  expect(result.current.state.results?.failedUnitIds).toEqual([])
})

it('restores another edition on the same prepared source without retaining previous results or options', () => {
  const checkpoint = {
    version: 1 as const,
    key: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    attachmentVersionId: 'v',
    checksum: 'a'.repeat(64),
    fingerprint: source.fingerprint,
    language: 'Chinese',
    glossary: [{ source: 'saved glossary', target: 'saved glossary' }],
    targetKey: 'b'.repeat(64),
    model: { frameworkId: 'opencode', modelId: 'historic-model' },
    sources: ['a', 'b'],
    translatedSourceIndices: [0],
    translations: ['甲']
  }
  const executor = { targets, translate: vi.fn() }
  const { result, rerender } = renderHook(
    ({ saved }) => usePdfTranslationJob(source, executor, saved),
    { initialProps: { saved: checkpoint } }
  )
  expect(result.current.state.results?.units[0].translation).toBe('甲')
  rerender({
    saved: {
      ...checkpoint,
      key: '22222222-2222-4222-8222-222222222222',
      language: 'Japanese',
      translations: ['日本語'],
      model: { frameworkId: 'opencode', modelId: 'another-model' }
    }
  })
  expect(result.current.state.results?.units[0].translation).toBe('日本語')
  expect(result.current.state.options?.language).toBe('Japanese')
  expect(result.current.state.model?.modelId).toBe('another-model')
  expect(executor.translate).not.toHaveBeenCalled()
})
