/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it, vi } from 'vitest'
import { PdfTranslationOwner } from '../src/index.js'
import type { PdfTranslationRunRequest } from '../src/public-contracts.js'
import { PdfTranslationCheckpoints, PdfTranslationUsageRecorder } from '../src/public-storage.js'
import { pdfTranslationSourceIndices } from '../src/text.js'
import { TestCallerRegistry } from './support/callers.js'
import { memoryCheckpoints } from './support/checkpoint-memory.js'
import { memoryUsage } from './support/usage-memory.js'
import { readPdfTranslationCases } from './fixtures/read-cases.js'
let memory: ReturnType<typeof memoryCheckpoints>
let usageMemory: ReturnType<typeof memoryUsage>
const checksum = 'a'.repeat(64)
const targetKey = 'b'.repeat(64)
const model = { frameworkId: 'opencode', modelId: 'test' }
const input = {
  resourceRequestKey: 'r',
  sourceId: 'v',
  fingerprint: 'fp',
  language: 'Chinese',
  glossary: [{ source: 'cell', target: '细胞' }],
  sources: ['cell', '12']
}
function reopen() {
  return new PdfTranslationCheckpoints({
    getClient: async () => memory.database,
    resolveSource: async (sourceId) => ({ sourceId, checksum })
  })
}
async function setup() {
  memory = memoryCheckpoints()
  usageMemory = memoryUsage()
  return reopen()
}
it.each(
  readPdfTranslationCases<{
    name: string
    sources: string[]
    translations: string[]
    current: string[]
    recovered: number[]
    pending: Array<[number, string]>
    expected: string[]
  }>('checkpoint-reflow-resume-and-reopen.jsonl')
)('$name', async ({ sources, translations, current, recovered, pending, expected }) => {
  const store = await setup()
  const signal = new AbortController().signal
  let saved = (await store.open({ ...input, sources }, targetKey, model))!
  for (const [index, text] of translations.entries())
    saved = await store.append(saved, index, text, signal)
  const changed = {
    ...input,
    sources: current,
    checkpoint: { key: saved.key, revision: saved.revision }
  }
  const restored = (await store.open(changed, targetKey, model))!
  expect(pdfTranslationSourceIndices(restored)).toEqual(recovered)
  expect(restored.translations).toEqual(recovered.map((index) => expected[index]))
  expect(await store.read('v')).toEqual(saved)
  let completed = restored
  for (const [index, text] of pending) {
    completed = await store.append(completed, index, text, signal)
    // Reopen a consumer after each write, including partial sparse progress.
    const reader = reopen()
    expect(await reader.read('v')).toEqual(completed)
    expect(await reader.open(changed, targetKey, model)).toEqual(completed)
  }
  expect(completed.translations).toEqual(expected)
  expect(pdfTranslationSourceIndices(completed)).toEqual(current.map((_, index) => index))
  await expect(store.append(restored, pending[0][0], '过期译文', signal)).rejects.toThrow(
    'another window'
  )
  expect(await store.read('v')).toEqual(completed)
})

it('never checkpoints a displaced numeric phrase and resumes only the validated translation', async () => {
  const checkpoints = await setup()
  const registry = new TestCallerRegistry()
  const caller = registry.acquire({ leaseId: 'numeric-retry-reader', surface: 'electron' })
  const source = 'Observe 2 points on 1 arm with an increase of 2 cm.'
  const requestInput = { ...input, sources: ['cell', source] }
  const run = vi
    .fn()
    .mockResolvedValueOnce({ text: '细胞', stopReason: 'end_turn' })
    .mockResolvedValueOnce({ text: '观察2个点，增加2 cm。', stopReason: 'end_turn' })
    .mockResolvedValueOnce({
      text: '手臂上的<q0>2个点</q0>增加<q2>2 cm</q2>。<q1>1</q1>',
      stopReason: 'end_turn'
    })
    .mockResolvedValueOnce({
      text: '观察<q1>1只手臂</q1>的<q0>2个点</q0>，增加<q2>2 cm</q2>。',
      stopReason: 'end_turn'
    })
  const options = {
    usage: new PdfTranslationUsageRecorder(async () => usageMemory.repository),
    checkpoints,
    captureTarget: async () => ({
      frameworkId: 'opencode' as const,
      providerId: 'p',
      model: { kind: 'required' as const, id: 'test' },
      reasoningEffort: 'default' as const
    }),
    runner: {
      run,
      supportsTarget: () => true,
      shutdown: async () => {},
      sweepStaleProfiles: async () => {}
    }
  }
  const owner = new PdfTranslationOwner(options)
  const admission = await owner.begin(requestInput, caller.lease)
  try {
    await owner.translate(
      { operationId: admission.operationId, sourceIndex: 0, source: 'cell' },
      caller.lease
    )
    const saved = await checkpoints.read('v')
    const request = { operationId: admission.operationId, sourceIndex: 1, source }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(owner.translate(request, caller.lease)).rejects.toThrow('incomplete-output')
      expect(await checkpoints.read('v')).toEqual({
        ...saved,
        revision: saved!.revision + attempt + 1,
        failedSourceIndices: [1],
        failures: [
          {
            sourceIndex: 1,
            disposition: 'retryable',
            reasonCode: 'missing-numeric-literals',
            pageNumbers: [],
            attempts: attempt + 1
          }
        ]
      })
    }
    const text = '观察1只手臂的2个点，增加2 cm。'
    await expect(owner.translate(request, caller.lease)).resolves.toBe(text)
    expect((await checkpoints.read('v'))?.translations).toEqual(['细胞', text])
    expect([...usageMemory.rows.values()].map((row) => row.status).sort()).toEqual([
      'completed',
      'completed',
      'failed',
      'failed'
    ])
    await owner.shutdown()
    options.checkpoints = reopen()
    const reopened = new PdfTranslationOwner(options)
    try {
      const resumed = await reopened.begin(
        {
          ...requestInput,
          checkpoint: admission.checkpoint,
          expectedTargetKey: admission.targetKey
        },
        caller.lease
      )
      await expect(
        reopened.translate({ ...request, operationId: resumed.operationId }, caller.lease)
      ).resolves.toBe(text)
      expect(run).toHaveBeenCalledTimes(4)
    } finally {
      await reopened.shutdown()
    }
  } finally {
    await owner.shutdown()
    caller.release()
    registry.dispose()
  }
})

it('reconciles layout changes without writing until resumed, persists sparse progress and rejects stale writes', async () => {
  const store = await setup(),
    signal = new AbortController().signal
  let old = (await store.open(input, targetKey, model))!
  old = await store.append(old, 0, '细胞', signal)
  old = await store.append(old, 1, '12', signal)
  const changed = {
    ...input,
    sources: ['new beginning', 'cell', 'new ending', '12'],
    checkpoint: { key: old.key, revision: old.revision }
  }
  const restored = (await store.open(changed, targetKey, model))!
  expect(restored).toMatchObject({
    version: 1,
    translatedSourceIndices: [1, 3],
    translations: ['细胞', '12']
  })
  expect(await store.read('v')).toEqual(old)
  await expect(store.append(restored, 2, '末尾', signal)).rejects.toThrow('prefix')
  const next = await store.append(restored, 0, '开头', signal)
  expect((await store.read('v'))?.translatedSourceIndices).toEqual([0, 1, 3])
  await expect(store.append(restored, 0, '过期', signal)).rejects.toThrow('another window')
  const resumed = (await store.open(changed, targetKey, model))!
  expect(resumed).toEqual(next)
  const completed = await store.append(resumed, 2, '末尾', signal)
  expect(completed.translations).toEqual(['开头', '细胞', '末尾', '12'])
  expect(completed.translatedSourceIndices).toEqual([0, 1, 2, 3])
  expect(await store.read('v')).toEqual(completed)
})

it('serves reconciled translations at their new positions and calls the model only for missing text', async () => {
  const checkpoints = await setup()
  const caller = new TestCallerRegistry().acquire({
    leaseId: 'reconcile',
    surface: 'electron'
  })
  const run = vi.fn(async () => ({
    text: '细胞',
    frameworkId: 'opencode' as const,
    model: 'test',
    stopReason: 'end_turn' as const
  }))
  const owner = new PdfTranslationOwner({
    usage: new PdfTranslationUsageRecorder(async () => usageMemory.repository),
    checkpoints,
    captureTarget: async () => ({
      frameworkId: 'opencode',
      providerId: 'p',
      model: { kind: 'required', id: 'test' },
      reasoningEffort: 'default'
    }),
    runner: {
      run,
      supportsTarget: () => true,
      shutdown: async () => {},
      sweepStaleProfiles: async () => {}
    }
  })
  const first = await owner.begin(input, caller.lease)
  await owner.translate(
    { operationId: first.operationId, sourceIndex: 0, source: 'cell' },
    caller.lease
  )
  await owner.translate(
    { operationId: first.operationId, sourceIndex: 1, source: '12' },
    caller.lease
  )
  owner.close(first.operationId, caller.lease)
  const saved = (await checkpoints.read('v'))!
  const changed = {
    ...input,
    sources: ['cell growth', 'cell', '12'],
    checkpoint: { key: saved.key, revision: saved.revision },
    expectedTargetKey: first.targetKey
  }
  const resumed = await owner.begin(changed, caller.lease)
  const previousCalls = run.mock.calls.length
  expect(
    await owner.translate(
      { operationId: resumed.operationId, sourceIndex: 1, source: 'cell' },
      caller.lease
    )
  ).toBe('细胞')
  expect(
    await owner.translate(
      { operationId: resumed.operationId, sourceIndex: 2, source: '12' },
      caller.lease
    )
  ).toBe('12')
  expect(run.mock.calls).toHaveLength(previousCalls)
  run.mockResolvedValueOnce({
    text: '细胞生长',
    frameworkId: 'opencode',
    model: 'test',
    stopReason: 'end_turn'
  })
  await owner.translate(
    { operationId: resumed.operationId, sourceIndex: 0, source: 'cell growth' },
    caller.lease
  )
  expect(run.mock.calls).toHaveLength(previousCalls + 1)
  const completed = (await checkpoints.read('v'))!
  expect(completed.translations).toEqual(['细胞生长', '细胞', '12'])
  expect(completed.translatedSourceIndices).toEqual([0, 1, 2])
  owner.close(resumed.operationId, caller.lease)
  const restarted = await owner.begin(changed, caller.lease)
  expect(
    await owner.translate(
      { operationId: restarted.operationId, sourceIndex: 2, source: '12' },
      caller.lease
    )
  ).toBe('12')
  expect(run.mock.calls).toHaveLength(previousCalls + 1)
  await owner.shutdown()
})

it('atomically replaces a saved paragraph without losing later translations', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  const first = await store.append((await store.open(input, targetKey, model))!, 0, '细胞', signal)
  await expect(store.append(first, 1, '12', signal, true)).rejects.toThrow()
  const complete = await store.append(first, 1, '12', signal)
  const replaced = await store.append(complete, 0, '细胞内容', signal, true)
  expect(replaced.translations).toEqual(['细胞内容', '12'])
  expect(replaced.revision).toBe(complete.revision + 1)
  await expect(store.append(complete, 0, '旧窗口覆盖', signal, true)).rejects.toThrow(
    'another window'
  )
  expect((await store.read('v'))?.translations).toEqual(['细胞内容', '12'])
})

it('saves concurrent out-of-order paragraphs with sequential CAS writes and restores their lanes', async () => {
  const checkpoints = await setup()
  const registry = new TestCallerRegistry()
  const caller = registry.acquire({ leaseId: 'parallel-save', surface: 'electron' })
  const sources = Array.from({ length: 5 }, (_, index) => `Cell increased ${index + 1}.`)
  const releases = new Map<number, (value: { text: string; stopReason: 'end_turn' }) => void>()
  const run = vi.fn(async ({ prompt }: { prompt: string }) => {
    const { sourceIndex } = JSON.parse(prompt)
    const answer = await new Promise<{ text: string; stopReason: 'end_turn' }>((resolve) =>
      releases.set(sourceIndex, resolve)
    )
    return { ...answer, frameworkId: 'opencode' as const, model: 'test' }
  })
  let writing = 0
  let maxWriting = 0
  const append = checkpoints.append.bind(checkpoints)
  vi.spyOn(checkpoints, 'append').mockImplementation(async (...args) => {
    writing++
    maxWriting = Math.max(maxWriting, writing)
    try {
      return await append(...args)
    } finally {
      writing--
    }
  })
  const owner = new PdfTranslationOwner({
    checkpoints,
    usage: { start: async () => async () => {}, recover: async () => {}, flush: async () => {} },
    captureTarget: async () => ({
      frameworkId: 'opencode',
      providerId: 'p',
      model: { kind: 'required', id: 'test' },
      reasoningEffort: 'default'
    }),
    runner: {
      run,
      supportsTarget: () => true,
      shutdown: async () => {},
      sweepStaleProfiles: async () => {}
    }
  })
  const { operationId } = await owner.begin(
    { ...input, sources, concurrency: 4, batchShortSources: false },
    caller.lease
  )
  const request = (sourceIndex: number): PdfTranslationRunRequest => ({
    operationId,
    sourceIndex,
    source: sources[sourceIndex]
  })
  const pending = sources
    .slice(0, 4)
    .map((_, index) => owner.translate(request(index), caller.lease))
  await vi.waitFor(() => expect(releases.size).toBe(4))
  await expect(owner.translate(request(0), caller.lease)).rejects.toThrow('already running')
  await expect(owner.translate(request(4), caller.lease)).rejects.toThrow('concurrency limit')
  for (const index of [3, 2, 1, 0])
    releases.get(index)!({ text: `细胞增加 ${index + 1}。`, stopReason: 'end_turn' })
  await Promise.all(pending)
  expect(run).toHaveBeenCalledTimes(4)
  expect(maxWriting).toBe(1)
  const saved = await checkpoints.read('v')
  expect(saved).toMatchObject({
    concurrency: 4,
    translatedSourceIndices: [0, 1, 2, 3],
    revision: 5
  })
  expect(saved?.translations).toEqual([
    '细胞增加 1。',
    '细胞增加 2。',
    '细胞增加 3。',
    '细胞增加 4。'
  ])
  owner.close(operationId, caller.lease)
  const resumed = await owner.begin(
    {
      ...input,
      sources,
      concurrency: 4,
      checkpoint: { key: saved!.key, revision: saved!.revision }
    },
    caller.lease
  )
  await expect(
    owner.translate({ ...request(3), operationId: resumed.operationId }, caller.lease)
  ).resolves.toBe('细胞增加 4。')
  expect(run).toHaveBeenCalledTimes(4)
  owner.close(resumed.operationId, caller.lease)
})
