import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { literatureSnapshotSource } from '../../shared/literature-snapshot'
import { composeApplicationRuntime, type ApplicationRuntime } from '../application-runtime'

const mocks = vi.hoisted(() => {
  const capture = (): ReturnType<typeof vi.fn> =>
    vi.fn(function (...args: unknown[]) {
      return { args }
    })
  return {
    dataRoot: '',
    db: { pdfAnnotation: { findMany: vi.fn() }, literatureItem: { findMany: vi.fn() } },
    getDb: vi.fn(),
    tagRepository: capture(),
    tagResourceCatalog: capture(),
    tagService: capture().mockImplementation(function () {
      return { notifyAssignmentsChanged: mocks.notifyTags, removeResources: mocks.removeTags }
    }),
    notifyTags: vi.fn(),
    removeTags: vi.fn(),
    memoryRepository: capture(),
    memoryService: capture(),
    screening: vi.fn(),
    startScreening: vi.fn(),
    disposeScreening: vi.fn(),
    journal: capture().mockImplementation(function () {
      return { referencesChanged: mocks.referencesChanged }
    }),
    referencesChanged: vi.fn(),
    catalog: capture().mockImplementation(function () {
      return { get: mocks.getItem }
    }),
    getItem: vi.fn(),
    runner: capture().mockImplementation(function () {
      return { run: mocks.run, sweepStaleProfiles: mocks.sweep, shutdown: mocks.shutdown }
    }),
    run: vi.fn(),
    sweep: vi.fn(),
    shutdown: vi.fn(),
    styles: capture(),
    formatter: capture(),
    citationDocument: capture(),
    referenceResolver: capture(),
    metadata: capture(),
    related: capture(),
    publication: capture(),
    supplementFinder: capture(),
    supplements: capture(),
    fullText: capture(),
    pdfImporter: capture(),
    collector: capture(),
    acquisition: capture(),
    batch: capture().mockImplementation(function () {
      return { close: mocks.closeBatch }
    }),
    closeBatch: vi.fn(),
    download: vi.fn(),
    tunnel: vi.fn(),
    resolveProxy: vi.fn(),
    parseProxy: vi.fn(),
    decrypt: vi.fn(),
    fetch: vi.fn(),
    pageCount: vi.fn(),
    cleanupWarn: vi.fn()
  }
})
vi.mock('../storage-root', () => ({ resolveDataRoot: () => mocks.dataRoot }))
vi.mock('../projects/prisma-client', () => ({ getProjectDbClient: mocks.getDb }))
vi.mock('../tags/repository', () => ({ TagRepository: mocks.tagRepository }))
vi.mock('../tags/resource-catalog', () => ({ TagResourceCatalog: mocks.tagResourceCatalog }))
vi.mock('../tags/service', () => ({ TagService: mocks.tagService }))
vi.mock('../memory/repository', () => ({ MemoryRepository: mocks.memoryRepository }))
vi.mock('../memory/service', () => ({ MemoryService: mocks.memoryService }))
vi.mock('../literature/screening-adapter', () => ({ createLiteratureScreening: mocks.screening }))
vi.mock('../literature/journal-attributes', () => ({ JournalAttributes: mocks.journal }))
vi.mock('../literature/catalog', () => ({ LiteratureCatalog: mocks.catalog }))
vi.mock('../acp/restricted-inference-runner', () => ({ RestrictedInferenceRunner: mocks.runner }))
vi.mock('../runtime-metadata', () => ({ runtimeMetadata: () => ({ version: '1.2.3-test' }) }))
vi.mock('@aipoch/literature-citations/styles', () => ({
  LiteratureCitationStyleLibrary: mocks.styles
}))
vi.mock('@aipoch/literature-citations', () => ({ LiteratureCitationFormatter: mocks.formatter }))
vi.mock('../literature/citation-document', () => ({
  LiteratureCitationDocument: mocks.citationDocument
}))
vi.mock('@aipoch/literature-discovery', () => ({
  LiteratureBatchJobs: mocks.batch,
  LiteratureFullTextFinder: mocks.fullText,
  LiteratureRelatedFinder: mocks.related,
  LiteratureSupplementFinder: mocks.supplementFinder,
  LiteraturePublicationChecker: mocks.publication,
  LiteratureMetadataEnricher: mocks.metadata,
  LiteratureReferenceResolver: mocks.referenceResolver
}))
vi.mock('@aipoch/literature-discovery/download', () => ({ downloadFullText: mocks.download }))
vi.mock('@aipoch/notebook-network-sandbox', () => ({ tunnelThroughProxy: mocks.tunnel }))
vi.mock('../literature/supplement-attachments', () => ({
  LiteratureSupplementAttachments: mocks.supplements
}))
vi.mock('../literature/pdf-importer', () => ({ LiteraturePdfImporter: mocks.pdfImporter }))
vi.mock('../literature/collector', () => ({ LiteratureCollector: mocks.collector }))
vi.mock('../literature/agent-pdf-acquisition', () => ({ AgentPdfAcquisition: mocks.acquisition }))
vi.mock('../literature/discovery-adapters', () => ({ discoveryJobOptions: { concurrency: 2 } }))
vi.mock('../network-fetch', () => ({ netFetchStandard: mocks.fetch }))
vi.mock('../runtime-network', () => ({
  runtimeNetwork: () => ({ resolveProxy: mocks.resolveProxy })
}))
vi.mock('../settings/crypto', () => ({ tryDecryptKey: mocks.decrypt }))
vi.mock('../settings/system-proxy', () => ({ parseSystemProxyRules: mocks.parseProxy }))
vi.mock('../uploads/attachment-media', () => ({ inspectPdfPageCount: mocks.pageCount }))
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => ({ warn: mocks.cleanupWarn, error: vi.fn() })
}))

import { composeResearchCatalog } from './research-catalog'

type Dependencies = Parameters<typeof composeResearchCatalog>[0]
const roots: string[] = []
const sections = {
  question: 'Question',
  population: null,
  methods: 'Methods',
  results: 'Results',
  limitations: null
}
const createDependencies = vi.fn(() => ({
  applicationEvents: { publish: vi.fn() },
  settingsService: {
    classification: { classify: vi.fn() },
    listSkills: vi.fn().mockResolvedValue([{ id: 'skill' }]),
    listConnectors: vi.fn().mockResolvedValue([{ id: 'connector' }]),
    resolveExplicitAgentBackend: vi.fn().mockResolvedValue({ resolved: true }),
    captureActiveExplicitAgentBackendTarget: vi.fn().mockResolvedValue({ id: 'initial-model' }),
    getConnectors: vi.fn().mockResolvedValue({
      semanticScholarApiKeyRef: 'semantic-ref',
      openAlexApiKeyRef: 'openalex-ref',
      contactEmail: 'research@example.test'
    })
  },
  uploadRepository: {},
  contentRepository: {},
  configRoot: '/config/research-test',
  sessionPersistenceCoordinator: {
    withLiteratureAttachmentRemoval: vi.fn(async (remove: () => Promise<void>) => remove())
  },
  pdfAnnotationTagEvents: {} as { notify?: () => Promise<void> },
  pdfAnnotationRepository: {},
  pdfAnnotationService: { setTagAssignment: vi.fn() },
  literatureContextLog: { warn: vi.fn(), error: vi.fn() },
  literatureDocumentReader: {
    classificationEvidence: vi.fn().mockResolvedValue({
      coverage: 'passages',
      passages: [{ pageStart: 2, pageEnd: 2, content: 'Existing reader evidence' }]
    })
  },
  specialistService: {
    listForSettings: vi.fn().mockResolvedValue([
      { id: 'review', kind: 'reviewer' },
      { id: 'expert', kind: 'specialist' }
    ])
  }
}))
type ResearchRuntime = ApplicationRuntime<Awaited<ReturnType<typeof composeResearchCatalog>>>
function fixture(): {
  dependencies: ReturnType<typeof createDependencies>
  compose: () => Promise<ResearchRuntime>
} {
  const dependencies = createDependencies()
  const compose = (): Promise<ResearchRuntime> =>
    composeApplicationRuntime((modules) =>
      composeResearchCatalog({ ...dependencies, modules } as unknown as Dependencies)
    )
  return { dependencies, compose }
}
function paper(): LiteratureItemView {
  return {
    id: 'paper',
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Paper',
      abstract: 'Study abstract'
    }),
    collectionIds: [],
    projectIds: [],
    attachments: [
      {
        id: 'pdf',
        kind: 'fullText',
        title: '',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
        versions: [
          {
            id: 'pdf-v1',
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
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.dataRoot = await mkdtemp(join(tmpdir(), 'research-composition-'))
  roots.push(mocks.dataRoot)
  mocks.getDb.mockResolvedValue(mocks.db)
  mocks.screening.mockReturnValue({ start: mocks.startScreening, dispose: mocks.disposeScreening })
  mocks.sweep.mockResolvedValue(undefined)
  mocks.shutdown.mockResolvedValue(undefined)
  mocks.closeBatch.mockResolvedValue(undefined)
  mocks.removeTags.mockResolvedValue(undefined)
  mocks.run.mockResolvedValue({ text: JSON.stringify(sections), model: 'captured-model' })
  mocks.getItem.mockResolvedValue(paper())
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('research catalog composition', () => {
  it('runs the real snapshot with the shared catalog/reader, current model and data root', async () => {
    const { dependencies: d, compose } = fixture()
    const runtime = await compose()
    try {
      const runnerOptions = mocks.runner.mock.calls[0][0]
      expect(runnerOptions).toMatchObject({
        appVersion: '1.2.3-test',
        configRoot: d.configRoot,
        profileNamespace: 'study-snapshot',
        allowNativeCodexSubscription: true
      })
      const target = { id: 'chosen-model' }
      const context = { origin: 'snapshot' }
      await runnerOptions.resolveTarget(target, context)
      expect(d.settingsService.resolveExplicitAgentBackend).toHaveBeenCalledWith(target, context)
      expect(d.settingsService.captureActiveExplicitAgentBackendTarget).not.toHaveBeenCalled()
      d.settingsService.captureActiveExplicitAgentBackendTarget.mockResolvedValueOnce(target)
      // The root is resolved when saving; moving app-managed storage must not keep writing the old root.
      const initialRoot = mocks.dataRoot
      mocks.dataRoot = await mkdtemp(join(tmpdir(), 'research-relocated-'))
      roots.push(mocks.dataRoot)
      const request = {
        itemId: 'paper',
        expectedSourceKey: literatureSnapshotSource(paper()).key,
        language: 'en',
        mode: 'generate' as const
      }
      expect(await runtime.interfaces.literatureStudySnapshot.run(request)).toMatchObject({
        coverage: 'passages',
        attachmentVersionId: 'pdf-v1',
        sections
      })
      expect(mocks.getItem).toHaveBeenCalledWith('paper')
      expect(d.literatureDocumentReader.classificationEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentId: 'pdf', attachmentVersionId: 'pdf-v1' })
      )
      expect(mocks.run).toHaveBeenCalledWith({
        prompt: expect.stringContaining('Existing reader evidence'),
        systemPrompt: expect.stringContaining('Do not use tools'),
        signal: expect.any(AbortSignal),
        target,
        agentName: 'open-science-study-snapshot',
        description: 'Summarize a single paper without tools.',
        outputLimitBytes: 24_000
      })
      expect(await readdir(initialRoot)).toEqual([])
      expect(await readdir(join(mocks.dataRoot, 'literature', 'study-snapshots'))).toHaveLength(1)
      d.settingsService.captureActiveExplicitAgentBackendTarget.mockResolvedValueOnce({
        id: 'next-model'
      })
      await runtime.interfaces.literatureStudySnapshot.run(request)
      expect(mocks.run.mock.lastCall?.[0].target).toEqual({ id: 'next-model' })
      expect(
        await runtime.interfaces.literatureStudySnapshot.run({ ...request, mode: 'read' })
      ).toMatchObject({ model: 'captured-model', sections })
      expect(mocks.run).toHaveBeenCalledTimes(2)
      expect(mocks.sweep).toHaveBeenCalledOnce()
    } finally {
      await runtime.dispose()
    }
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    expect(mocks.closeBatch).toHaveBeenCalledOnce()
    expect(mocks.startScreening).toHaveBeenCalledOnce()
    expect(mocks.disposeScreening).toHaveBeenCalledOnce()
  })

  it('logs stale-profile cleanup failures without blocking snapshots and propagates inference failure', async () => {
    const failure = new Error('cannot remove stale profile')
    mocks.sweep.mockRejectedValueOnce(failure)
    const { dependencies: d, compose } = fixture()
    const runtime = await compose()
    try {
      expect(d.literatureContextLog.warn).toHaveBeenCalledWith(
        'Study snapshot profile cleanup failed',
        expect.any(Object)
      )
      mocks.run.mockRejectedValueOnce(new Error('model unavailable'))
      await expect(
        runtime.interfaces.literatureStudySnapshot.run({
          itemId: 'paper',
          expectedSourceKey: literatureSnapshotSource(paper()).key,
          language: 'en'
        })
      ).rejects.toThrow('model unavailable')
      expect(await readdir(mocks.dataRoot)).toEqual([])
    } finally {
      await runtime.dispose()
    }
    expect(mocks.shutdown).toHaveBeenCalledOnce()
  })

  it('shares tag/catalog repositories and publishes monotonically revised library events', async () => {
    const { dependencies: d, compose } = fixture()
    const runtime = await compose()
    try {
      const resourceOptions = mocks.tagResourceCatalog.mock.calls[0][0]
      expect(await resourceOptions.listSkills()).toEqual([{ id: 'skill' }])
      expect(await resourceOptions.listConnectors()).toEqual([{ id: 'connector' }])
      expect(await resourceOptions.listSpecialists()).toEqual([
        { id: 'expert', kind: 'specialist' }
      ])
      mocks.db.pdfAnnotation.findMany.mockResolvedValueOnce([{ id: 'annotation' }])
      mocks.db.literatureItem.findMany.mockResolvedValueOnce([{ id: 'paper' }])
      expect(await resourceOptions.listPdfAnnotations()).toEqual([{ id: 'annotation' }])
      expect(await resourceOptions.listLiteratureItems()).toEqual([{ id: 'paper' }])
      expect(mocks.db.pdfAnnotation.findMany).toHaveBeenCalledWith({ select: { id: true } })
      expect(mocks.db.literatureItem.findMany).toHaveBeenCalledWith({ select: { id: true } })
      for (const repository of [
        mocks.tagRepository,
        mocks.memoryRepository,
        mocks.journal,
        mocks.catalog
      ]) {
        expect(await repository.mock.calls[0][0]()).toBe(mocks.db)
      }
      expect(mocks.getDb.mock.calls.every((args) => args[0] === d.configRoot)).toBe(true)
      const screeningArgs = mocks.screening.mock.calls[0]
      expect(await screeningArgs[0]()).toBe(mocks.db)
      expect(screeningArgs[1]).toBe(d.settingsService.classification)
      screeningArgs[2]('collection')
      const evidenceRequest = { itemId: 'paper' }
      await screeningArgs[3](evidenceRequest)
      expect(d.literatureDocumentReader.classificationEvidence).toHaveBeenCalledWith(
        evidenceRequest
      )
      mocks.journal.mock.calls[0][1]()
      const catalogArgs = mocks.catalog.mock.calls[0]
      catalogArgs[4]({ itemIds: ['paper'] })
      expect(d.applicationEvents.publish.mock.calls).toEqual([
        ['literature:changed', { revision: 1, collectionIds: ['collection'] }],
        ['literature:changed', { revision: 2 }],
        ['literature:changed', { revision: 3, itemIds: ['paper'] }]
      ])
      expect(mocks.referencesChanged).toHaveBeenCalledOnce()
      await d.pdfAnnotationTagEvents.notify?.()
      await catalogArgs[1]()
      expect(mocks.notifyTags).toHaveBeenCalledTimes(2)
      const remove = vi.fn().mockResolvedValue(undefined)
      await catalogArgs[3](remove)
      expect(d.sessionPersistenceCoordinator.withLiteratureAttachmentRemoval).toHaveBeenCalledWith(
        remove
      )
      expect(remove).toHaveBeenCalledOnce()
      const assignment = { resourceId: 'annotation', tagIds: ['tag'] }
      await mocks.tagService.mock.calls[0][3](assignment)
      expect(d.pdfAnnotationService.setTagAssignment).toHaveBeenCalledWith(assignment)
    } finally {
      await runtime.dispose()
    }
  })

  it('wires shared download services with runtime proxy resolution and preserves cancellation', async () => {
    const { dependencies: d, compose } = fixture()
    const runtime = await compose()
    try {
      const catalog = runtime.interfaces.literatureCatalog
      const fullText = mocks.fullText.mock.calls[0][0]
      const supplements = mocks.supplements.mock.calls[0][0]
      const acquisition = mocks.acquisition.mock.calls[0][0]
      expect(fullText).toMatchObject({
        catalog,
        content: d.contentRepository,
        fetch: mocks.fetch,
        pageCount: mocks.pageCount
      })
      expect(supplements.download).toBe(fullText.download)
      expect(acquisition.download).toBe(fullText.download)
      expect(acquisition.fullText).toBe(runtime.interfaces.literatureFullTextFinder)
      mocks.decrypt.mockImplementation((ref) => `decrypted:${ref}`)
      expect(await fullText.openAlexKey()).toBe('decrypted:openalex-ref')
      expect(await fullText.contactEmail()).toBe('research@example.test')
      expect(await mocks.related.mock.calls[0][0].apiKey()).toBe('decrypted:semantic-ref')
      d.settingsService.getConnectors.mockResolvedValueOnce(undefined as never)
      expect(await fullText.contactEmail()).toBeUndefined()
      const signal = new AbortController().signal
      const progress = vi.fn()
      const options = { headers: { Accept: 'application/pdf' } }
      mocks.download.mockResolvedValueOnce({ saved: true })
      expect(
        await fullText.download(
          'https://paper.test/file.pdf',
          1000,
          progress,
          undefined,
          signal,
          undefined,
          options
        )
      ).toEqual({ saved: true })
      const downloadArgs = mocks.download.mock.calls[0]
      expect(downloadArgs.slice(0, 3)).toEqual(['https://paper.test/file.pdf', 1000, progress])
      expect(downloadArgs[4]).toBe(signal)
      expect(downloadArgs[6]).toBe(options)
      mocks.resolveProxy.mockResolvedValue('HTTPS proxy.test:443')
      mocks.parseProxy
        .mockReturnValueOnce({
          HTTPS_PROXY: 'https://proxy.test:443',
          ALL_PROXY: 'socks://fallback'
        })
        .mockReturnValueOnce({ ALL_PROXY: 'socks://fallback' })
        .mockReturnValueOnce({})
      expect(await downloadArgs[3]('https://paper.test')).toBe('https://proxy.test:443')
      expect(await downloadArgs[3]('https://paper.test')).toBe('socks://fallback')
      expect(await downloadArgs[3]('https://paper.test')).toBeUndefined()
      expect(mocks.resolveProxy).toHaveBeenCalledWith('https://paper.test')
      await downloadArgs[5]('https://proxy.test', 'paper.test', 443, signal)
      expect(mocks.tunnel).toHaveBeenCalledWith(
        'https://proxy.test',
        'paper.test',
        443,
        undefined,
        signal
      )
      const progressEvent = { completed: 1 }
      mocks.pdfImporter.mock.calls[0][0].onNativeImportProgress(progressEvent)
      expect(d.applicationEvents.publish).toHaveBeenCalledWith(
        'pdf-annotations:import-progress',
        progressEvent
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('exposes throwing and best-effort tag cleanup while reporting batch failures', async () => {
    const { dependencies: d, compose } = fixture()
    const runtime = await compose()
    try {
      const resources = [{ kind: 'literature', id: 'paper' }] as never
      await runtime.interfaces.removeResourceTags(resources)
      expect(mocks.removeTags).toHaveBeenCalledWith(resources)
      expect(mocks.cleanupWarn).not.toHaveBeenCalled()
      const failure = new Error('database unavailable')
      mocks.removeTags.mockRejectedValue(failure)
      await expect(runtime.interfaces.removeResourceTagsOrThrow(resources)).rejects.toBe(failure)
      await expect(runtime.interfaces.removeResourceTags(resources)).resolves.toBeUndefined()
      expect(mocks.cleanupWarn).toHaveBeenCalledWith('resource deletion Tag cleanup failed', {
        error: failure,
        resources
      })
      const batchOptions = mocks.batch.mock.calls[0][0]
      expect(batchOptions).toMatchObject({
        path: join(mocks.dataRoot, 'literature', 'batch-jobs.json'),
        catalog: runtime.interfaces.literatureCatalog,
        metadata: runtime.interfaces.literatureMetadataEnricher,
        fullText: runtime.interfaces.literatureFullTextFinder
      })
      batchOptions.onError(failure)
      expect(d.literatureContextLog.error).toHaveBeenCalledWith(
        'Literature batch task failed',
        expect.any(Object)
      )
      expect(mocks.styles).toHaveBeenCalledWith(
        join(mocks.dataRoot, 'literature', 'citation-styles')
      )
    } finally {
      await runtime.dispose()
    }
  })
})
