import { beforeEach, describe, expect, it, vi } from 'vitest'
import { literatureRecordImportRequestSchema } from '@aipoch/literature-library/contracts'

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
  it('routes exact candidate reads through the catalog without publishing mutations', async () => {
    const result = {
      candidates: [{ candidateId: 'a', state: 'accepted', acceptedItemId: 'paper' }]
    }
    const getCandidateStates = vi.fn().mockResolvedValue(result)
    const owner = createLiteratureCommandOwner({
      literatureCatalog: { getCandidateStates }
    } as unknown as Services)
    const request = { candidateIds: ['a'] }
    await expect(owner.getCandidateStates(request)).resolves.toBe(result)
    expect(getCandidateStates).toHaveBeenCalledWith(request)
    expect(broadcastToRenderers).not.toHaveBeenCalled()
  })

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

it('maps package style errors to the existing application command error envelope', async () => {
  const { CitationStyleError } = await import('@aipoch/literature-citations')
  const { toApplicationCommandErrorEnvelope } =
    await import('../../shared/application-command-contract')
  const owner = createLiteratureCommandOwner({
    literatureCitationFormatter: {
      citationStyles: async () => {
        throw new CitationStyleError('csl-undefined-macro', 'Unknown macro', { macro: 'missing' })
      }
    }
  } as unknown as Services)
  const error = await owner
    .citationStyles({ kind: 'import', content: '<style/>' })
    .catch((error) => error)
  expect(toApplicationCommandErrorEnvelope(error)).toEqual({
    code: 'csl-undefined-macro',
    message: 'Unknown macro',
    parameters: { macro: 'missing' }
  })
})

describe('selected reference import', () => {
  it('imports explicitly selected rows in source order and maps preview diagnostics to source indices', async () => {
    const { owner, formatter, catalog } = fixture()
    const items = [{ title: 'First' }, { title: 'Conflicting' }, { title: 'Last' }]
    const entries = items.map((item, index) => ({
      index,
      item,
      status: index === 1 ? 'conflict' : 'ready'
    }))
    formatter.parseReferences.mockResolvedValue({ items, errors: [], warnings: [] })
    catalog.inspectImportItems.mockResolvedValue([entries[0], { ...entries[2], index: 1 }])
    catalog.importItems.mockResolvedValue({
      itemIds: ['first', 'last'],
      createdCount: 2,
      reusedCount: 0
    })
    const result = await owner.importRecords({
      mode: 'commit',
      content: 'source',
      selectedItemIndexes: [2, 0],
      collectionId: 'collection',
      duplicatePolicy: 'reuse'
    })
    expect(catalog.importItems).toHaveBeenCalledWith([items[0], items[2]], 'collection', 'reuse')
    expect(result.entries).toEqual([entries[0], entries[2]])
    expect(result.items).toEqual(items)
    expect(result.imported?.itemIds).toEqual(['first', 'last'])
  })

  it('previews only selected identities and maps conflicts and invalid rows back to source indices', async () => {
    const { owner, formatter, catalog } = fixture()
    const items = [{ title: 'Excluded' }, { title: 'First selected' }, { title: 'Second selected' }]
    const errors = [{ preview: 'Invalid', error: 'Invalid input' }]
    formatter.parseReferences.mockResolvedValue({
      items,
      errors,
      warnings: [[], ['missing-year'], []]
    })
    catalog.inspectImportItems.mockResolvedValue([
      { index: 0, item: items[1], status: 'ready', warnings: ['missing-year'] },
      {
        index: 1,
        item: items[2],
        status: 'conflict',
        conflict: { identifiers: [], matches: [{ inputIndex: 0, title: 'First selected' }] }
      },
      { index: 2, status: 'invalid', error: 'Invalid input' }
    ])
    const result = await owner.importRecords({
      mode: 'preview',
      content: 'source',
      selectedItemIndexes: [2, 1]
    })
    expect(catalog.inspectImportItems).toHaveBeenCalledWith([items[1], items[2]], errors, [
      ['missing-year'],
      []
    ])
    expect(result.items).toEqual(items)
    expect(result.entries.map((entry) => entry.index)).toEqual([1, 2, 3])
    expect(result.entries[1].conflict?.matches).toEqual([
      { inputIndex: 1, title: 'First selected' }
    ])
    expect(catalog.importItems).not.toHaveBeenCalled()
  })

  it.each([[], [0, 0], [-1], [1.5], [1]].map((indexes) => ({ indexes })))(
    'rejects invalid selections %j before any write',
    async ({ indexes: selectedItemIndexes }) => {
      const { owner, catalog } = fixture()
      await expect(
        owner.importRecords({ mode: 'commit', content: 'source', selectedItemIndexes })
      ).rejects.toThrow('Import selection is invalid')
      expect(catalog.importItems).not.toHaveBeenCalled()
    }
  )

  it('keeps selected identity conflicts authoritative at commit', async () => {
    const { owner, catalog } = fixture()
    catalog.importItems.mockRejectedValue(new Error('conflicting identifiers'))
    await expect(
      owner.importRecords({ mode: 'commit', content: 'source', selectedItemIndexes: [0] })
    ).rejects.toThrow('conflicting identifiers')
  })

  it('accepts legacy whole-file requests and validates the optional selection at the transport boundary', () => {
    const request = { mode: 'commit', content: 'source' }
    expect(literatureRecordImportRequestSchema.parse(request)).toEqual(request)
    expect(
      literatureRecordImportRequestSchema.parse({ ...request, selectedItemIndexes: [0, 2] })
    ).toEqual({ ...request, selectedItemIndexes: [0, 2] })
    for (const indexes of [
      [],
      [-1],
      [0, 0],
      [0.1],
      Array.from({ length: 1001 }, (_, index) => index)
    ]) {
      expect(
        literatureRecordImportRequestSchema.safeParse({ ...request, selectedItemIndexes: indexes })
          .success
      ).toBe(false)
    }
    expect(
      literatureRecordImportRequestSchema.safeParse({
        mode: 'preview',
        content: 'source',
        selectedItemIndexes: [0]
      }).success
    ).toBe(true)
  })
})
