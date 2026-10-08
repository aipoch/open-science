import { LiteratureCatalog } from '../catalog'
import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectRepository } from '../../projects/repository'
import { createProjectDbClient } from '../../projects/prisma-client'
import { migrateApplicationDatabase } from '../../database/migration-service'
import { beginMigration, endMigration, waitForDataRootWriters } from '../../storage/migration-state'
import { PdfTranslationCheckpoints } from './checkpoints'
import type { ResolvedLiteratureAttachmentVersion } from '../attachment-authority'
import { PdfTranslationOwner } from './index'
import { PdfTranslationUsageRecorder } from './usage'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { flushLogs, initLogger } from '../../logger'
import {
  nextPdfTranslationSourceIndex,
  pdfTranslationSourceIndices
} from '../../../shared/pdf-translation-recovery'
import {
  pdfTranslationCheckpointSchema,
  type PdfTranslationCheckpoint,
  type PdfTranslationRunRequest
} from '../../../shared/pdf-translation'

let root: string
let client: PrismaClient
async function selectedTranslationId(): Promise<string> {
  return (
    await client.pdfTranslation.findFirstOrThrow({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
  ).id
}
const checksum = 'a'.repeat(64)
const targetKey = 'b'.repeat(64)
const model = { frameworkId: 'opencode', modelId: 'test' }
const input = {
  resourceRequestKey: 'r',
  attachmentVersionId: 'v',
  fingerprint: 'fp',
  language: 'Chinese',
  glossary: [{ source: 'cell', target: '细胞' }],
  sources: ['cell', '12']
}
async function setup(): Promise<PdfTranslationCheckpoints> {
  root = await mkdtemp(join(tmpdir(), 'pdf-checkpoint-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.contentBlob.create({
    data: {
      id: 'blob',
      checksum,
      storageKey: 'content/blob',
      sizeBytes: 10n,
      state: 'available',
      verifiedAt: new Date()
    }
  })
  await client.literatureItem.create({
    data: {
      id: 'item',
      itemType: 'journalArticle',
      title: 'Safe synthetic paper',
      attachments: {
        create: {
          id: 'a',
          versions: {
            create: {
              id: 'v',
              contentBlobId: 'blob',
              versionNumber: 1,
              filename: 'paper.pdf',
              contentType: 'application/pdf',
              sizeBytes: 10n,
              checksum
            }
          }
        }
      }
    }
  })
  return new PdfTranslationCheckpoints({
    getClient: async () => client,
    authority: {
      resolveVersion: async (id) => {
        const row = await client.literatureAttachmentVersion.findUnique({ where: { id } })
        return row ? ({ checksum: row.checksum } as ResolvedLiteratureAttachmentVersion) : undefined
      }
    }
  })
}
afterEach(async () => {
  endMigration()
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})
it.each(
  readPdfTranslationCases<{
    name: string
    action: 'save' | 'fail' | 'shutdown'
    status: string
    saved: boolean
  }>('checkpoint-pending-write-lifecycle.jsonl')
)('$name', async ({ action, status, saved }) => {
  const checkpoints = await setup()
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'pending-save', surface: 'electron' })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const append = checkpoints.append.bind(checkpoints)
  const saving = vi.spyOn(checkpoints, 'append').mockImplementation(async (...args) => {
    await gate
    if (action === 'fail') throw new Error('Synthetic storage failure')
    return append(...args)
  })
  const tokens = { inputTokens: 12, outputTokens: 4, cacheTokens: 0 }
  const run = vi.fn(async () => ({
    text: '细胞',
    frameworkId: 'opencode' as const,
    model: 'test',
    stopReason: 'end_turn' as const,
    usage: tokens
  }))
  const finishUsage = vi.fn(async () => {})
  const finish = vi.fn(async () => {})
  const usage = { start: async () => finishUsage, recover: async () => {}, flush: finish }
  const owner = new PdfTranslationOwner({
    usage,
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
  const { operationId } = await owner.begin(input, caller.lease)
  const request = { operationId, sourceIndex: 0, source: input.sources[0] }
  const pending = owner.translate(request, caller.lease)
  // Observe the failure immediately, including cancellation during shutdown.
  const outcome = pending.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  let stopping: Promise<void> | undefined
  try {
    await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce())
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (action === 'save') {
      const duplicate = owner.translate(request, caller.lease).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(await Promise.race([duplicate, Promise.resolve({ pending: true })])).toMatchObject({
        error: { message: 'A translation paragraph is already running.' }
      })
      expect(run).toHaveBeenCalledOnce()
    } else if (action === 'shutdown') {
      stopping = owner.shutdown()
      // Cross an event-loop boundary while persistence is still held.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(finish).not.toHaveBeenCalled()
    }
    release()
    if (saved) {
      expect(await outcome).toEqual({ value: '细胞' })
      expect(await owner.translate(request, caller.lease)).toBe('细胞')
      expect(run).toHaveBeenCalledOnce()
    } else {
      expect(await outcome).toMatchObject({
        error: { code: action === 'shutdown' ? 'cancelled' : 'checkpoint-failed' }
      })
    }
    await (stopping ?? owner.shutdown())
    expect(finishUsage).toHaveBeenCalledExactlyOnceWith({
      status,
      usage: tokens,
      model: 'test'
    })
    expect((await checkpoints.read('v'))?.translations ?? []).toEqual(saved ? ['细胞'] : [])
  } finally {
    release()
    await outcome
    await (stopping ?? owner.shutdown())
    caller.release()
    registry.dispose()
  }
})
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
  const store = await setup(),
    signal = new AbortController().signal
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
    // Reconnect after each write, including partial sparse progress.
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect(await store.read('v')).toEqual(completed)
    expect(await store.open(changed, targetKey, model)).toEqual(completed)
  }
  expect(completed.translations).toEqual(expected)
  expect(pdfTranslationSourceIndices(completed)).toEqual(current.map((_, index) => index))
  await expect(store.append(restored, pending[0][0], '过期译文', signal)).rejects.toThrow(
    'another window'
  )
  expect(await store.read('v')).toEqual(completed)
})
it('restores saved strings after reconnect and rejects stale writers without losing newer work', async () => {
  const store = await setup(),
    signal = new AbortController().signal
  const a = (await store.open(input, targetKey, model))!
  const b = (await store.open(input, targetKey, model))!
  expect((await store.list('v')).map(({ key }) => key)).toEqual(
    expect.arrayContaining([a.key, b.key])
  )
  const saved = await store.append(a, 0, '细胞', signal)
  const independent = await store.append(b, 0, '独立译本', signal)
  expect(independent.key).not.toBe(saved.key)
  await store.delete({
    source: 'v',
    translationId: (await store.list('v')).find(({ key }) => key === independent.key)!.id
  })
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect(await store.read('v')).toEqual(saved)
  const resumed = (await store.open(
    { ...input, checkpoint: { key: saved.key, revision: saved.revision } },
    targetKey,
    model
  ))!
  await store.append(resumed, 1, '12', signal)
  expect((await store.read('v'))?.translations).toEqual(['细胞', '12'])
  await expect(store.append(saved, 1, '13', signal)).rejects.toThrow()
  const replacement = (await store.open(input, targetKey, model))!
  expect((await store.read('v', saved.key))?.translations).toHaveLength(2)
  expect((await store.read('v'))?.key).toBe(replacement.key)
  await store.append(replacement, 0, '新译文', signal)
  expect((await store.read('v'))?.translations).toEqual(['新译文'])
})
it('resumes zero-progress editions after cancellation and restart without reviving deleted editions', async () => {
  const store = await setup()
  const prepared = { ...input, layoutSnapshot: layoutSnapshot() }
  const opened = (await store.open(prepared, targetKey, model))!
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(store.append(opened, 0, '细胞', cancelled.signal)).rejects.toThrow()
  expect(await store.read('v', opened.key)).toEqual(opened)
  expect(await store.list('v')).toMatchObject([
    { key: opened.key, model, glossary: input.glossary }
  ])
  await client.$disconnect()
  client = createProjectDbClient(root)
  const restarted = new PdfTranslationCheckpoints({
    getClient: async () => client,
    authority: { resolveVersion: async () => ({ attachmentId: 'a', checksum }) }
  })
  const resume = { ...prepared, checkpoint: { key: opened.key, revision: opened.revision } }
  const a = (await restarted.open(resume, targetKey, model))!
  const b = (await store.open(resume, targetKey, model))!
  const signal = new AbortController().signal
  const saved = await restarted.append(a, 0, '细胞', signal)
  await expect(store.append(b, 0, '过期译文', signal)).rejects.toThrow('another window')
  expect(await restarted.read('v', opened.key)).toEqual(saved)

  const empty = (await restarted.open(input, targetKey, model))!
  await restarted.delete({
    source: 'v',
    translationId: (await restarted.list('v')).find(({ key }) => key === empty.key)!.id
  })
  await expect(restarted.append(empty, 0, '已删除译本', signal)).rejects.toThrow('another window')
  await expect(
    restarted.open(
      { ...input, checkpoint: { key: empty.key, revision: empty.revision } },
      targetKey,
      model
    )
  ).rejects.toThrow('another window')
  expect(await restarted.read('v', empty.key)).toBeNull()
  expect(await restarted.read('v', saved.key)).toEqual(saved)
})
it('persists structured glossary pairs, lists them after reconnect and pins them on resume', async () => {
  const store = await setup()
  const glossary = [
    { source: ' cell ', target: ' 细胞 ' },
    { source: 'x = y', target: 'x 等于 y' }
  ]
  const normalized = [
    { source: 'cell', target: '细胞' },
    { source: 'x = y', target: 'x 等于 y' }
  ]
  const opened = (await store.open({ ...input, glossary }, targetKey, model))!
  const saved = await store.append(opened, 0, '细胞', new AbortController().signal)
  const row = await client.pdfTranslation.findFirstOrThrow()
  expect(JSON.parse(row.payloadJson).glossary).toEqual(normalized)
  expect(JSON.parse(row.payloadJson).version).toBe(1)
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect((await store.read('v'))?.glossary).toEqual(normalized)
  expect((await store.list('v'))[0].glossary).toEqual(normalized)
  const resume = { ...input, glossary, checkpoint: { key: saved.key, revision: saved.revision } }
  expect((await store.open(resume, targetKey, model))?.glossary).toEqual(normalized)
  await expect(
    store.open({ ...resume, glossary: [{ source: 'cell', target: '不同译法' }] }, targetKey, model)
  ).rejects.toThrow('does not match')
})
it('rejects changed sources, malformed checkpoints, cancelled writes and migration; source deletion retains editions', async () => {
  const store = await setup(),
    signal = new AbortController().signal
  const draft = (await store.open(input, targetKey, model))!
  const saved = await store.append(draft, 0, '细胞', signal)
  await expect(
    store.open(
      { ...input, sources: ['changed'], checkpoint: { key: saved.key, revision: saved.revision } },
      targetKey,
      model
    )
  ).rejects.toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(store.append(saved, 1, '12', controller.signal)).rejects.toThrow()
  beginMigration()
  await expect(store.append(saved, 1, '12', signal)).rejects.toThrow()
  endMigration()
  await client.pdfTranslation.update({
    where: { id: await selectedTranslationId() },
    data: { payloadJson: '{"version":99}' }
  })
  await expect(store.read('v')).rejects.toThrow()
  await client.literatureAttachment.delete({ where: { id: 'a' } })
  expect(await client.pdfTranslation.count()).toBe(1)
  await expect(store.append(saved, 1, '12', signal)).rejects.toThrow()
})
it('saves in the main owner before returning, resumes cached units without inference and pins the model', async () => {
  const checkpoints = await setup()
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'test', surface: 'electron' })
  const run = vi.fn(async () => ({
    text: '<think>private reasoning</think>细胞',
    frameworkId: 'opencode' as const,
    model: 'test',
    stopReason: 'end_turn' as const
  }))
  const owner = new PdfTranslationOwner({
    usage: new PdfTranslationUsageRecorder(async () => client),
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
  const admission = await owner.begin(input, caller.lease)
  run.mockResolvedValueOnce({
    text: '<think>unfinished private reasoning',
    frameworkId: 'opencode',
    model: 'test',
    stopReason: 'end_turn'
  })
  await expect(
    owner.translate(
      { operationId: admission.operationId, sourceIndex: 0, source: 'cell' },
      caller.lease
    )
  ).rejects.toThrow('[pdf-translation:incomplete-output]')
  expect(await checkpoints.read('v')).toMatchObject({ translations: [], failedSourceIndices: [0] })
  await owner.translate(
    { operationId: admission.operationId, sourceIndex: 0, source: 'cell' },
    caller.lease
  )
  expect((await owner.readCheckpoint('v', caller.lease))?.translations).toEqual(['细胞'])
  owner.close(admission.operationId, caller.lease)
  const resumed = await owner.begin(
    { ...input, checkpoint: admission.checkpoint, expectedTargetKey: admission.targetKey },
    caller.lease
  )
  expect(
    await owner.translate(
      { operationId: resumed.operationId, sourceIndex: 0, source: 'cell' },
      caller.lease
    )
  ).toBe('细胞')
  expect(
    await owner.translate(
      { operationId: resumed.operationId, sourceIndex: 1, source: '12' },
      caller.lease
    )
  ).toBe('12')
  expect(run).toHaveBeenCalledTimes(2)
  expect(await client.pdfTranslationUsage.count()).toBe(2)
  expect((await client.pdfTranslationUsage.findMany()).map((row) => row.status).sort()).toEqual([
    'completed',
    'failed'
  ])
  expect((await checkpoints.read('v'))?.translations).toEqual(['细胞', '12'])
  run.mockResolvedValueOnce({
    text: '细胞内容',
    frameworkId: 'opencode',
    model: 'test',
    stopReason: 'end_turn'
  })
  expect(
    await owner.translate(
      { operationId: resumed.operationId, sourceIndex: 0, source: 'cell', replaceExisting: true },
      caller.lease
    )
  ).toBe('细胞内容')
  expect((await checkpoints.read('v'))?.translations).toEqual(['细胞内容', '12'])

  owner.close(resumed.operationId, caller.lease)
  await expect(
    owner.begin({ ...input, expectedTargetKey: 'c'.repeat(64) }, caller.lease)
  ).rejects.toThrow('model-changed')
  await client.pdfTranslation.update({
    where: { id: await selectedTranslationId() },
    data: { payloadJson: '{}' }
  })
  await expect(
    owner.begin({ ...input, checkpoint: resumed.checkpoint }, caller.lease)
  ).rejects.toThrow('checkpoint-failed')
  expect(run).toHaveBeenCalledTimes(3)
  await owner.shutdown()
  await client.literatureAttachment.delete({ where: { id: 'a' } })
  expect(await client.pdfTranslationUsage.count()).toBe(3)
  caller.release()
  await expect(owner.readCheckpoint('v', caller.lease)).rejects.toThrow()
  registry.dispose()
})

it('keeps authorized read-only package attachments on the ephemeral translation path', async () => {
  await setup()
  const store = new PdfTranslationCheckpoints({
    getClient: async () => client,
    authority: {
      resolveVersion: async () => ({ checksum }) as ResolvedLiteratureAttachmentVersion
    }
  })
  expect(await store.read('package-version')).toBeNull()
  expect(
    await store.open({ ...input, attachmentVersionId: 'package-version' }, targetKey, model)
  ).toBeUndefined()
  expect(await store.list('package-version')).toEqual([])
  await expect(store.select({ source: 'package-version', translationId: 'none' })).rejects.toThrow(
    'unavailable'
  )
  expect(await client.pdfTranslation.count()).toBe(0)
})

it('does not hold the migration gate while waiting for the provider', async () => {
  const checkpoints = await setup()
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'migration-reader', surface: 'electron' })
  let finish!: () => void
  const response = new Promise<{
    text: string
    stopReason: 'end_turn'
    frameworkId: 'opencode'
    model: string
  }>((resolve) => {
    finish = () =>
      resolve({ text: '细胞', stopReason: 'end_turn', frameworkId: 'opencode', model: 'test' })
  })
  const run = vi.fn(() => response)
  const usage = new PdfTranslationUsageRecorder(async () => client)
  const start = vi.spyOn(usage, 'start')
  const owner = new PdfTranslationOwner({
    usage,
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
  try {
    const admission = await owner.begin(input, caller.lease)
    const request = { operationId: admission.operationId, sourceIndex: 0, source: 'cell' }
    beginMigration()
    await expect(owner.translate(request, caller.lease)).rejects.toThrow(/moving your data/i)
    expect(run).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    endMigration()

    const pending = owner.translate(request, caller.lease)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    beginMigration()
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(true)
    finish()
    // The checkpoint write still acquires a short writer lease and must wait for
    // the migration gate to reopen before it can commit the result.
    endMigration()
    await expect(pending).resolves.toBe('细胞')
    await drain
    expect(drained).toBe(true)
    expect((await checkpoints.read('v'))?.translations).toEqual(['细胞'])
    expect(await client.pdfTranslationUsage.findFirst()).toMatchObject({ status: 'completed' })
  } finally {
    finish()
    endMigration()
    await owner.shutdown()
    caller.release()
    registry.dispose()
  }
})

it('never checkpoints a displaced numeric phrase and resumes only the validated translation', async () => {
  const checkpoints = await setup()
  const registry = new ApplicationCallerLeaseRegistry()
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
    usage: new PdfTranslationUsageRecorder(async () => client),
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
    expect((await client.pdfTranslationUsage.findMany()).map((row) => row.status).sort()).toEqual([
      'completed',
      'completed',
      'failed',
      'failed'
    ])
    await owner.shutdown()
    await client.$disconnect()
    client = createProjectDbClient(root)
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
  const caller = new ApplicationCallerLeaseRegistry().acquire({
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
    usage: new PdfTranslationUsageRecorder(async () => client),
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

it.each(
  readPdfTranslationCases<{
    name: string
    corruption:
      'revision' | 'checksum' | 'attachment' | 'duplicate-indices' | 'truncated-json' | 'oversized'
  }>('checkpoint-corruption-rejected-without-rewriting.jsonl')
)('$name', async ({ corruption }) => {
  const store = await setup(),
    signal = new AbortController().signal
  const saved = await store.append((await store.open(input, targetKey, model))!, 0, '细胞', signal)
  const original = JSON.stringify(saved)
  const payload = structuredClone(saved)
  if (corruption === 'revision') payload.revision++
  if (corruption === 'checksum') payload.checksum = 'c'.repeat(64)
  if (corruption === 'attachment')
    await client.literatureItem.update({ where: { id: 'item' }, data: { deletedAt: new Date() } })
  const raw =
    corruption === 'duplicate-indices'
      ? JSON.stringify({
          ...payload,
          version: 1,
          translations: ['细胞', '重复'],
          translatedSourceIndices: [0, 0]
        })
      : corruption === 'truncated-json'
        ? original.slice(0, -1)
        : corruption === 'oversized'
          ? ' '.repeat(8 * 1024 * 1024 + 1)
          : JSON.stringify(payload)
  // Deliberately simulate damaged on-disk data, bypassing the new table's JSON CHECK.
  await client.$executeRawUnsafe('PRAGMA ignore_check_constraints = ON')
  try {
    await client.pdfTranslation.update({
      where: { id: await selectedTranslationId() },
      data: { payloadJson: raw }
    })
  } finally {
    await client.$executeRawUnsafe('PRAGMA ignore_check_constraints = OFF')
  }
  await expect(store.read('v')).rejects.toThrow()
  await expect(
    store.open(
      { ...input, checkpoint: { key: saved.key, revision: saved.revision } },
      targetKey,
      model
    )
  ).rejects.toThrow()
  const row = await client.pdfTranslation.findUniqueOrThrow({
    where: { id: await selectedTranslationId() }
  })
  expect(row.payloadJson).toBe(raw)
  expect(row.revision).toBe(saved.revision)
  // Recovery from the known-good backup must retain accepted text and allow continuation.
  if (corruption === 'attachment')
    await client.literatureItem.update({ where: { id: 'item' }, data: { deletedAt: null } })
  await client.pdfTranslation.update({
    where: { id: await selectedTranslationId() },
    data: { payloadJson: original }
  })
  expect(await store.read('v')).toEqual(saved)
  const resumed = (await store.open(
    { ...input, checkpoint: { key: saved.key, revision: saved.revision } },
    targetKey,
    model
  ))!
  expect((await store.append(resumed, 1, '12', signal)).translations).toEqual(['细胞', '12'])
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

it('persists rejected blocks, continues later sources, and repairs an earlier failure after reopening', async () => {
  const checkpoints = await setup()
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'skip-block', surface: 'electron' })
  const run = vi.fn(async () => ({
    text: '',
    frameworkId: 'opencode' as const,
    model: 'test',
    stopReason: 'end_turn' as const
  }))
  const owner = new PdfTranslationOwner({
    checkpoints,
    usage: new PdfTranslationUsageRecorder(async () => client),
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
  try {
    const locatedInput = {
      ...input,
      sourceLocations: [
        { pageNumbers: [2, 3], fragmentCount: 2 },
        { pageNumbers: [3], fragmentCount: 1 }
      ]
    }
    const admission = await owner.begin(locatedInput, caller.lease)
    const request = { operationId: admission.operationId, sourceIndex: 0, source: 'cell' }
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(owner.translate(request, caller.lease)).rejects.toThrow('incomplete-output')
    expect(await checkpoints.read('v')).toMatchObject({
      translations: [],
      failedSourceIndices: [0],
      revision: admission.checkpoint!.revision + 2,
      failures: [
        { sourceIndex: 0, reasonCode: 'incomplete-output', pageNumbers: [2, 3], attempts: 2 }
      ]
    })
    await owner.skip(request, caller.lease)
    expect(await owner.translate({ ...request, sourceIndex: 1, source: '12' }, caller.lease)).toBe(
      '12'
    )
    const saved = (await checkpoints.read('v'))!
    expect(saved).toMatchObject({
      translations: ['12'],
      translatedSourceIndices: [1],
      failedSourceIndices: [0]
    })
    owner.close(admission.operationId, caller.lease)
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect(await checkpoints.read('v')).toEqual(saved)
    const resumed = await owner.begin(
      { ...input, checkpoint: { key: saved.key, revision: saved.revision } },
      caller.lease
    )
    await expect(
      owner.translate({ ...request, operationId: resumed.operationId }, caller.lease)
    ).rejects.toMatchObject({
      diagnostic: { reasonCode: 'incomplete-output', pageNumbers: [2, 3], attempts: 3 }
    })
    expect((await checkpoints.read('v'))?.failures?.[0].attempts).toBe(3)
    run.mockResolvedValueOnce({
      text: '细胞',
      frameworkId: 'opencode',
      model: 'test',
      stopReason: 'end_turn'
    })
    expect(
      await owner.translate({ ...request, operationId: resumed.operationId }, caller.lease)
    ).toBe('细胞')
    expect(await checkpoints.read('v')).toMatchObject({
      translations: ['细胞', '12'],
      translatedSourceIndices: [0, 1],
      failedSourceIndices: [],
      failures: []
    })
    expect(run).toHaveBeenCalledTimes(4)
    await expect(
      checkpoints.append(saved, 0, '过期译文', new AbortController().signal)
    ).rejects.toThrow('another window')
  } finally {
    await owner.shutdown()
    caller.release()
    registry.dispose()
  }
})

it('writes block-sized progress without serializing or updating the base snapshot', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  const sources = Array.from(
    { length: 180 },
    (_, index) => `source ${index} ${'prose '.repeat(500)}`
  )
  let saved = await store.append(
    (await store.open({ ...input, sources }, targetKey, model))!,
    0,
    '初始译文',
    signal
  )
  const base = await client.pdfTranslation.findUniqueOrThrow({
    where: { id: await selectedTranslationId() }
  })
  const stringify = vi.spyOn(JSON, 'stringify')
  try {
    for (let index = 1; index < 40; index++)
      saved = await store.append(saved, index, `译文 ${index} ${'内容'.repeat(100)}`, signal)
    saved = await store.append(saved, 40, undefined, signal)
    saved = await store.append(saved, 41, '后续译文', signal)
    saved = await store.append(saved, 40, '修复译文', signal)
    saved = await store.append(saved, 3, '替换译文', signal, true)
    expect(
      stringify.mock.calls.some(
        ([value]) => value && typeof value === 'object' && 'sources' in value
      )
    ).toBe(false)
  } finally {
    stringify.mockRestore()
  }
  expect(
    await client.pdfTranslation.findUniqueOrThrow({ where: { id: await selectedTranslationId() } })
  ).toEqual({ ...base, updatedAt: expect.any(Date) })
  expect(await client.pdfTranslationBlock.count()).toBe(42)
  expect(await store.read('v')).toEqual(saved)
  expect(() => {
    saved.sources[0] = 'mutated'
  }).toThrow()
  expect(() => {
    saved.translations[0] = 'mutated'
  }).toThrow()
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect(await store.read('v')).toEqual(saved)
  const replacement = await store.append(
    (await store.open({ ...input, sources }, targetKey, model))!,
    0,
    '重新翻译',
    signal
  )
  expect(await store.read('v')).toEqual(replacement)
  expect(
    await client.pdfTranslationBlock.findMany({
      where: { translationId: await selectedTranslationId() }
    })
  ).toMatchObject([{ sourceIndex: -1, revision: replacement.revision, translation: null }])
  await client.literatureAttachment.delete({ where: { id: 'a' } })
  expect(await client.pdfTranslationBlock.count()).toBe(43)
})

it('keeps block and revision CAS atomic when saving a block fails', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  const saved = await store.append((await store.open(input, targetKey, model))!, 0, '细胞', signal)
  await client.$executeRawUnsafe(
    `CREATE TRIGGER reject_translation_block BEFORE INSERT ON PdfTranslationBlock WHEN NEW.sourceIndex >= 0 BEGIN SELECT RAISE(ABORT, 'Synthetic block storage failure'); END`
  )
  await expect(store.append(saved, 1, '12', signal)).rejects.toThrow()
  expect(await store.read('v')).toEqual(saved)
  await client.$executeRawUnsafe('DROP TRIGGER reject_translation_block')
  const completed = await store.append(saved, 1, '12', signal)
  expect(await store.read('v')).toEqual(completed)
  await client.pdfTranslationBlock.update({
    where: {
      translationId_sourceIndex: { translationId: await selectedTranslationId(), sourceIndex: -1 }
    },
    data: { revision: completed.revision + 1 }
  })
  await expect(store.read('v')).rejects.toThrow('Invalid translation checkpoint')
})

it('preserves legacy snapshots while upgrading resumed writes to the block table', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  const saved = await store.append((await store.open(input, targetKey, model))!, 0, '细胞', signal)
  await client.pdfTranslationBlock.deleteMany()
  const legacy = await store.read('v')
  expect(legacy).toEqual(saved)
  const updated = await store.append(legacy!, 1, '12', signal)
  expect(await store.read('v')).toEqual(updated)
  expect(await client.pdfTranslationBlock.findMany()).toMatchObject([
    { sourceIndex: -1, revision: updated.revision }
  ])
  const external = structuredClone(updated)
  external.sources[0] = ''
  await expect(store.append(external, 0, '外部修改', signal, true)).rejects.toThrow()
  expect(await store.read('v')).toEqual(updated)
})

it('reduces actual SQLite WAL growth for long documents using immediate block commits', async () => {
  const store = await setup()
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL')
  await client.$queryRawUnsafe('PRAGMA wal_autocheckpoint = 0')
  const signal = new AbortController().signal
  const sources = Array.from(
    { length: 120 },
    (_, index) => `source ${index} ${'body '.repeat(1000)}`
  )
  let saved = await store.append(
    (await store.open({ ...input, sources }, targetKey, model))!,
    0,
    '初始译文',
    signal
  )
  const initial = saved
  await client.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
  for (let index = 1; index < 40; index++)
    saved = await store.append(saved, index, `译文 ${index} ${'内容'.repeat(100)}`, signal)
  const blockWalBytes = (await stat(join(root, 'open-science.db-wal'))).size
  expect(await store.read('v')).toEqual(saved)
  await client.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
  let legacy = initial
  let fullPayloadBytes = 0
  for (let index = 1; index < 40; index++) {
    legacy = pdfTranslationCheckpointSchema.parse({
      ...legacy,
      revision: legacy.revision + 1,
      translations: [...legacy.translations, `译文 ${index} ${'内容'.repeat(100)}`],
      translatedSourceIndices: [...legacy.translatedSourceIndices!, index]
    })
    const payloadJson = JSON.stringify(legacy)
    fullPayloadBytes += Buffer.byteLength(payloadJson)
    await client.pdfTranslation.update({
      where: { id: await selectedTranslationId() },
      data: { payloadJson, revision: legacy.revision }
    })
  }
  const snapshotWalBytes = (await stat(join(root, 'open-science.db-wal'))).size
  expect(blockWalBytes).toBeLessThan(snapshotWalBytes / 10)
  const report = {
    appends: 39,
    sourceBytes: Buffer.byteLength(JSON.stringify(sources)),
    blockWalBytes,
    snapshotWalBytes,
    fullPayloadBytes
  }
  if (process.env.PDF_CHECKPOINT_PERF_REPORT)
    await writeFile(process.env.PDF_CHECKPOINT_PERF_REPORT, JSON.stringify(report, null, 2))
})

it('enforces the serialized checkpoint limit on the incremental path without losing progress', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  const sources = Array.from(
    { length: 83 },
    (_, index) => `${index.toString().padStart(3, '0')}${'s'.repeat(99997)}`
  )
  const saved = await store.append(
    (await store.open({ ...input, sources }, targetKey, model))!,
    0,
    '译文',
    signal
  )
  await expect(store.append(saved, 1, '文'.repeat(100000), signal)).rejects.toThrow(
    'Invalid translation checkpoint'
  )
  expect(await store.read('v')).toEqual(saved)
})

it('rejects invalid block rows at the SQLite boundary', async () => {
  const store = await setup()
  await store.append(
    (await store.open(input, targetKey, model))!,
    0,
    '细胞',
    new AbortController().signal
  )
  for (const data of [
    { sourceIndex: -2, revision: 1, translation: null },
    { sourceIndex: 10000, revision: 1, translation: null },
    { sourceIndex: 1, revision: 0, translation: 'text' },
    { sourceIndex: 1, revision: 1, translation: ' ' },
    { sourceIndex: 1, revision: 1, translation: 's'.repeat(100001) }
  ])
    await expect(
      client.pdfTranslationBlock.create({
        data: { translationId: await selectedTranslationId(), ...data }
      })
    ).rejects.toThrow()
  await expect(
    client.pdfTranslationBlock.update({
      where: {
        translationId_sourceIndex: { translationId: await selectedTranslationId(), sourceIndex: -1 }
      },
      data: { translation: 'not metadata' }
    })
  ).rejects.toThrow()
})

it('saves concurrent out-of-order paragraphs with sequential CAS writes and restores their lanes', async () => {
  const checkpoints = await setup()
  const registry = new ApplicationCallerLeaseRegistry()
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

async function setupWorkspace(kind: 'upload-version' | 'artifact-version'): Promise<{
  store: PdfTranslationCheckpoints
  source: import('../../../shared/pdf-bookmarks').PdfDocumentSource
}> {
  await setup()
  await client.project.createMany({
    data: [
      { id: 'workspace', name: 'Workspace' },
      { id: 'other', name: 'Other' }
    ]
  })
  await client.fileOriginSession.create({ data: { projectId: 'workspace', sessionId: 'session' } })
  if (kind === 'upload-version') {
    await client.uploadFile.create({
      data: {
        id: 'file',
        projectId: 'workspace',
        sessionId: 'session',
        filename: 'paper.pdf',
        originalFilename: 'paper.pdf',
        versions: {
          create: {
            id: 'version',
            versionNumber: 1,
            state: 'ready',
            filename: 'paper.pdf',
            originalFilename: 'paper.pdf',
            contentStorageKey: 'content/workspace.pdf',
            contentType: 'application/pdf',
            sizeBytes: 10n,
            checksum
          }
        }
      }
    })
  } else {
    await client.artifactLineage.create({
      data: {
        id: 'file',
        projectId: 'workspace',
        sessionId: 'session',
        filename: 'paper.pdf',
        normalizedFilename: 'paper.pdf',
        versions: {
          create: {
            id: 'version',
            versionNumber: 1,
            state: 'finalized',
            originKind: 'legacy',
            filename: 'paper.pdf',
            contentStorageKey: 'content/workspace.pdf',
            contentType: 'application/pdf',
            sizeBytes: 10n,
            checksum
          }
        }
      }
    })
  }
  return {
    source: {
      kind,
      projectId: 'workspace',
      sourceFileId: 'file',
      versionId: 'version',
      sessionId: 'session',
      checksum,
      name: 'paper.pdf',
      path: 'content/workspace.pdf'
    },
    store: new PdfTranslationCheckpoints({
      getClient: async () => client,
      authority: {
        resolveVersion: async (id) => {
          const row = await client.literatureAttachmentVersion.findUnique({ where: { id } })
          return row
            ? ({
                attachmentId: row.attachmentId,
                checksum: row.checksum
              } as ResolvedLiteratureAttachmentVersion)
            : undefined
        }
      },
      // Byte authority is provided by composition. These tests deliberately leave ownership
      // checks to the real SQLite transaction, including races after that authority check.
      resolveDocumentSource: async (source) => source
    })
  }
}

it.each(['upload-version', 'artifact-version'] as const)(
  'persists, reopens and resumes %s deltas including failed blocks and rejects stale writers',
  async (kind) => {
    const { store, source } = await setupWorkspace(kind)
    const request = {
      ...input,
      attachmentVersionId: undefined,
      documentSource: source,
      concurrency: 2 as const,
      sources: ['cell', '12', 'third']
    }
    const signal = new AbortController().signal
    const initial = (await store.open(request, targetKey, model))!
    expect(initial.documentSource).toEqual(source)
    expect(initial.attachmentVersionId).toBeUndefined()
    expect(await store.read(source)).toEqual(initial)
    const first = await store.append(initial, 1, '12', signal)
    const base = await client.pdfTranslation.findFirstOrThrow()
    const failed = await store.append(first, 0, undefined, signal)
    expect(failed.failedSourceIndices).toEqual([0])
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect(await store.read(source)).toEqual(failed)
    expect(
      await store.open(
        { ...request, checkpoint: { key: failed.key, revision: failed.revision } },
        targetKey,
        model
      )
    ).toEqual(failed)
    const third = await store.append(failed, 2, '第三段', signal)
    const fixed = await store.append(third, 0, '细胞', signal)
    expect(fixed.translations).toEqual(['细胞', '12', '第三段'])
    expect(fixed.failedSourceIndices).toEqual([])
    expect((await client.pdfTranslation.findFirstOrThrow()).payloadJson).toEqual(base.payloadJson)
    expect(await client.pdfTranslationBlock.count()).toBe(3)
    await expect(store.append(failed, 2, '旧写入', signal)).rejects.toThrow('another window')
    expect(await store.read(source)).toEqual(fixed)
    const replacement = (await store.open(request, targetKey, model))!
    const replaced = await store.append(replacement, 0, '新的细胞', signal)
    expect(await store.read(source)).toEqual(replaced)
    expect(await client.pdfTranslationBlock.count()).toBe(4)
    expect(await store.list(source)).toHaveLength(2)
  }
)

it.each(['upload-version', 'artifact-version'] as const)(
  'isolates %s ownership, source checksum, deleted projects and deleted versions',
  async (kind) => {
    const { store, source } = await setupWorkspace(kind)
    const request = { ...input, attachmentVersionId: undefined, documentSource: source }
    const signal = new AbortController().signal
    const initial = (await store.open(request, targetKey, model))!
    const saved = await store.append(initial, 0, '细胞', signal)
    for (const changed of [
      { projectId: 'other' },
      { sourceFileId: 'other-file' },
      { versionId: 'v' },
      { checksum: 'f'.repeat(64) }
    ]) {
      await expect(store.read({ ...source, ...changed })).rejects.toThrow('source is unavailable')
      await expect(
        store.open({ ...request, documentSource: { ...source, ...changed } }, targetKey, model)
      ).rejects.toThrow('source is unavailable')
    }
    await client.project.update({ where: { id: 'workspace' }, data: { deletedAt: new Date() } })
    await expect(store.append(saved, 1, '12', signal)).rejects.toThrow('source is unavailable')
    await client.project.update({ where: { id: 'workspace' }, data: { deletedAt: null } })
    await client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'workspace', sessionId: 'session' } },
      data: { state: 'deleted', deletedAt: new Date() }
    })
    expect(await store.read(source)).toEqual(saved)
    await client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'workspace', sessionId: 'session' } },
      data: { state: 'active', deletedAt: null }
    })
    if (kind === 'upload-version') await client.uploadVersion.delete({ where: { id: 'version' } })
    else await client.artifactVersion.delete({ where: { id: 'version' } })
    expect(await client.pdfTranslation.count()).toBe(1)
    expect(await client.pdfTranslationBlock.count()).toBe(1)
    await expect(store.append(saved, 1, '12', signal)).rejects.toThrow('source is unavailable')
  }
)

it('rejects changes between authority resolution and the workspace save transaction', async () => {
  const { source } = await setupWorkspace('upload-version')
  let deleted = false
  const store = new PdfTranslationCheckpoints({
    getClient: async () => client,
    authority: { resolveVersion: async () => undefined },
    resolveDocumentSource: async (resolved) => {
      if (deleted)
        await client.uploadVersion.update({
          where: { id: resolved.versionId },
          data: { checksum: 'c'.repeat(64) }
        })
      return resolved
    }
  })
  const initial = (await store.open(
    { ...input, attachmentVersionId: undefined, documentSource: source },
    targetKey,
    model
  ))!
  deleted = true
  await expect(store.append(initial, 0, '细胞', new AbortController().signal)).rejects.toThrow(
    'source is unavailable'
  )
  expect(await client.pdfTranslation.count()).toBe(1)
})

it('workspace deletion retains editions and preserves failed byte authority rejection', async () => {
  const { store, source } = await setupWorkspace('upload-version')
  const request = { ...input, attachmentVersionId: undefined, documentSource: source }
  const initial = (await store.open(request, targetKey, model))!
  await store.append(initial, 0, '细胞', new AbortController().signal)
  const unavailable = new PdfTranslationCheckpoints({
    getClient: async () => client,
    authority: { resolveVersion: async () => undefined },
    resolveDocumentSource: async () => undefined
  })
  await expect(unavailable.read(source)).rejects.toThrow('source is unavailable')
  await expect(unavailable.open(request, targetKey, model)).rejects.toThrow('source is unavailable')
  await client.project.delete({ where: { id: 'workspace' } })
  expect(await client.pdfTranslation.count()).toBe(1)
  expect(await client.pdfTranslationBlock.count()).toBe(1)
})

it('normalizes library document sources to the historical checkpoint without a workspace callback', async () => {
  await setup()
  const store = new PdfTranslationCheckpoints({
    getClient: async () => client,
    authority: {
      resolveVersion: async (id) => {
        const row = await client.literatureAttachmentVersion.findUnique({ where: { id } })
        return row
          ? ({
              versionId: row.id,
              attachmentId: row.attachmentId,
              checksum: row.checksum
            } as ResolvedLiteratureAttachmentVersion)
          : undefined
      }
    }
  })
  const source = {
    kind: 'literature-attachment-version' as const,
    sourceFileId: 'a',
    versionId: 'v',
    checksum,
    name: 'paper.pdf',
    path: 'literature.pdf'
  }
  const opened = (await store.open(
    { ...input, attachmentVersionId: undefined, documentSource: source },
    targetKey,
    model
  ))!
  expect(opened.attachmentVersionId).toBe('v')
  expect(opened.documentSource).toBeUndefined()
  const saved = await store.append(opened, 0, '细胞', new AbortController().signal)
  expect(await store.read(source)).toEqual(saved)
  expect(await store.read('v')).toEqual(saved)
  for (const changed of [{ sourceFileId: 'different' }, { checksum: 'f'.repeat(64) }])
    await expect(store.read({ ...source, ...changed })).rejects.toThrow('source is unavailable')
})

it('retains shared editions while revoking access through the soft-deleted project', async () => {
  const { store, source } = await setupWorkspace('upload-version')
  await client.fileOriginSession.create({
    data: { projectId: 'other', sessionId: 'other-session' }
  })
  await client.uploadFile.create({
    data: {
      id: 'other-file',
      projectId: 'other',
      sessionId: 'other-session',
      filename: 'other.pdf',
      originalFilename: 'other.pdf',
      versions: {
        create: {
          id: 'other-version',
          versionNumber: 1,
          state: 'ready',
          filename: 'other.pdf',
          originalFilename: 'other.pdf',
          contentStorageKey: 'content/other.pdf',
          checksum,
          sizeBytes: 10n
        }
      }
    }
  })
  const otherSource = {
    ...source,
    projectId: 'other',
    sourceFileId: 'other-file',
    versionId: 'other-version',
    sessionId: 'other-session'
  }
  const open = async (documentSource: typeof source): Promise<PdfTranslationCheckpoint> =>
    (await store.open(
      { ...input, attachmentVersionId: undefined, documentSource },
      targetKey,
      model
    ))!
  const signal = new AbortController().signal
  const saved = await store.append(await open(source), 0, '细胞', signal)
  await store.append(saved, 1, '12', signal)
  const other = await store.append(await open(otherSource), 0, '另一个项目', signal)
  const projects = new ProjectRepository(async () => client)
  await projects.delete('workspace')
  expect(
    (await client.project.findUniqueOrThrow({ where: { id: 'workspace' } })).deletedAt
  ).not.toBeNull()
  expect(await client.uploadVersion.findUnique({ where: { id: 'version' } })).not.toBeNull()
  expect(await client.pdfTranslationBlock.count()).toBe(3)
  expect(await store.list(otherSource)).toHaveLength(2)
  expect(await store.read(otherSource)).toEqual(other)
  await expect(store.append(saved, 1, '旧写入', signal)).rejects.toThrow('source is unavailable')
  await expect(store.read(source)).rejects.toThrow('source is unavailable')
  await projects.delete('workspace')
  expect(await store.read(otherSource)).toEqual(other)
})

it.each(['network', 'unavailable', 'deadline', 'cancel'] as const)(
  'persists %s failure metadata without storing error text',
  async (mode) => {
    const checkpoints = await setup()
    const registry = new ApplicationCallerLeaseRegistry()
    const caller = registry.acquire({ leaseId: 'diagnostic-reader', surface: 'electron' })
    let running!: () => void
    const started = new Promise<void>((resolve) => {
      running = resolve
    })
    let retrying = false
    const privateMessage = 'private provider payload should not be stored'
    const owner = new PdfTranslationOwner({
      checkpoints,
      usage: new PdfTranslationUsageRecorder(async () => client),
      captureTarget: async () => ({
        frameworkId: 'opencode',
        providerId: 'p',
        model: { kind: 'required', id: 'test' },
        reasoningEffort: 'default'
      }),
      runner: {
        run: async ({ signal }) => {
          if (retrying)
            return {
              text: '细胞',
              frameworkId: 'opencode' as const,
              model: 'test',
              stopReason: 'end_turn' as const
            }
          running()
          if (mode === 'network' || mode === 'unavailable')
            throw new Error(
              `[provider-failure:${mode}:${mode === 'network' ? 0 : 503}] ${privateMessage}`
            )
          return new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(new Error(privateMessage)))
          })
        },
        supportsTarget: () => true,
        shutdown: async () => {},
        sweepStaleProfiles: async () => {}
      }
    })
    try {
      const admission = await owner.begin(
        {
          ...input,
          sourceLocations: [
            { pageNumbers: [2], fragmentCount: 1 },
            { pageNumbers: [3], fragmentCount: 1 }
          ]
        },
        caller.lease
      )
      if (mode === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = owner
        .translate(
          { operationId: admission.operationId, sourceIndex: 0, source: input.sources[0] },
          caller.lease
        )
        .catch((error) => error)
      await started
      if (mode === 'deadline') await vi.advanceTimersByTimeAsync(180000)
      if (mode === 'cancel') owner.close(admission.operationId, caller.lease)
      const error = await pending
      vi.useRealTimers()
      const saved = await checkpoints.read('v')
      if (mode === 'cancel') {
        expect(error.message).toContain('[pdf-translation:cancelled]')
        expect(saved).toMatchObject({ translations: [], translatedSourceIndices: [] })
        expect(saved?.failures).toBeUndefined()
        retrying = true
        const resumed = await owner.begin(
          { ...input, checkpoint: admission.checkpoint },
          caller.lease
        )
        expect(resumed.checkpoint).toEqual(admission.checkpoint)
        expect(
          await owner.translate(
            { operationId: resumed.operationId, sourceIndex: 0, source: input.sources[0] },
            caller.lease
          )
        ).toBe('细胞')
        expect((await checkpoints.read('v'))?.translations).toEqual(['细胞'])
      } else {
        expect(saved?.failures).toEqual([
          {
            sourceIndex: 0,
            disposition: 'retryable',
            reasonCode: mode === 'deadline' ? 'timeout' : 'provider-failed',
            pageNumbers: [2],
            attempts: 1
          }
        ])
        const row = await client.pdfTranslation.findUniqueOrThrow({
          where: { id: await selectedTranslationId() }
        })
        expect(row.payloadJson).not.toContain(privateMessage)
        owner.close(admission.operationId, caller.lease)
        const resumed = await owner.begin(
          { ...input, checkpoint: { key: saved!.key, revision: saved!.revision } },
          caller.lease
        )
        await owner.skip(
          { operationId: resumed.operationId, sourceIndex: 0, source: input.sources[0] },
          caller.lease
        )
        expect((await checkpoints.read('v'))?.failures).toEqual(
          saved!.failures!.map((failure) => ({ ...failure, disposition: 'skipped' }))
        )
      }
    } finally {
      vi.useRealTimers()
      await owner.shutdown()
      caller.release()
      registry.dispose()
    }
  }
)

it.each(['upload-version', 'artifact-version'] as const)(
  'retains %s failure explanation through incremental writes and removes it on repair',
  async (kind) => {
    const { store, source } = await setupWorkspace(kind)
    const signal = new AbortController().signal
    const request = {
      ...input,
      attachmentVersionId: undefined,
      documentSource: source,
      sources: ['first', 'second', 'third']
    }
    let saved = (await store.open(request, targetKey, model))!
    saved = await store.append(saved, 0, '第一段', signal)
    const diagnostic = { reasonCode: 'missing-proper-name' as const, pageNumbers: [2], attempts: 2 }
    saved = await store.append(saved, 1, undefined, signal, false, diagnostic)
    const base = await client.pdfTranslation.findFirstOrThrow()
    saved = await store.append(saved, 2, '第三段', signal)
    expect(await client.pdfTranslation.findFirstOrThrow()).toEqual({
      ...base,
      updatedAt: expect.any(Date)
    })
    await client.$disconnect()
    client = createProjectDbClient(root)
    saved = (await store.read(source))!
    expect(saved.failures).toEqual([{ ...diagnostic, sourceIndex: 1 }])
    saved = await store.append(saved, 1, '第二段', signal)
    expect(saved.failures).toEqual([])
    expect((await store.read(source))?.failures).toEqual([])
  }
)

it.each([
  '[provider-failure:authentication:401]',
  '[provider-failure:permission:403]',
  '[provider-failure:quota:429]',
  '[provider-failure:rate-limit:429]',
  '[provider-failure:request:400]',
  '[provider-failure:http:302]',
  'Unknown provider failure'
])('does not skip a blocked paragraph after reopening %s', async (failure) => {
  const checkpoints = await setup()
  const registry = new ApplicationCallerLeaseRegistry()
  const caller = registry.acquire({ leaseId: 'provider-repair-reader', surface: 'electron' })
  const run = vi
    .fn()
    .mockResolvedValueOnce({ text: '细胞', stopReason: 'end_turn' })
    .mockRejectedValueOnce(new Error(failure))
    .mockResolvedValueOnce({ text: '组织', stopReason: 'end_turn' })
  const owner = new PdfTranslationOwner({
    checkpoints,
    usage: new PdfTranslationUsageRecorder(async () => client),
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
  const requestInput = { ...input, sources: ['cell', 'tissue'] }
  try {
    const admission = await owner.begin(requestInput, caller.lease)
    await owner.translate(
      { operationId: admission.operationId, sourceIndex: 0, source: 'cell' },
      caller.lease
    )
    const before = (await checkpoints.read('v'))!
    await expect(
      owner.translate(
        { operationId: admission.operationId, sourceIndex: 1, source: 'tissue' },
        caller.lease
      )
    ).rejects.toThrow()
    owner.close(admission.operationId, caller.lease)
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect(await checkpoints.read('v')).toEqual(before)
    const resumed = await owner.begin(
      { ...requestInput, checkpoint: { key: before.key, revision: before.revision } },
      caller.lease
    )
    await expect(
      owner.translate(
        { operationId: resumed.operationId, sourceIndex: 1, source: 'tissue' },
        caller.lease
      )
    ).resolves.toBe('组织')
    expect((await checkpoints.read('v'))?.translations).toEqual(['细胞', '组织'])
  } finally {
    await owner.shutdown()
    caller.release()
    registry.dispose()
  }
})

it('keeps layout diagnoses across reopen and concurrent translation without changing its CAS revision', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  let saved = (await store.open(
    { ...input, sources: [...input.sources, 'third'] },
    targetKey,
    model
  ))!
  saved = await store.append(saved, 0, '细胞', signal)
  const failure = {
    code: 'overflow' as const,
    phase: 'planning' as const,
    pageNumbers: [2],
    fragmentCount: 2
  }
  const request = {
    source: 'v',
    checkpointKey: saved.key,
    generatedAt: Date.now() - 100,
    units: [{ sourceIndex: 0, source: 'cell', translation: '细胞', failure }]
  }
  await store.recordLayout(request, signal)
  // The translation owner still holds a snapshot from before the report arrived.
  const continued = await store.append(saved, 1, '12', signal)
  expect(continued.revision).toBe(saved.revision + 1)
  await client.$disconnect()
  client = createProjectDbClient(root)
  const reopened = (await store.read('v'))!
  expect(reopened.layoutReports).toEqual([expect.objectContaining({ sourceIndex: 0, failure })])
  expect(reopened.translations).toEqual(['细胞', '12'])
  // A full snapshot from that same stale owner must preserve the independently saved report.
  await store.append(continued, 2, undefined, signal, false, {
    reasonCode: 'skipped',
    pageNumbers: [3],
    attempts: 2
  })
  expect((await store.read('v'))?.layoutReports?.[0].failure).toEqual(failure)
  // Successful verification is retained as a tombstone so a late old failure cannot reappear.
  await store.recordLayout(
    {
      ...request,
      generatedAt: request.generatedAt + 1,
      units: [{ ...request.units[0], failure: undefined }]
    },
    signal
  )
  await store.recordLayout(request, signal)
  expect((await store.read('v'))?.layoutReports).toEqual([
    expect.objectContaining({ generatedAt: request.generatedAt + 1 })
  ])
  expect((await store.read('v'))?.layoutReports?.[0].failure).toBeUndefined()
})

it('rejects layout reports for a replaced translation, checkpoint or source and clears obsolete failures', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  let saved = (await store.open(input, targetKey, model))!
  saved = await store.append(saved, 0, '细胞', signal)
  const request = {
    source: 'v',
    checkpointKey: saved.key,
    generatedAt: Date.now() - 100,
    units: [
      {
        sourceIndex: 0,
        source: 'cell',
        translation: '细胞',
        failure: {
          code: 'source-mismatch' as const,
          phase: 'ownership' as const,
          pageNumbers: [1],
          fragmentCount: 1
        }
      }
    ]
  }
  await store.recordLayout(request, signal)
  saved = await store.append(saved, 0, '细胞体', signal, true)
  expect((await store.read('v'))?.layoutReports).toEqual([])
  await store.recordLayout({ ...request, generatedAt: request.generatedAt + 1 }, signal)
  expect((await store.read('v'))?.layoutReports).toEqual([])
  saved = await store.append(saved, 0, '细胞', signal, true)
  expect((await store.read('v'))?.layoutReports).toEqual([])
  await store.recordLayout(
    { ...request, checkpointKey: '00000000-0000-4000-8000-000000000000' },
    signal
  )
  expect((await store.read('v'))?.layoutReports).toEqual([])
  await expect(
    store.recordLayout({ ...request, generatedAt: Date.now() + 120000 }, signal)
  ).rejects.toThrow('Invalid PDF layout report')
  await expect(
    store.recordLayout({ ...request, units: [...request.units, ...request.units] }, signal)
  ).rejects.toThrow('Invalid PDF layout report')
  await client.literatureItem.update({ where: { id: 'item' }, data: { deletedAt: new Date() } })
  await expect(store.recordLayout(request, signal)).rejects.toThrow('unavailable')
})

it.each(['upload-version', 'artifact-version'] as const)(
  'restores layout diagnosis for immutable workspace %s and ignores late reports after a new run',
  async (kind) => {
    const { store, source } = await setupWorkspace(kind)
    const request = { ...input, attachmentVersionId: undefined, documentSource: source }
    const signal = new AbortController().signal
    const saved = await store.append(
      (await store.open(request, targetKey, model))!,
      0,
      '细胞',
      signal
    )
    const failure = {
      code: 'annotations' as const,
      phase: 'glyphs' as const,
      pageNumbers: [1],
      fragmentCount: 1
    }
    const report = {
      source,
      checkpointKey: saved.key,
      generatedAt: Date.now() - 100,
      units: [{ sourceIndex: 0, source: 'cell', translation: '细胞', failure }]
    }
    await store.recordLayout(report, signal)
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect((await store.read(source))?.layoutReports?.[0].failure).toEqual(failure)
    const next = await store.append(
      (await store.open(request, targetKey, model))!,
      0,
      '新的细胞',
      signal
    )
    await store.recordLayout({ ...report, generatedAt: report.generatedAt + 1 }, signal)
    expect((await store.read(source))?.key).toBe(next.key)
    expect((await store.read(source))?.layoutReports ?? []).toEqual([])
    await client.project.update({ where: { id: 'workspace' }, data: { deletedAt: new Date() } })
    await expect(store.recordLayout(report, signal)).rejects.toThrow('unavailable')
  }
)

it('logs only failed layout diagnoses, even after more than twenty successful reports', async () => {
  const store = await setup()
  initLogger({ logDir: root, mirrorToConsole: false })
  const signal = new AbortController().signal
  const sources = Array.from({ length: 22 }, (_, index) => `source ${index}`)
  let saved = (await store.open({ ...input, sources }, targetKey, model))!
  for (const index of sources.keys()) {
    saved = await store.append(saved, index, `译文 ${index}`, signal)
  }
  const generatedAt = Date.now() - 100
  const units = sources.map((source, sourceIndex) => ({
    sourceIndex,
    source,
    translation: `译文 ${sourceIndex}`
  }))
  await store.recordLayout({ source: 'v', checkpointKey: saved.key, generatedAt, units }, signal)
  const failure = {
    code: 'overflow' as const,
    phase: 'planning' as const,
    pageNumbers: [10],
    fragmentCount: 1
  }
  await store.recordLayout(
    {
      source: 'v',
      checkpointKey: saved.key,
      generatedAt: generatedAt + 1,
      units: units.map((unit) => (unit.sourceIndex === 21 ? { ...unit, failure } : unit))
    },
    signal
  )
  await flushLogs()
  const records = (await readFile(join(root, 'main.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter(
      (record) =>
        record.scope === 'pdf-translation-checkpoint' && record.msg.startsWith('PDF layout')
    )
  expect(records).toEqual([
    expect.objectContaining({
      msg: 'PDF layout diagnoses persisted',
      data: expect.objectContaining({
        updatedCount: 22,
        failureCount: 1,
        reports: [{ sourceIndex: 21, ...failure }]
      })
    })
  ])
  expect((await store.read('v'))?.layoutReports).toHaveLength(22)
})

const layoutSnapshot =
  (): import('../../../shared/pdf-translation-snapshot').PdfTranslationLayoutSnapshot => ({
    version: 1,
    parserVersion: 'test-parser-v1',
    fingerprint: input.fingerprint,
    pages: [{ width: 612, height: 792 }],
    units: input.sources.map((source, index) => ({
      id: `saved-${index}`,
      source,
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1 + index * 0.2, width: 0.8, height: 0.1 },
          items: [{ index, text: source }]
        }
      ]
    })),
    coverage: {
      pageCount: 1,
      textItemCount: 2,
      includedItemCount: 2,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: [],
      warnings: []
    }
  })

it.each(['literature', 'upload-version', 'artifact-version'] as const)(
  'pins layout independently of paragraph writes and restores it after reopening %s',
  async (kind) => {
    const { store, source } =
      kind === 'literature' ? { store: await setup(), source: 'v' } : await setupWorkspace(kind)
    const request = {
      ...input,
      layoutSnapshot: layoutSnapshot(),
      ...(typeof source === 'string'
        ? {}
        : { attachmentVersionId: undefined, documentSource: source })
    }
    const opened = (await store.open(request, targetKey, model))!
    const first = await store.append(opened, 0, '细胞', new AbortController().signal)
    const row =
      typeof source === 'string'
        ? await client.pdfTranslation.findFirstOrThrow()
        : await client.pdfTranslation.findFirstOrThrow()
    expect(JSON.parse(row.payloadJson).layoutSnapshot).toBeUndefined()
    expect(JSON.parse(row.layoutSnapshotJson!)).toEqual(request.layoutSnapshot)
    await store.append(first, 1, '12', new AbortController().signal)
    const next =
      typeof source === 'string'
        ? await client.pdfTranslation.findFirstOrThrow()
        : await client.pdfTranslation.findFirstOrThrow()
    expect(next.layoutSnapshotJson).toBe(row.layoutSnapshotJson)
    expect(next.payloadJson).toBe(row.payloadJson)
    await client.$disconnect()
    client = createProjectDbClient(root)
    const restored = (await store.read(source))!
    expect(restored.translations).toEqual(['细胞', '12'])
    expect(restored.layoutSnapshot).toEqual(request.layoutSnapshot)
    await expect(
      store.open(
        {
          ...request,
          sources: ['cell 12'],
          layoutSnapshot: undefined,
          checkpoint: { key: restored.key, revision: restored.revision }
        },
        targetKey,
        model
      )
    ).rejects.toThrow('does not match')
    await expect(
      store.saveSnapshot(
        {
          source,
          checkpointKey: restored.key,
          snapshot: { ...layoutSnapshot(), parserVersion: 'upgraded-parser' }
        },
        new AbortController().signal
      )
    ).rejects.toThrow('already pinned')
  }
)

it('backfills a legacy layout without invalidating in-flight saves and protects new runs from late adoption', async () => {
  const store = await setup(),
    signal = new AbortController().signal
  const opened = (await store.open(input, targetKey, model))!
  const first = await store.append(opened, 0, '细胞', signal)
  await store.saveSnapshot(
    { source: 'v', checkpointKey: first.key, snapshot: layoutSnapshot() },
    signal
  )
  // A failed-block write compacts the base and must merge the independently saved layout.
  const second = await store.append(first, 1, undefined, signal, false, {
    reasonCode: 'skipped',
    pageNumbers: [1],
    attempts: 2
  })
  expect(second.layoutSnapshot).toEqual(layoutSnapshot())
  expect((await store.read('v'))!.layoutSnapshot).toEqual(layoutSnapshot())
  const fresh = (await store.open(input, targetKey, model))!
  await store.append(fresh, 0, '细胞', signal)
  await expect(
    store.saveSnapshot(
      { source: 'v', checkpointKey: first.key, snapshot: layoutSnapshot() },
      signal
    )
  ).resolves.toBeUndefined()
  expect((await store.read('v'))!.layoutSnapshot).toBeUndefined()
  expect((await store.read('v', first.key))!.layoutSnapshot).toEqual(layoutSnapshot())
  await store.recordLayout(
    {
      source: 'v',
      checkpointKey: first.key,
      generatedAt: Date.now(),
      units: [{ sourceIndex: 0, source: 'cell', translation: '细胞' }]
    },
    signal
  )
  expect((await store.read('v', first.key))?.layoutReports).toHaveLength(1)
  expect((await store.read('v'))?.layoutReports).toBeUndefined()
})

it('refuses ambiguous legacy adoption, mismatched fingerprints and duplicate fragment ownership', async () => {
  const store = await setup(),
    signal = new AbortController().signal
  const first = await store.append((await store.open(input, targetKey, model))!, 0, '细胞', signal)
  for (const snapshot of [
    { ...layoutSnapshot(), fingerprint: 'different' },
    { ...layoutSnapshot(), units: layoutSnapshot().units.toReversed() },
    {
      ...layoutSnapshot(),
      units: [layoutSnapshot().units[0], { ...layoutSnapshot().units[0], id: 'duplicate-owner' }]
    }
  ])
    await expect(
      store.saveSnapshot({ source: 'v', checkpointKey: first.key, snapshot }, signal)
    ).rejects.toThrow()
  expect((await store.read('v'))!.translations).toEqual(['细胞'])
  expect((await store.read('v'))!.layoutSnapshot).toBeUndefined()
})

it.each(['upload-version', 'artifact-version'] as const)(
  'shares %s translations, pinned layout and failures with literature across restart',
  async (kind) => {
    const { store, source } = await setupWorkspace(kind)
    const signal = new AbortController().signal
    const request = {
      ...input,
      attachmentVersionId: undefined,
      documentSource: source,
      layoutSnapshot: layoutSnapshot()
    }
    let saved = await store.append(
      (await store.open(request, targetKey, model))!,
      0,
      '细胞',
      signal
    )
    saved = await store.append(saved, 1, undefined, signal, false, {
      reasonCode: 'missing-numeric-literals',
      pageNumbers: [1],
      attempts: 2
    })
    const library = (await store.read('v'))!
    expect(library).toMatchObject({
      key: saved.key,
      revision: saved.revision,
      attachmentVersionId: 'v',
      translations: ['细胞'],
      failures: saved.failures,
      layoutSnapshot: layoutSnapshot()
    })
    expect(library.documentSource).toBeUndefined()
    expect(await client.pdfTranslation.count()).toBe(1)
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect(await store.read('v')).toEqual(library)
    const repaired = await store.append((await store.read('v'))!, 1, '12', signal)
    expect(await store.read(source)).toMatchObject({
      key: repaired.key,
      translations: ['细胞', '12'],
      failures: [],
      documentSource: source,
      layoutSnapshot: layoutSnapshot()
    })
    await expect(store.append(saved, 1, '旧译文', signal)).rejects.toThrow('another window')
    await new ProjectRepository(async () => client).delete('workspace')
    expect(await store.read('v')).toEqual(repaired)
    expect(await client.pdfTranslation.count()).toBe(1)
    await store.append((await store.read('v'))!, 0, '更新细胞', signal, true)
    await client.literatureAttachment.delete({ where: { id: 'a' } })
    expect(await client.pdfTranslation.count()).toBe(1)
    expect(await client.pdfTranslationBlock.count()).toBeGreaterThan(0)
  }
)

it('reuses library results in workspace and preserves them when either source is deleted', async () => {
  const { store, source } = await setupWorkspace('upload-version')
  const signal = new AbortController().signal
  const saved = await store.append(
    (await store.open({ ...input, layoutSnapshot: layoutSnapshot() }, targetKey, model))!,
    0,
    '细胞',
    signal
  )
  expect(await store.read(source)).toMatchObject({
    key: saved.key,
    documentSource: source,
    layoutSnapshot: layoutSnapshot()
  })
  await client.literatureAttachment.delete({ where: { id: 'a' } })
  const workspace = (await store.read(source))!
  expect(workspace.translations).toEqual(['细胞'])
  await store.append(workspace, 1, '12', signal)
  await client.project.delete({ where: { id: 'workspace' } })
  expect(await client.pdfTranslation.count()).toBe(1)
})

it('defaults new readers to the latest edition while existing readers can continue their chosen edition', async () => {
  const { store, source } = await setupWorkspace('upload-version')
  const signal = new AbortController().signal
  const saved = await store.append(
    (await store.open({ ...input, layoutSnapshot: layoutSnapshot() }, targetKey, model))!,
    0,
    '细胞',
    signal
  )
  const workspace = (await store.read(source))!
  const replacement = (await store.open(
    { ...input, attachmentVersionId: undefined, documentSource: source, language: 'German' },
    targetKey,
    model
  ))!
  expect((await store.read(source))!.key).toBe(replacement.key)
  const controller = new AbortController()
  controller.abort()
  await expect(store.append(replacement, 0, 'Zelle', controller.signal)).rejects.toThrow()
  expect(await client.pdfTranslation.count()).toBe(2)
  const next = await store.append(replacement, 0, 'Zelle', signal)
  expect((await store.read(source))!.language).toBe('German')
  expect((await store.read('v'))?.key).toBe(next.key)
  expect(next.key).not.toBe(saved.key)
  expect(await client.pdfTranslation.count()).toBe(2)
  const continued = await store.append(workspace, 1, '12', signal)
  expect(continued.key).toBe(saved.key)
  await expect(store.append(workspace, 1, '旧写入', signal)).rejects.toThrow('another window')
  expect((await store.read('v', saved.key))!.translations).toEqual(['细胞', '12'])
  expect((await store.read(source))!.translations).toEqual(['Zelle'])
  // New sources choose the latest created edition, even after the old edition was updated.
  await client.literatureAttachmentVersion.create({
    data: {
      id: 'v2',
      attachmentId: 'a',
      contentBlobId: 'blob',
      versionNumber: 2,
      filename: 'same.pdf',
      contentType: 'application/pdf',
      checksum: 'c'.repeat(64),
      sizeBytes: 10n
    }
  })
  await client.literatureAttachment.create({
    data: {
      id: 'a2',
      itemId: 'item',
      versions: {
        create: {
          id: 'v3',
          contentBlobId: 'blob',
          versionNumber: 1,
          filename: 'same.pdf',
          contentType: 'application/pdf',
          checksum,
          sizeBytes: 10n
        }
      }
    }
  })
  expect((await store.read('v3'))?.key).toBe(next.key)
  expect(await store.read('v2')).toBeNull()
})

it.each(['checksum', 'size'] as const)(
  'does not reuse results when PDF %s differs',
  async (changed) => {
    const { store, source } = await setupWorkspace('upload-version')
    await store.append(
      (await store.open(input, targetKey, model))!,
      0,
      '细胞',
      new AbortController().signal
    )
    const checksumValue = changed === 'checksum' ? 'c'.repeat(64) : checksum
    await client.uploadVersion.update({
      where: { id: 'version' },
      data: { checksum: checksumValue, sizeBytes: changed === 'size' ? 11n : 10n }
    })
    expect(await store.read({ ...source, checksum: checksumValue })).toBeNull()
  }
)

it('keeps the empty edition resumable and preserves earlier editions if its first paragraph cannot save', async () => {
  const { store, source } = await setupWorkspace('upload-version')
  const signal = new AbortController().signal
  const saved = await store.append((await store.open(input, targetKey, model))!, 0, '细胞', signal)
  await store.read(source)
  const replacement = (await store.open(
    { ...input, attachmentVersionId: undefined, documentSource: source },
    targetKey,
    model
  ))!
  await client.$executeRawUnsafe(
    `CREATE TRIGGER reject_new_translation BEFORE INSERT ON PdfTranslationBlock BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`
  )
  await expect(store.append(replacement, 0, '新译文', signal)).rejects.toThrow()
  expect(await store.read('v', saved.key)).toEqual(saved)
  expect(await store.read(source)).toEqual(replacement)
  expect(await client.pdfTranslation.count()).toBe(2)
  await client.$executeRawUnsafe('DROP TRIGGER reject_new_translation')
  const retried = await store.append(replacement, 0, '新译文', signal)
  expect(await store.read(source)).toEqual(retried)
})

it('links a newly imported library attachment before opening translation and retains it after project deletion', async () => {
  const { store, source } = await setupWorkspace('upload-version')
  await client.literatureAttachment.delete({ where: { id: 'a' } })
  const signal = new AbortController().signal
  const saved = await store.append(
    (await store.open(
      {
        ...input,
        attachmentVersionId: undefined,
        documentSource: source,
        layoutSnapshot: layoutSnapshot()
      },
      targetKey,
      model
    ))!,
    0,
    '细胞',
    signal
  )
  const catalog = new LiteratureCatalog(async () => client)
  const imported = await catalog.attachContent({
    itemId: 'item',
    contentBlobId: 'blob',
    filename: 'paper.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    checksum
  })
  // No translation read occurs through the library before deleting its original owner.
  await new ProjectRepository(async () => client).delete('workspace')
  expect(await store.read(imported.versionId)).toMatchObject({
    key: saved.key,
    translations: ['细胞'],
    layoutSnapshot: layoutSnapshot()
  })
  expect(await client.pdfTranslation.count()).toBe(1)
})

it.each(['timeout', 'provider-failed', 'incomplete-output'] as const)(
  'recovers pending %s after reopening SQLite and rejects stale-window skip/write decisions',
  async (reasonCode) => {
    const store = await setup()
    const signal = new AbortController().signal
    const request = { ...input, sources: ['cell', 'growth'] }
    const first = await store.append(
      (await store.open(request, targetKey, model))!,
      0,
      '细胞',
      signal
    )
    const pending = await store.append(first, 1, undefined, signal, false, {
      disposition: 'retryable',
      reasonCode,
      pageNumbers: [3],
      attempts: 2
    })
    expect(nextPdfTranslationSourceIndex(pending)).toBe(1)
    await client.$disconnect()
    client = createProjectDbClient(root)
    const reopenedStore = new PdfTranslationCheckpoints({
      getClient: async () => client,
      authority: {
        resolveVersion: async () => ({ checksum }) as ResolvedLiteratureAttachmentVersion
      }
    })
    const restored = (await reopenedStore.read('v'))!
    expect(restored.translations).toEqual(['细胞'])
    expect(restored.failures).toEqual(pending.failures)
    expect(nextPdfTranslationSourceIndex(restored)).toBe(1)
    const resumedInput = {
      ...request,
      checkpoint: { key: restored.key, revision: restored.revision }
    }
    const windowA = (await reopenedStore.open(resumedInput, targetKey, model))!
    const windowB = (await store.open(resumedInput, targetKey, model))!
    const complete = await reopenedStore.append(windowA, 1, '生长', signal)
    expect(nextPdfTranslationSourceIndex(complete)).toBe(2)
    expect(complete.failures).toEqual([])
    await expect(
      store.append(windowB, 1, undefined, signal, false, {
        disposition: 'skipped',
        reasonCode,
        pageNumbers: [3],
        attempts: 2
      })
    ).rejects.toThrow('another window')
    await expect(store.append(windowB, 1, '旧窗口结果', signal)).rejects.toThrow('another window')
    const saved = (await reopenedStore.read('v'))!
    expect(saved.translations).toEqual(['细胞', '生长'])
    expect(saved.failedSourceIndices).toEqual([])
    expect(saved.failures).toEqual([])
  }
)

it.each(['upload-version', 'artifact-version'] as const)(
  'lists and selects all %s editions across projects without merging snapshots or stale writes',
  async (kind) => {
    const { store, source } = await setupWorkspace(kind)
    const signal = new AbortController().signal
    await client.fileOriginSession.create({
      data: { projectId: 'other', sessionId: 'other-session' }
    })
    await client.uploadFile.create({
      data: {
        id: 'other-file',
        projectId: 'other',
        sessionId: 'other-session',
        filename: 'same.pdf',
        originalFilename: 'same.pdf',
        versions: {
          create: {
            id: 'other-version',
            versionNumber: 1,
            state: 'ready',
            filename: 'same.pdf',
            originalFilename: 'same.pdf',
            contentStorageKey: 'content/same.pdf',
            contentBlobId: 'blob',
            checksum,
            sizeBytes: 10n
          }
        }
      }
    })
    const other = {
      ...source,
      kind: 'upload-version' as const,
      projectId: 'other',
      sessionId: 'other-session',
      sourceFileId: 'other-file',
      versionId: 'other-version'
    }
    const request = { ...input, attachmentVersionId: undefined, documentSource: source }
    const original = await store.append(
      (await store.open({ ...request, layoutSnapshot: layoutSnapshot() }, targetKey, model))!,
      0,
      '细胞',
      signal
    )
    const second = await store.append(
      (await store.open(
        { ...request, language: 'German', glossary: [], concurrency: 4 },
        targetKey,
        model
      ))!,
      0,
      'Zelle',
      signal
    )
    const rows = await store.list(other)
    expect(rows).toHaveLength(2)
    expect(rows[0].key).toBe(second.key)
    expect(rows).toContainEqual(
      expect.objectContaining({
        key: original.key,
        language: 'Chinese',
        glossary: input.glossary,
        concurrency: 1,
        model,
        updatedAt: expect.any(Number)
      })
    )
    expect(rows).toContainEqual(
      expect.objectContaining({ key: second.key, language: 'German', glossary: [], concurrency: 4 })
    )
    expect((await store.read(other))?.key).toBe(second.key)
    expect((await store.read('v'))?.key).toBe(second.key)
    const originalId = rows.find((row) => row.key === original.key)!.id
    const secondId = rows.find((row) => row.key === second.key)!.id
    const selected = await store.select({ source: other, translationId: originalId }, signal)
    expect(selected).toMatchObject({
      key: original.key,
      documentSource: other,
      translations: ['细胞'],
      layoutSnapshot: layoutSnapshot()
    })
    expect((await store.list(other))[0].key).toBe(second.key)
    expect((await store.read(source))?.key).toBe(second.key)
    const controller = new AbortController()
    controller.abort()
    await expect(
      store.select({ source: other, translationId: secondId }, controller.signal)
    ).rejects.toThrow()
    expect((await store.read(other))?.key).toBe(second.key)
    await expect(
      store.select({ source: { ...other, projectId: 'workspace' }, translationId: originalId })
    ).rejects.toThrow('unavailable')
    await expect(store.select({ source: other, translationId: 'missing' })).rejects.toThrow(
      'unavailable'
    )
    const newer = await store.select({ source: other, translationId: secondId }, signal)
    expect(newer.layoutSnapshot).toBeUndefined()
    // Selecting in another reader does not invalidate this reader's explicit edition.
    const continued = await store.append(selected, 1, '12', signal)
    expect(continued.key).toBe(original.key)
    expect((await store.read(other))?.key).toBe(second.key)
    await expect(store.append(selected, 1, 'stale', signal)).rejects.toThrow('another window')
    expect(
      (
        await store.open(
          { ...request, checkpoint: { key: original.key, revision: continued.revision } },
          targetKey,
          model
        )
      )?.translations
    ).toEqual(['细胞', '12'])
    await new ProjectRepository(async () => client).delete('workspace')
    await client.literatureAttachment.delete({ where: { id: 'a' } })
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect(await store.list(other)).toHaveLength(2)
    expect(await store.select({ source: other, translationId: originalId })).toMatchObject({
      translations: ['细胞', '12'],
      layoutSnapshot: layoutSnapshot()
    })
    const stored = await client.pdfTranslation.findMany({ select: { pdfDocumentId: true } })
    expect(new Set(stored.map((row) => row.pdfDocumentId)).size).toBe(1)
  }
)

it('updates edition time without returning the saved payload or layout on each paragraph', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  const first = await store.append(
    (await store.open({ ...input, layoutSnapshot: layoutSnapshot() }, targetKey, model))!,
    0,
    '细胞',
    signal
  )
  const before = await client.pdfTranslation.findFirstOrThrow()
  await client.pdfTranslation.updateMany({ data: { updatedAt: new Date(0) } })
  await client.$disconnect()
  const observedClient = new PrismaClient({
    datasources: { db: { url: `file:${join(root, 'open-science.db')}?connection_limit=1` } },
    log: [{ emit: 'event', level: 'query' }]
  })
  const queries: string[] = []
  observedClient.$on('query', ({ query }) => queries.push(query))
  client = observedClient
  const second = await store.append(first, 1, '12', signal)
  // Inspect SQLite's actual statements: Prisma's default update RETURNING includes
  // every scalar column, even when the caller ignores the returned large snapshot.
  const timestampWrites = queries.filter(
    (query) =>
      query.trimStart().startsWith('UPDATE ') &&
      query.includes('PdfTranslation') &&
      query.includes('updatedAt')
  )
  expect(timestampWrites).toHaveLength(1)
  expect(timestampWrites[0]).not.toMatch(/layoutSnapshotJson|payloadJson/u)
  expect(await client.pdfTranslation.findFirstOrThrow()).toEqual({
    ...before,
    updatedAt: expect.any(Date)
  })
  expect((await store.list('v'))[0].updatedAt).toBeGreaterThan(0)
  expect(await store.read('v')).toEqual(second)
  expect(second.layoutSnapshot).toEqual(layoutSnapshot())
})

it('reports restoration costs without logging document or translation text', async () => {
  const store = await setup()
  initLogger({ logDir: root, mirrorToConsole: false, minLevel: 'debug' })
  const saved = await store.append(
    (await store.open({ ...input, layoutSnapshot: layoutSnapshot() }, targetKey, model))!,
    0,
    '细胞',
    new AbortController().signal
  )
  expect(await store.read('v')).toEqual(saved)
  await flushLogs()
  const records = (await readFile(join(root, 'main.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.msg === 'checkpoint restored')
  const report = records.at(-1)
  expect(report.level).toBe('debug')
  expect(report.data).toEqual({
    stage: 'checkpoint-read',
    storageMs: expect.any(Number),
    decodeMs: expect.any(Number),
    sourceCount: 2,
    blockCount: expect.any(Number),
    payloadChars: expect.any(Number),
    layoutSnapshotChars: expect.any(Number)
  })
  expect(report.data.storageMs).toBeGreaterThanOrEqual(0)
  expect(report.data.decodeMs).toBeGreaterThanOrEqual(0)
  expect(report.data.layoutSnapshotChars).toBeGreaterThan(0)
})

it('deletes only the authorized edition across shared sources and preserves the PDF and other editions after reopening', async () => {
  const { store, source } = await setupWorkspace('upload-version')
  const signal = new AbortController().signal
  const first = await store.append(
    (await store.open(input, targetKey, { ...model, providerName: 'Saved provider' }))!,
    0,
    '细胞',
    signal
  )
  await store.read(source)
  const second = await store.append(
    (await store.open({ ...input, language: 'German' }, targetKey, model))!,
    0,
    'Zelle',
    signal
  )
  const rows = await store.list(source)
  const firstId = rows.find(({ key }) => key === first.key)!.id
  await expect(store.delete({ source: 'v', translationId: 'missing' })).rejects.toThrow(
    'unavailable'
  )
  const aborted = new AbortController()
  aborted.abort()
  await expect(store.delete({ source, translationId: firstId }, aborted.signal)).rejects.toThrow()
  expect(await client.pdfTranslation.count()).toBe(2)
  expect(rows.find(({ key }) => key === first.key)!.model.providerName).toBe('Saved provider')
  await store.delete({ source, translationId: firstId }, signal)
  expect(await client.pdfTranslation.count()).toBe(1)
  expect(await client.pdfTranslationBlock.count({ where: { translationId: firstId } })).toBe(0)
  expect(await client.literatureAttachmentVersion.count()).toBe(1)
  expect(await client.pdfDocument.count()).toBe(1)
  await expect(store.append(first, 1, '十二', signal)).rejects.toThrow()
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect((await store.list(source)).map(({ key }) => key)).toEqual([second.key])
  expect((await store.read('v'))!.translations).toEqual(['Zelle'])
})
it('rejects deletion through a revoked source without changing saved editions', async () => {
  const store = await setup()
  await store.append(
    (await store.open(input, targetKey, model))!,
    0,
    '细胞',
    new AbortController().signal
  )
  const id = (await store.list('v'))[0].id
  await client.literatureItem.update({ where: { id: 'item' }, data: { deletedAt: new Date() } })
  await expect(store.delete({ source: 'v', translationId: id })).rejects.toThrow('unavailable')
  expect(await client.pdfTranslation.count()).toBe(1)
})

it('rejects an existing edition belonging to a different verified PDF', async () => {
  const store = await setup()
  await store.append(
    (await store.open(input, targetKey, model))!,
    0,
    '细胞',
    new AbortController().signal
  )
  const row = await client.pdfTranslation.findUniqueOrThrow({
    where: { id: (await store.list('v'))[0].id }
  })
  await client.pdfDocument.create({
    data: { id: 'other-document', checksum: 'c'.repeat(64), sizeBytes: 10n }
  })
  await client.pdfTranslation.create({
    data: {
      ...row,
      id: 'foreign-edition',
      pdfDocumentId: 'other-document',
      checksum: 'c'.repeat(64)
    }
  })
  await expect(store.delete({ source: 'v', translationId: 'foreign-edition' })).rejects.toThrow(
    'unavailable'
  )
  expect(await client.pdfTranslation.count()).toBe(2)
  expect(
    await client.pdfTranslation.findUnique({ where: { id: 'foreign-edition' } })
  ).not.toBeNull()
})

it('keeps creation order across updates and restart, and never resumes a deleted edition as the latest', async () => {
  const store = await setup()
  const signal = new AbortController().signal
  const first = await store.append((await store.open(input, targetKey, model))!, 0, '细胞', signal)
  const firstId = (await store.list('v'))[0].id
  await client.pdfTranslation.update({
    where: { id: firstId },
    data: { createdAt: new Date(1000) }
  })
  const second = await store.append(
    (await store.open(input, targetKey, model))!,
    0,
    '第二版',
    signal
  )
  const secondId = (await store.list('v'))[0].id
  await client.pdfTranslation.update({
    where: { id: secondId },
    data: { createdAt: new Date(2000) }
  })
  const selected = await store.select({ source: 'v', translationId: firstId })
  const continued = await store.append(selected, 1, '12', signal)
  expect((await store.list('v')).map(({ id }) => id)).toEqual([secondId, firstId])
  expect(
    (await client.pdfTranslation.findUniqueOrThrow({ where: { id: firstId } })).createdAt
  ).toEqual(new Date(1000))
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect((await store.read('v'))?.key).toBe(second.key)
  expect(await store.read('v', first.key)).toEqual(continued)
  await store.delete({ source: 'v', translationId: secondId })
  expect((await store.read('v'))?.key).toBe(first.key)
  await expect(
    store.open(
      { ...input, checkpoint: { key: second.key, revision: second.revision } },
      targetKey,
      model
    )
  ).rejects.toThrow('another window')
  expect(await store.read('v', second.key)).toBeNull()
  await store.delete({ source: 'v', translationId: firstId })
  expect(await store.read('v')).toBeNull()
})
