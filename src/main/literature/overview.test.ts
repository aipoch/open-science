import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginMigration, endMigration } from '../storage/migration-state'
import { describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { LiteratureOverviewService, LiteratureOverviewStore } from './overview'
import {
  literatureOverviewRequestSchema,
  literatureOverviewResultSchema,
  literatureOverviewSource,
  literatureOverviewSectionsSchema,
  type LiteratureOverview
} from '../../shared/literature-overview'

const { failureLog } = vi.hoisted(() => ({ failureLog: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/diagnostics/node')>()
  return {
    ...actual,
    createLogger: (scope: string) =>
      scope === 'literature-overview'
        ? { ...actual.createLogger(scope), warn: failureLog }
        : actual.createLogger(scope)
  }
})

const request = { itemId: 'paper', expectedSourceKey: 'source-key', language: 'zh-Hans' }
const sections = {
  question: 'What works?',
  population: null,
  methods: 'Comparison',
  results: 'Mixed results',
  limitations: null
}
const paper = (): LiteratureItemView => ({
  id: 'paper',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Paper',
    abstract: 'A comparison found mixed results.'
  }),
  attachments: [],
  collectionIds: [],
  projectIds: []
})
function fixture(item = paper()): {
  item: LiteratureItemView
  request: typeof request
  get: ReturnType<typeof vi.fn>
  reader: { classificationEvidence: ReturnType<typeof vi.fn> }
  infer: ReturnType<typeof vi.fn>
  owner: LiteratureOverviewService
} {
  const get = vi.fn(async () => structuredClone(item))
  const reader = {
    classificationEvidence: vi.fn().mockResolvedValue({
      coverage: 'full-text',
      passages: [{ pageStart: 1, pageEnd: 2, content: 'Full paper evidence' }]
    })
  }
  const infer = vi.fn().mockResolvedValue({ text: JSON.stringify(sections), model: 'test-model' })
  return {
    item,
    request: { ...request, expectedSourceKey: literatureOverviewSource(item).key },
    get,
    reader,
    infer,
    owner: new LiteratureOverviewService({ catalog: { get }, reader, infer })
  }
}
function withPdf(item = paper()): LiteratureItemView {
  item.attachments = [
    {
      id: 'attachment',
      kind: 'fullText',
      title: '',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      versions: [
        {
          id: 'version',
          versionNumber: 1,
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 200,
          checksum: 'a'.repeat(64),
          createdAt: 1
        }
      ]
    }
  ]
  return item
}

describe('single-paper study overview', () => {
  it('summarizes the abstract using the interface language and preserves missing fields', async () => {
    const f = fixture()
    expect(await f.owner.run(f.request)).toMatchObject({
      sourceKey: f.request.expectedSourceKey,
      coverage: 'abstract',
      model: 'test-model',
      sections
    })
    expect(f.reader.classificationEvidence).not.toHaveBeenCalled()
    const input = f.infer.mock.calls[0][0]
    expect(JSON.parse(input.prompt)).toMatchObject({
      language: 'zh-Hans',
      coverage: 'abstract',
      abstract: f.item.item.abstract,
      passages: []
    })
  })
  it.each(['full-text', 'passages'] as const)(
    'reuses PDF reading and accurately reports %s coverage',
    async (coverage) => {
      const f = fixture(withPdf())
      f.reader.classificationEvidence.mockResolvedValue({
        coverage,
        passages: [{ pageStart: 2, pageEnd: 3, content: 'Evidence' }]
      })
      expect(await f.owner.run(f.request)).toMatchObject({
        coverage,
        attachmentVersionId: 'version'
      })
      expect(f.reader.classificationEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentId: 'attachment',
          attachmentVersionId: 'version',
          checksum: 'a'.repeat(64)
        })
      )
      expect(f.infer.mock.calls[0][0].prompt).toContain('Evidence')
    }
  )
  it('falls back to the abstract when PDF reading fails', async () => {
    const f = fixture(withPdf())
    f.reader.classificationEvidence.mockRejectedValue(new Error('Missing content'))
    expect(await f.owner.run(f.request)).toMatchObject({ coverage: 'abstract' })
  })
  it.each([
    ['empty passages', 'full-text', []],
    ['whitespace passages', 'passages', [{ pageStart: 1, pageEnd: 2, content: '  \n  ' }]],
    [
      'unavailable passages',
      'unavailable',
      [{ pageStart: 1, pageEnd: 2, content: 'Unusable cached evidence' }]
    ]
  ])(
    'retains abstract coverage when the PDF supplies no usable evidence: %s',
    async (_label, coverage, passages) => {
      const f = fixture(withPdf())
      f.reader.classificationEvidence.mockResolvedValue({ coverage, passages })
      const result = await f.owner.run(f.request)
      expect(result).toMatchObject({ coverage: 'abstract' })
      if ('issue' in result) throw new Error('Expected an abstract overview.')
      expect(result.attachmentVersionId).toBeUndefined()
      expect(JSON.parse(f.infer.mock.calls[0][0].prompt)).toMatchObject({
        abstract: f.item.item.abstract,
        passages: []
      })
    }
  )
  it('does not use supplementary PDFs as the study full text', async () => {
    const item = withPdf()
    item.attachments[0].kind = 'supplementary'
    const f = fixture(item)
    expect(await f.owner.run(f.request)).toMatchObject({ coverage: 'abstract' })
    expect(f.reader.classificationEvidence).not.toHaveBeenCalled()
  })
  it('reports missing evidence without calling the model', async () => {
    const f = fixture()
    f.item.item.abstract = ''
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'source-unavailable' })
    expect(f.infer).not.toHaveBeenCalled()
  })
  it('reports stale metadata before model work', async () => {
    const f = fixture()
    await expect(f.owner.run({ ...f.request, expectedSourceKey: 'stale-source' })).resolves.toEqual(
      { sourceKey: 'stale-source', issue: 'source-changed' }
    )
    expect(f.infer).not.toHaveBeenCalled()
  })
  it('reports deleted or edited references after generation', async () => {
    const f = fixture()
    f.infer.mockImplementation(async () => {
      f.item.metadataRevision++
      return { text: JSON.stringify(sections), model: 'test' }
    })
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'source-changed' })
  })
  it('honors cancellation and does not start inference', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(f.owner.run(f.request, controller.signal)).rejects.toThrow()
    expect(f.infer).not.toHaveBeenCalled()
  })
  it.each([
    'not JSON',
    JSON.stringify({ ...sections, results: [] }),
    JSON.stringify({ ...sections, extra: 'not allowed' })
  ])('rejects malformed model output and permits retry', async (text) => {
    const f = fixture()
    f.infer.mockResolvedValueOnce({ text, model: 'test' })
    await expect(f.owner.run(f.request)).rejects.toThrow()
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ sections })
  })
  it.each([
    ['   ', 'json', 'empty-response'],
    ['PRIVATE_RESPONSE', 'json', 'invalid-json'],
    [
      JSON.stringify({ ...sections, results: ['PRIVATE_RESPONSE'] }),
      'validation',
      'invalid-sections'
    ]
  ])('records only bounded failure metadata for %s', async (text, stage, category) => {
    failureLog.mockClear()
    const f = fixture()
    f.infer.mockResolvedValueOnce({ text, model: 'PRIVATE_MODEL_VALUE' })
    await expect(f.owner.run(f.request)).rejects.toThrow()
    expect(failureLog).toHaveBeenCalledExactlyOnceWith('Paper overview generation failed', {
      stage,
      category,
      responseBytes: Buffer.byteLength(text.trim(), 'utf8')
    })
    expect(JSON.stringify(failureLog.mock.calls)).not.toContain('PRIVATE_')
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ sections })
  })
  it.each(['tool-violation', 'PRIVATE_EXCEPTION_CODE'])(
    'keeps the original inference error while sanitizing its code %s',
    async (code) => {
      failureLog.mockClear()
      const f = fixture()
      const error = Object.assign(new Error('PRIVATE_EXCEPTION_MESSAGE'), { code })
      f.infer.mockRejectedValueOnce(error)
      await expect(f.owner.run(f.request)).rejects.toBe(error)
      expect(failureLog.mock.calls[0][1]).toEqual({
        stage: 'inference',
        category: code === 'tool-violation' ? code : 'operation-failed',
        responseBytes: undefined
      })
      expect(JSON.stringify(failureLog.mock.calls)).not.toContain('PRIVATE_')
    }
  )
  it('uses a current PDF after a non-PDF full-text attachment', async () => {
    const item = withPdf()
    const invalid = structuredClone(item.attachments[0])
    invalid.id = 'non-pdf'
    invalid.sortOrder = 0
    invalid.versions[0].contentType = 'text/plain'
    item.attachments[0].sortOrder = 1
    item.attachments.unshift(invalid)
    item.item.abstract = ''
    const f = fixture(item)
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ coverage: 'full-text' })
  })
  it('keeps results when only attachment availability or supplementary metadata changes', async () => {
    const f = fixture(withPdf())
    f.infer.mockImplementation(async () => {
      f.item.attachments[0].versions[0].availability = 'available'
      const supplementary = structuredClone(f.item.attachments[0])
      supplementary.id = 'supplement'
      supplementary.kind = 'supplementary'
      f.item.attachments.push(supplementary)
      return { text: JSON.stringify(sections), model: 'test' }
    })
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ sections })
  })
  it('rejects cancellation while checking the final source state', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.get.mockImplementationOnce(async () => structuredClone(f.item))
    f.get.mockImplementationOnce(async () => {
      controller.abort()
      return structuredClone(f.item)
    })
    await expect(f.owner.run(f.request, controller.signal)).rejects.toThrow()
  })
  it('reports a replaced PDF before inference even when metadata revision is unchanged', async () => {
    const f = fixture(withPdf())
    f.item.attachments[0].versions[0].id = 'new-version'
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'source-changed' })
    expect(f.infer).not.toHaveBeenCalled()
  })
  it('reports replaced PDF bytes after inference even when metadata revision is unchanged', async () => {
    const f = fixture(withPdf())
    f.infer.mockImplementation(async () => {
      f.item.attachments[0].versions[0].checksum = 'b'.repeat(64)
      return { text: JSON.stringify(sections), model: 'test' }
    })
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'source-changed' })
  })
  it('does not resurrect an older PDF when the latest version is not a PDF', async () => {
    const item = withPdf()
    item.item.abstract = ''
    item.attachments[0].versions.push({
      ...item.attachments[0].versions[0],
      id: 'v2',
      versionNumber: 2,
      contentType: 'text/plain'
    })
    const f = fixture(item)
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'source-unavailable' })
    expect(f.reader.classificationEvidence).not.toHaveBeenCalled()
    expect(f.infer).not.toHaveBeenCalled()
  })
  it('does not start PDF reading when cancellation arrives during the initial catalog read', async () => {
    const f = fixture(withPdf())
    const controller = new AbortController()
    f.get.mockImplementationOnce(async () => {
      controller.abort()
      return structuredClone(f.item)
    })
    await expect(f.owner.run(f.request, controller.signal)).rejects.toThrow()
    expect(f.reader.classificationEvidence).not.toHaveBeenCalled()
    expect(f.infer).not.toHaveBeenCalled()
  })
  it('stops before inference when cancellation arrives during PDF reading', async () => {
    const f = fixture(withPdf())
    const controller = new AbortController()
    f.reader.classificationEvidence.mockImplementation(async () => {
      controller.abort()
      return {
        coverage: 'full-text',
        passages: [{ pageStart: 1, pageEnd: 2, content: 'Evidence' }]
      }
    })
    await expect(f.owner.run(f.request, controller.signal)).rejects.toThrow()
    expect(f.infer).not.toHaveBeenCalled()
  })
  it.each([
    ['ASCII', 'x'.repeat(60_001)],
    ['UTF-8', '研'.repeat(20_001)]
  ])(
    'reports oversized input before model work without silently truncating evidence (%s)',
    async (_label, abstract) => {
      const item = paper()
      item.item.abstract = abstract
      const f = fixture(item)
      await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'input-too-large' })
      expect(f.infer).not.toHaveBeenCalled()
    }
  )
  it.each(['initial-read', 'pdf', 'inference', 'persist', 'final-read'])(
    'rejects duplicate generation while the first request is in %s without sharing cancellation',
    async (stage) => {
      const f = fixture(withPdf())
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let entered = false
      let reads = 0
      const wait = async (): Promise<void> => {
        entered = true
        await gate
      }
      const infer = vi.fn(async () => {
        if (stage === 'inference') await wait()
        return { text: JSON.stringify(sections), model: 'test' }
      })
      const write = vi.fn(async () => {
        if (stage === 'persist') await wait()
      })
      const owner = new LiteratureOverviewService({
        catalog: {
          get: async () => {
            reads++
            if (
              (stage === 'initial-read' && reads === 1) ||
              (stage === 'final-read' && reads === 3)
            )
              await wait()
            return structuredClone(f.item)
          }
        },
        reader: {
          classificationEvidence: async () => {
            if (stage === 'pdf') await wait()
            return {
              coverage: 'full-text',
              passages: [{ pageStart: 1, pageEnd: 1, content: 'Evidence' }]
            }
          }
        },
        infer,
        store: { read: async () => undefined, write }
      })
      const first = owner.run(f.request)
      try {
        await vi.waitFor(() => expect(entered).toBe(true))
        const duplicate = new AbortController()
        await expect(owner.run(f.request, duplicate.signal)).resolves.toEqual({
          sourceKey: f.request.expectedSourceKey,
          issue: 'busy'
        })
        duplicate.abort()
      } finally {
        release()
        await first
      }
      expect(infer).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledTimes(1)
      await expect(owner.run(f.request)).resolves.toMatchObject({ sections })
    }
  )
  it.each(['item', 'source', 'language'])(
    'admits concurrent generation when the %s identity differs',
    async (identity) => {
      const f = fixture()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      f.infer.mockImplementation(async () => {
        await gate
        return { text: JSON.stringify(sections), model: 'test' }
      })
      const first = f.owner.run(f.request)
      let second: ReturnType<typeof f.owner.run> | undefined
      try {
        await vi.waitFor(() => expect(f.infer).toHaveBeenCalledTimes(1))
        if (identity === 'item') f.item.id = 'other-paper'
        if (identity === 'source') f.item.metadataRevision++
        second = f.owner.run({
          ...f.request,
          itemId: f.item.id,
          expectedSourceKey: literatureOverviewSource(f.item).key,
          language: identity === 'language' ? 'ja' : f.request.language
        })
        await vi.waitFor(() => expect(f.infer).toHaveBeenCalledTimes(2))
      } finally {
        release()
        await Promise.all([first, second])
      }
    }
  )
  it('bounds concurrent inference and releases admission after completion', async () => {
    const f = fixture()
    let finish!: (result: { text: string; model: string }) => void
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    f.infer.mockReturnValue(pending)
    const running = Array.from({ length: 4 }, (_, index) =>
      f.owner.run({ ...f.request, language: `language-${index}` })
    )
    let fifth: Promise<string> | undefined
    try {
      await vi.waitFor(() => expect(f.infer).toHaveBeenCalledTimes(4))
      fifth = f.owner.run(f.request).then(
        (result) => ('issue' in result ? result.issue : 'accepted'),
        (error: Error) => error.message
      )
      await Promise.resolve()
      expect(f.infer).toHaveBeenCalledTimes(4)
      expect(await fifth).toContain('busy')
    } finally {
      finish({ text: JSON.stringify(sections), model: 'test' })
      await Promise.all([...running, fifth])
    }
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ sections })
  })
  it.each(['inference-rejection', 'invalid-response', 'source-unavailable', 'aborted'])(
    'releases every admission slot after %s so later requests remain usable',
    async (failure) => {
      const f = fixture()
      const controller = new AbortController()
      if (failure === 'inference-rejection') f.infer.mockRejectedValue(new Error('Offline'))
      if (failure === 'invalid-response')
        f.infer.mockResolvedValue({ text: 'invalid JSON', model: 'test' })
      if (failure === 'source-unavailable') f.item.item.abstract = ''
      if (failure === 'aborted') controller.abort()
      const attempts = []
      for (let i = 0; i < 4; i++)
        attempts.push(...(await Promise.allSettled([f.owner.run(f.request, controller.signal)])))
      if (failure === 'source-unavailable') {
        for (const attempt of attempts)
          expect(attempt).toMatchObject({
            status: 'fulfilled',
            value: { issue: 'source-unavailable' }
          })
      } else {
        expect(attempts.every((attempt) => attempt.status === 'rejected')).toBe(true)
      }
      f.item.item.abstract = 'A comparison found mixed results.'
      f.infer.mockResolvedValue({ text: JSON.stringify(sections), model: 'test' })
      await expect(f.owner.run(f.request)).resolves.toMatchObject({ sections })
    }
  )
  it.each([{ deletedAt: 0 }, { deletedAt: 1 }, { mergedIntoItemId: 'survivor' }])(
    'reports an inactive reference before source reading: %j',
    async (inactive) => {
      const f = fixture({ ...withPdf(), ...inactive })
      await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'source-changed' })
      expect(f.reader.classificationEvidence).not.toHaveBeenCalled()
      expect(f.infer).not.toHaveBeenCalled()
    }
  )
  it.each([{ deletedAt: 0 }, { deletedAt: 1 }, { mergedIntoItemId: 'survivor' }])(
    'reports a reference deactivated during inference without a metadata revision change: %j',
    async (inactive) => {
      const f = fixture()
      f.infer.mockImplementation(async () => {
        Object.assign(f.item, inactive)
        return { text: JSON.stringify(sections), model: 'test' }
      })
      await expect(f.owner.run(f.request)).resolves.toMatchObject({ issue: 'source-changed' })
    }
  )
  it.each([
    ['quotes', '"'],
    ['backslashes', '\\']
  ])('admits bounded escape-heavy passages with one encoding (%s)', async (_label, character) => {
    const f = fixture(withPdf())
    const passages = [{ pageStart: 1, pageEnd: 2, content: character.repeat(16_000) }]
    f.reader.classificationEvidence.mockResolvedValue({ coverage: 'passages', passages })
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ coverage: 'passages' })
    const input = JSON.parse(f.infer.mock.calls[0][0].prompt)
    expect(input.passages).toEqual(passages)
    expect(input.abstract).toBe(f.item.item.abstract)
  })
  it('accepts a fenced JSON response', async () => {
    const f = fixture()
    f.infer.mockResolvedValue({
      text: '```json\n' + JSON.stringify(sections) + '\n```',
      model: 'test'
    })
    await expect(f.owner.run(f.request)).resolves.toMatchObject({ sections })
  })
  it.each(['busy', 'source-changed', 'source-unavailable', 'input-too-large'])(
    'validates a source-bound business outcome: %s',
    (issue) => {
      expect(
        literatureOverviewResultSchema.safeParse({ sourceKey: 'source-key', issue }).success
      ).toBe(true)
      expect(literatureOverviewResultSchema.safeParse({ sourceKey: '', issue }).success).toBe(false)
      expect(
        literatureOverviewResultSchema.safeParse({
          sourceKey: 'source-key',
          issue,
          coverage: 'abstract',
          model: 'test',
          sections
        }).success
      ).toBe(false)
    }
  )
  it('rejects unknown issue codes at the result boundary', () => {
    expect(
      literatureOverviewResultSchema.safeParse({
        sourceKey: 'source-key',
        issue: 'unexpected-issue'
      }).success
    ).toBe(false)
  })
  it('does not let model output masquerade as an application issue', async () => {
    const f = fixture()
    f.infer.mockResolvedValue({ text: JSON.stringify({ issue: 'source-changed' }), model: 'test' })
    await expect(f.owner.run(f.request)).rejects.toThrow()
  })
  it('validates request boundaries and requires all five output fields', () => {
    expect(literatureOverviewRequestSchema.safeParse({ ...request, itemId: '' }).success).toBe(
      false
    )
    expect(
      literatureOverviewRequestSchema.safeParse({ ...request, language: 'x'.repeat(65) }).success
    ).toBe(false)
    expect(
      literatureOverviewRequestSchema.safeParse({ ...request, prompt: 'override' }).success
    ).toBe(false)
    expect(literatureOverviewSectionsSchema.safeParse({ question: 'Only question' }).success).toBe(
      false
    )
  })
})

describe('saved study overviews', () => {
  it('restores across owners without PDF or model work, invalidates source/language, and preserves the last success on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'study-overviews-'))
    try {
      const f = fixture()
      const infer = vi.fn(async () => ({ text: JSON.stringify(sections), model: 'test' }))
      const reader = {
        classificationEvidence: vi.fn(async () => ({
          coverage: 'unavailable' as const,
          passages: []
        }))
      }
      const options = { catalog: { get: async () => f.item }, reader, infer }
      const owner = new LiteratureOverviewService({
        ...options,
        store: new LiteratureOverviewStore(() => root)
      })
      const generated = await owner.run(f.request)
      const [savedFile] = await readdir(root)
      expect(JSON.parse(await readFile(join(root, savedFile), 'utf8'))).toEqual({
        version: 1,
        snapshot: generated
      })
      const restored = new LiteratureOverviewService({
        ...options,
        store: new LiteratureOverviewStore(() => root)
      })
      infer.mockClear()
      expect(await restored.run({ ...f.request, mode: 'read' })).toEqual(generated)
      expect(infer).not.toHaveBeenCalled()
      expect(reader.classificationEvidence).not.toHaveBeenCalled()
      expect(await restored.run({ ...f.request, mode: 'read', language: 'ja' })).toMatchObject({
        issue: 'not-generated'
      })
      infer.mockRejectedValueOnce(new Error('Offline'))
      await expect(restored.run(f.request)).rejects.toThrow('Offline')
      expect(await restored.run({ ...f.request, mode: 'read' })).toEqual(generated)
      f.item.metadataRevision++
      expect(await restored.run({ ...f.request, mode: 'read' })).toMatchObject({
        issue: 'source-changed'
      })
      expect(
        await restored.run({
          ...f.request,
          expectedSourceKey: literatureOverviewSource(f.item).key,
          mode: 'read'
        })
      ).toMatchObject({ issue: 'not-generated' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('does not overwrite a newer saved overview when the source changes during inference', async () => {
    const f = fixture()
    let saved: LiteratureOverview | undefined
    const owner = new LiteratureOverviewService({
      catalog: { get: async () => structuredClone(f.item) },
      reader: {
        classificationEvidence: async () => {
          throw new Error('No PDF')
        }
      },
      infer: async () => {
        f.item.metadataRevision++
        // A second generation for the edited reference has already saved its result.
        saved = {
          sourceKey: literatureOverviewSource(f.item).key,
          coverage: 'abstract',
          model: 'newer-model',
          sections
        }
        return { text: JSON.stringify(sections), model: 'old-model' }
      },
      store: {
        read: async (request) =>
          saved?.sourceKey === request.expectedSourceKey ? saved : undefined,
        write: async (_request, overview) => {
          saved = overview
        }
      }
    })
    expect(await owner.run(f.request)).toMatchObject({ issue: 'source-changed' })
    expect(
      await owner.run({
        ...f.request,
        expectedSourceKey: literatureOverviewSource(f.item).key,
        mode: 'read'
      })
    ).toMatchObject({ model: 'newer-model' })
  })
  it.each(['metadata', 'deleted', 'pdf'])(
    'rejects results when %s changes during persistence',
    async (change) => {
      const f = fixture(withPdf())
      const owner = new LiteratureOverviewService({
        catalog: { get: async () => structuredClone(f.item) },
        reader: {
          classificationEvidence: async () => ({
            coverage: 'full-text',
            passages: [{ pageStart: 1, pageEnd: 2, content: 'Study evidence' }]
          })
        },
        infer: async () => ({ text: JSON.stringify(sections), model: 'test' }),
        store: {
          read: async () => undefined,
          write: async () => {
            if (change === 'metadata') f.item.metadataRevision++
            if (change === 'deleted') f.item.deletedAt = 1
            if (change === 'pdf') f.item.attachments[0].versions[0].checksum = 'b'.repeat(64)
          }
        }
      })
      await expect(owner.run(f.request)).resolves.toMatchObject({ issue: 'source-changed' })
    }
  )
  it('restores saved results while all inference slots are occupied without changing generation admission', async () => {
    const f = fixture()
    let finish!: (value: { text: string; model: string }) => void
    const pending = new Promise<{ text: string; model: string }>((resolve) => {
      finish = resolve
    })
    const infer = vi.fn(() => pending)
    const saved = {
      sourceKey: f.request.expectedSourceKey,
      coverage: 'abstract' as const,
      model: 'saved-model',
      sections
    }
    const owner = new LiteratureOverviewService({
      catalog: { get: async () => structuredClone(f.item) },
      reader: {
        classificationEvidence: async () => {
          throw new Error('No PDF')
        }
      },
      infer,
      store: { read: async () => saved, write: async () => undefined }
    })
    for (let i = 0; i < 4; i++)
      expect(await owner.run({ ...f.request, mode: 'read' })).toEqual(saved)
    let fifth: ReturnType<typeof owner.run> | undefined
    const running = Array.from({ length: 4 }, (_, index) =>
      owner.run({ ...f.request, language: `language-${index}` })
    )
    try {
      await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(4))
      expect(await owner.run({ ...f.request, mode: 'read' })).toEqual(saved)
      fifth = owner.run(f.request)
      await Promise.resolve()
      await Promise.resolve()
      expect(infer).toHaveBeenCalledTimes(4)
      expect(await fifth).toMatchObject({ issue: 'busy' })
    } finally {
      finish({ text: JSON.stringify(sections), model: 'test' })
      await Promise.all([...running, fifth])
    }
  })
  it('reports save failures, keeps the previous overview, and releases all generation slots', async () => {
    const f = fixture()
    let fail = true
    let saved: LiteratureOverview = {
      sourceKey: f.request.expectedSourceKey,
      coverage: 'abstract',
      model: 'previous-model',
      sections
    }
    const persistenceError = new Error('PRIVATE_STORAGE_ERROR')
    failureLog.mockClear()
    const owner = new LiteratureOverviewService({
      catalog: { get: async () => structuredClone(f.item) },
      reader: {
        classificationEvidence: async () => {
          throw new Error('No PDF')
        }
      },
      infer: async () => ({ text: JSON.stringify(sections), model: 'fresh-model' }),
      store: {
        read: async () => saved,
        write: async (_request, overview) => {
          if (fail) throw persistenceError
          saved = overview
        }
      }
    })
    const attempts = []
    for (let i = 0; i < 4; i++) attempts.push(...(await Promise.allSettled([owner.run(f.request)])))
    expect(
      attempts.every(
        (attempt) => attempt.status === 'rejected' && attempt.reason === persistenceError
      )
    ).toBe(true)
    expect(failureLog).toHaveBeenCalledWith('Paper overview generation failed', {
      stage: 'persist',
      category: 'operation-failed',
      responseBytes: Buffer.byteLength(JSON.stringify(sections), 'utf8')
    })
    expect(JSON.stringify(failureLog.mock.calls)).not.toContain('PRIVATE_STORAGE_ERROR')
    expect(await owner.run({ ...f.request, mode: 'read' })).toMatchObject({
      model: 'previous-model'
    })
    fail = false
    expect(await owner.run(f.request)).toMatchObject({ model: 'fresh-model' })
    expect(await owner.run({ ...f.request, mode: 'read' })).toMatchObject({ model: 'fresh-model' })
  })
  it.each(['write', 'final-read'])(
    'does not publish after cancellation during %s',
    async (stage) => {
      const f = fixture()
      const controller = new AbortController()
      let reads = 0
      const owner = new LiteratureOverviewService({
        catalog: {
          get: async () => {
            reads++
            if (stage === 'final-read' && reads === 3) controller.abort()
            return structuredClone(f.item)
          }
        },
        reader: {
          classificationEvidence: async () => {
            throw new Error('No PDF')
          }
        },
        infer: async () => ({ text: JSON.stringify(sections), model: 'test' }),
        store: {
          read: async () => undefined,
          write: async () => {
            if (stage === 'write') controller.abort()
          }
        }
      })
      await expect(owner.run(f.request, controller.signal)).rejects.toThrow()
      // Cancelling the write must stop before any additional catalog operation.
      expect(reads).toBe(stage === 'write' ? 2 : 3)
    }
  )
  it.each(['metadata', 'deleted', 'pdf'])(
    'rejects a saved overview if %s changes while restoring it',
    async (change) => {
      const f = fixture(withPdf())
      const saved: LiteratureOverview = {
        sourceKey: f.request.expectedSourceKey,
        coverage: 'full-text',
        model: 'saved-model',
        sections
      }
      const infer = vi.fn(async () => ({ text: JSON.stringify(sections), model: 'test' }))
      const owner = new LiteratureOverviewService({
        catalog: { get: async () => structuredClone(f.item) },
        reader: {
          classificationEvidence: async () => {
            throw new Error('Must not read PDF')
          }
        },
        infer,
        store: {
          write: async () => undefined,
          read: async () => {
            if (change === 'metadata') f.item.metadataRevision++
            if (change === 'deleted') f.item.deletedAt = 1
            if (change === 'pdf') f.item.attachments[0].versions[0].checksum = 'b'.repeat(64)
            return saved
          }
        }
      })
      expect(await owner.run({ ...f.request, mode: 'read' })).toMatchObject({
        issue: 'source-changed'
      })
      expect(infer).not.toHaveBeenCalled()
    }
  )
  it('guards saved-result reads and writes during data migration', async () => {
    const store = new LiteratureOverviewStore(() => {
      throw new Error('Must not resolve a migrating root')
    })
    beginMigration()
    try {
      await expect(store.read(request)).rejects.toThrow(/moving your data/i)
      await expect(
        store.write(request, { sourceKey: 'source', coverage: 'abstract', model: 'test', sections })
      ).rejects.toThrow(/moving your data/i)
    } finally {
      endMigration()
    }
  })
})
