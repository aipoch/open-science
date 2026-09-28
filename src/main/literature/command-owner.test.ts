import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers: vi.fn() }))
vi.mock('../storage/migration-state', () => ({
  withDataRootWrite: vi.fn(async (operation: () => Promise<unknown>) => operation())
}))
import { broadcastToRenderers } from '../renderer-broadcast'
import { withDataRootWrite } from '../storage/migration-state'
import { createLiteratureCommandOwner } from './command-owner'

type Services = Parameters<typeof createLiteratureCommandOwner>[0]
const request = {
  projectId: 'project',
  sessionId: 'session',
  artifactId: 'artifact',
  versionId: 'v1',
  mode: 'save' as const,
  styleId: 'apa',
  locale: 'en-US' as const,
  expectedHeadVersionId: 'v1',
  operationId: 'op1'
}
type Mocks<Names extends string> = Record<Names, ReturnType<typeof vi.fn>>
const fixture = (): {
  owner: ReturnType<typeof createLiteratureCommandOwner>
  lease: Mocks<'readRange' | 'close'> & { size: number }
  versions: Mocks<'openVersion' | 'saveDerivedArtifactEdit'>
  formatter: Mocks<'formatReferences' | 'parseReferences'>
  catalog: Mocks<'inspectImportItems' | 'importItems'>
  document: Mocks<'reformat'>
} => {
  const literature = { references: [{ itemId: 'item', item: { title: 'Reference' } }] }
  const lease = {
    size: 3,
    readRange: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    close: vi.fn()
  }
  const versions = {
    openVersion: vi.fn().mockResolvedValue(lease),
    saveDerivedArtifactEdit: vi.fn().mockResolvedValue({
      kind: 'created',
      replayed: false,
      version: { id: 'v2', versionNumber: 2 }
    })
  }
  const formatter = {
    formatReferences: vi.fn().mockResolvedValue('references'),
    parseReferences: vi
      .fn()
      .mockResolvedValue({ items: [{ title: 'Reference' }], errors: [], warnings: ['warning'] })
  }
  const catalog = {
    inspectImportItems: vi.fn().mockResolvedValue(['entry']),
    importItems: vi.fn().mockResolvedValue(['imported'])
  }
  const document = {
    reformat: vi.fn().mockResolvedValue({ content: new Uint8Array([4]), literature })
  }
  const services = {
    artifactProvenanceRepository: { getVersionLiterature: vi.fn().mockResolvedValue(literature) },
    managedFileVersionService: versions,
    literatureCitationDocument: document,
    literatureCitationFormatter: formatter,
    literatureCatalog: catalog
  }
  // Only these services participate in the document and import workflows under test.
  const owner = createLiteratureCommandOwner(services as unknown as Services)
  return { owner, lease, versions, formatter, catalog, document }
}

beforeEach(() => vi.clearAllMocks())

describe('Literature command workflows', () => {
  it('routes journal requests through the dataset service', async () => {
    const result = { datasets: [] }
    const journalAttributes = { run: vi.fn().mockResolvedValue(result) }
    const owner = createLiteratureCommandOwner({ journalAttributes } as unknown as Services)
    const request = { action: 'list' as const }
    await expect(owner.journals(request)).resolves.toBe(result)
    expect(journalAttributes.run).toHaveBeenCalledWith(request)
  })

  it('previews references without acquiring a file lease or creating a version', async () => {
    const { owner, versions, formatter } = fixture()
    await expect(owner.formatDocument({ ...request, mode: 'preview' })).resolves.toEqual({
      mode: 'preview',
      references: 'references'
    })
    expect(formatter.formatReferences).toHaveBeenCalledWith(
      [{ id: 'item', item: { title: 'Reference' } }],
      'apa',
      'en-US'
    )
    expect(versions.openVersion).not.toHaveBeenCalled()
    expect(versions.saveDerivedArtifactEdit).not.toHaveBeenCalled()
    expect(broadcastToRenderers).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves revision and replay semantics (replayed=%s)',
    async (replayed) => {
      const { owner, versions, lease, document } = fixture()
      versions.saveDerivedArtifactEdit.mockResolvedValue({
        kind: 'created',
        replayed,
        version: { id: 'v2', versionNumber: 2 }
      })
      await expect(owner.formatDocument(request)).resolves.toEqual({
        mode: 'save',
        versionId: 'v2',
        versionNumber: 2
      })
      expect(versions.saveDerivedArtifactEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          basedOnVersionId: 'v1',
          expectedHeadVersionId: 'v1',
          operationId: 'op1',
          content: new Uint8Array([4])
        })
      )
      expect(withDataRootWrite).toHaveBeenCalledTimes(1)
      expect(lease.close).toHaveBeenCalledTimes(1)
      expect(lease.close.mock.invocationCallOrder[0]).toBeLessThan(
        document.reformat.mock.invocationCallOrder[0]
      )
      expect(broadcastToRenderers).toHaveBeenCalledTimes(replayed ? 0 : 1)
      if (!replayed)
        expect(broadcastToRenderers).toHaveBeenCalledWith('project-files:changed', {
          projectId: 'project',
          sources: ['artifact'],
          kind: 'upsert'
        })
    }
  )

  it('closes a failed read before propagating the error and never saves', async () => {
    const { owner, versions, lease } = fixture()
    const failure = new Error('read failed')
    lease.readRange.mockRejectedValueOnce(failure)
    await expect(owner.formatDocument(request)).rejects.toBe(failure)
    expect(lease.close).toHaveBeenCalledTimes(1)
    expect(versions.saveDerivedArtifactEdit).not.toHaveBeenCalled()
    expect(broadcastToRenderers).not.toHaveBeenCalled()
  })

  it('reports revision conflicts without publishing a change event', async () => {
    const { owner, versions } = fixture()
    versions.saveDerivedArtifactEdit.mockResolvedValueOnce({ kind: 'conflict' })
    await expect(owner.formatDocument(request)).rejects.toThrow('This file has a newer version.')
    expect(broadcastToRenderers).not.toHaveBeenCalled()
  })

  it('keeps import preview read-only and passes the duplicate policy when importing', async () => {
    const { owner, catalog } = fixture()
    const input = {
      content: 'citation',
      collectionId: 'collection',
      duplicatePolicy: 'reuse' as const
    }
    await expect(owner.importRecords({ ...input, mode: 'preview' })).resolves.toMatchObject({
      entries: ['entry']
    })
    expect(catalog.importItems).not.toHaveBeenCalled()
    await owner.importRecords({ ...input, mode: 'commit' })
    expect(catalog.inspectImportItems).toHaveBeenCalledWith(
      [{ title: 'Reference' }],
      [],
      ['warning']
    )
    expect(catalog.importItems).toHaveBeenCalledWith(
      [{ title: 'Reference' }],
      'collection',
      'reuse'
    )
  })
})
