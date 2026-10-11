import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Prisma, PrismaClient } from '@prisma/client'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { JournalAttributes } from './journal-attributes'
import { type JournalImportRow, type JournalRequest } from '@aipoch/journal-catalog/contracts'

// Entirely fictional fixtures, authored independently of user-supplied files and headings.
const fields = [
  { id: 'signal', label: 'Signal index', kind: 'number' as const, colors: {}, visible: true },
  { id: 'band', label: 'Editorial band', kind: 'singleSelect' as const, colors: {}, visible: true }
]
const definition = { source: 'Fictional evaluation', year: 2031, fields }
const row = (overrides: Partial<JournalImportRow> = {}): JournalImportRow => ({
  row: 2,
  name: 'Imaginary Review of Lunar Gardens',
  aliases: ['Imag. Lunar Gard.'],
  issns: ['1234-5679'],
  values: { signal: '<0.5', band: 'Gold' },
  ...overrides
})
const roots: string[] = []
const clients: PrismaClient[] = []
const services: JournalAttributes[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup(): Promise<{
  root: string
  service: JournalAttributes
  client: PrismaClient
  changed: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), 'journal-attributes-'))
  roots.push(root)
  const client = createProjectDbClient(root)
  clients.push(client)
  await migrateApplicationDatabase(client)
  const changed = vi.fn()
  const service = new JournalAttributes(async () => client, changed)
  services.push(service)
  return { root, service, client, changed }
}
async function preview(
  service: JournalAttributes,
  rows = [row()],
  options: Partial<Extract<JournalRequest, { action: 'begin' }>> = {}
): Promise<{ token: string; digest: string }> {
  const { token } = await service.run({ action: 'begin', definition, policy: 'fill', ...options })
  await service.run({ action: 'append', token: token!, offset: 0, rows })
  const result = await service.run({ action: 'preview', token: token!, offset: 0 })
  return { token: token!, digest: result.digest! }
}
it('projects Library names, type fields and identifiers into journal filtering', async () => {
  const { service, client } = await setup()
  const imported = await preview(service, [
    row({ externalIds: [{ namespace: 'JCR', value: 'fictional-417' }] })
  ])
  const saved = await service.run({ action: 'commit', ...imported, skipProblems: false })
  const dataset = saved.datasets![0]
  await client.literatureItem.create({
    data: {
      id: 'attribute-filter-item',
      itemType: 'journalArticle',
      title: 'Synthetic filtered reference',
      containerTitle: row().name
    }
  })
  await client.literatureItem.create({
    data: {
      id: 'external-id-filter-item',
      itemType: 'journalArticle',
      title: 'Synthetic external ID reference',
      containerTitle: 'Unrelated journal title',
      typeFieldsJson: JSON.stringify({ jcrId: 'fictional-417' })
    }
  })
  await client.literatureItem.create({
    data: {
      id: 'namespaced-identifier-item',
      itemType: 'journalArticle',
      title: 'Synthetic namespaced identifier reference',
      containerTitle: 'Unrelated journal title',
      identifiers: {
        create: {
          scheme: 'other',
          rawValue: 'jcr:fictional-417',
          normalizedValue: 'jcr:fictional-417',
          isPrimary: false
        }
      }
    }
  })
  await client.literatureItem.createMany({
    data: [
      {
        id: 'eissn-item',
        itemType: 'journalArticle',
        title: 'Electronic ISSN projection',
        typeFieldsJson: JSON.stringify({ eissn: '1234 5679' })
      },
      {
        id: 'abbreviation-item',
        itemType: 'journalArticle',
        title: 'Abbreviation projection',
        typeFieldsJson: JSON.stringify({ journalAbbreviation: 'Imag. Lunar Gard.' })
      },
      {
        id: 'ignored-book',
        itemType: 'book',
        title: 'Not a journal reference',
        containerTitle: row().name
      }
    ]
  })
  expect(
    await service.filterItemIds(client, [
      { datasetId: dataset.id, fieldId: 'signal', operator: 'gt', value: '0.4' }
    ])
  ).toEqual([
    'abbreviation-item',
    'attribute-filter-item',
    'eissn-item',
    'external-id-filter-item',
    'namespaced-identifier-item'
  ])
})

it('rolls back a partial import on database failure and permits a reviewed retry', async () => {
  const { service, client, changed } = await setup()
  const draft = await preview(service)
  await client.$executeRawUnsafe(
    `CREATE TRIGGER fail_journal_entry BEFORE INSERT ON "JournalDatasetEntry" BEGIN SELECT RAISE(ABORT, 'test write failure'); END`
  )
  await expect(service.run({ action: 'commit', ...draft, skipProblems: false })).rejects.toThrow()
  expect(await client.journal.count()).toBe(0)
  expect(await client.journalDataset.count()).toBe(0)
  expect(changed).not.toHaveBeenCalled()
  await client.$executeRawUnsafe('DROP TRIGGER fail_journal_entry')
  expect((await service.run({ action: 'commit', ...draft, skipProblems: false })).imported).toBe(1)
})

it.each(['issn', 'other'] as const)(
  'clears confirmations on %s identity edits but preserves them for title and author edits',
  async (scheme) => {
    const { LiteratureCatalog } = await import('./catalog')
    const { literatureItemInputSchema } = await import('../../shared/literature')
    const { service, client } = await setup()
    const catalog = new LiteratureCatalog(async () => client)
    const draft = await preview(service)
    await service.run({ action: 'commit', ...draft, skipProblems: false })
    const target = (await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0]
    const created = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: 'Synthetic editable reference',
        containerTitle: 'Unknown fictional review',
        identifiers: [
          {
            scheme,
            value: scheme === 'issn' ? '2049-3630' : 'jcr:unmatched-identity',
            isPrimary: false
          }
        ]
      })
    })
    const bind = async (): Promise<void> => {
      service.referencesChanged()
      const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 }))
        .alignment!
      const reference = report.rows.find(({ itemId }) => itemId === created.id)!
      await service.run({
        action: 'bind',
        token: report.token,
        itemId: created.id,
        journalId: target.id,
        expectedMetadataRevision: reference.metadataRevision,
        expectedBindingRevision: reference.bindingRevision
      })
    }
    await bind()
    let current = (await catalog.get(created.id))!
    await catalog.transact({
      kind: 'update-item',
      itemId: created.id,
      expectedMetadataRevision: current.metadataRevision,
      item: {
        ...current.item,
        title: 'Edited fictional title',
        creators: [
          {
            nameMode: 'organization',
            literalName: 'Imaginary Research Circle',
            creatorType: 'author'
          }
        ]
      }
    })
    expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toHaveLength(1)
    for (const change of [
      { containerTitle: 'Other fictional review' },
      { typeFields: { journalAbbreviation: 'Other Fiction.' } },
      { typeFields: { issn: 'invalid synthetic identifier' } },
      { typeFields: { eissn: '0378-5955' } },
      {
        identifiers: [
          {
            scheme,
            value: scheme === 'issn' ? '0378-5955' : 'jcr:edited-identity',
            isPrimary: false
          }
        ]
      },
      { identifiers: [] }
    ]) {
      current = (await catalog.get(created.id))!
      await catalog.transact({
        kind: 'update-item',
        itemId: created.id,
        expectedMetadataRevision: current.metadataRevision,
        item: { ...current.item, ...change }
      })
      expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toEqual([])
      await bind()
    }
    current = (await catalog.get(created.id))!
    await expect(
      catalog.transact({
        kind: 'update-item',
        itemId: created.id,
        expectedMetadataRevision: current.metadataRevision - 1,
        item: { ...current.item, containerTitle: 'Rejected change' }
      })
    ).rejects.toThrow('revision')
    expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toHaveLength(1)
    await client.literatureItem.delete({ where: { id: created.id } })
    expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toEqual([])
  }
)

it('preserves dataset presentation, edits and manual bindings after closing and reopening the database', async () => {
  const { root, service, client } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  let dataset = saved.datasets![0]
  dataset = (
    await service.run({
      action: 'fields',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      fields: [
        { ...dataset.fields[1], visible: false, colors: { Gold: 'green' } },
        { ...dataset.fields[0], label: 'Saved signal' }
      ]
    })
  ).datasets![0]
  dataset = (
    await service.run({
      action: 'rename',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      name: 'Persistent survey',
      source: 'Persistent source',
      year: 2033
    })
  ).datasets![0]
  const entry = (
    await service.run({
      action: 'entries',
      datasetId: dataset.id,
      offset: 0,
      query: '',
      descending: false
    })
  ).entries![0]
  dataset = (
    await service.run({
      action: 'entry',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      journalId: entry.id,
      values: { signal: '8.75' }
    })
  ).datasets![0]
  const reference = await client.literatureItem.create({
    data: {
      id: 'persistent-reference',
      itemType: 'journalArticle',
      title: 'Persistent reference',
      containerTitle: 'An unmatched alias'
    }
  })
  service.referencesChanged()
  const scan = (await service.run({ action: 'audit-step' })).scan!
  expect(scan.done).toBe(true)
  await service.run({
    action: 'bind',
    token: scan.token,
    itemId: reference.id,
    journalId: entry.id,
    expectedMetadataRevision: reference.metadataRevision,
    expectedBindingRevision: null
  })
  await service.dispose()
  await client.$disconnect()
  const reopened = createProjectDbClient(root)
  clients.push(reopened)
  expect((await migrateApplicationDatabase(reopened)).applied).toEqual([])
  const restarted = new JournalAttributes(async () => reopened)
  services.push(restarted)
  expect((await restarted.run({ action: 'list' })).datasets).toEqual([dataset])
  expect(
    (
      await restarted.run({
        action: 'entries',
        datasetId: dataset.id,
        offset: 0,
        query: '',
        descending: false
      })
    ).entries![0].values
  ).toEqual({ signal: '8.75', band: 'Gold' })
  const resolved = (
    await restarted.run({
      action: 'resolve',
      identities: [{ itemId: reference.id, name: reference.containerTitle, aliases: [], issns: [] }]
    })
  ).matches![0]
  expect(resolved.status).toBe('matched')
  expect(resolved.attributes).toHaveLength(1)
  expect(resolved.attributes[0]).toMatchObject({
    label: 'Saved signal',
    value: '8.75',
    source: 'Persistent source',
    year: 2033
  })
  expect(await reopened.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
})

it('filters active and deleted references with separate caches while alignment excludes trash', async () => {
  const { LiteratureCatalog } = await import('./catalog')
  const { service, client } = await setup()
  const draft = await preview(service)
  const saved = await service.run({ action: 'commit', ...draft, skipProblems: false })
  await client.literatureItem.createMany({
    data: [
      {
        id: 'active-filter',
        itemType: 'journalArticle',
        title: 'Active fictional reference',
        containerTitle: row().name
      },
      {
        id: 'deleted-filter',
        itemType: 'journalArticle',
        title: 'Deleted fictional reference',
        containerTitle: row().name,
        deletedAt: new Date()
      },
      {
        id: 'merged-filter',
        itemType: 'journalArticle',
        title: 'Merged fictional reference',
        containerTitle: row().name,
        deletedAt: new Date(),
        mergedIntoItemId: 'active-filter'
      }
    ]
  })
  const catalog = new LiteratureCatalog(
    async () => client,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service
  )
  const request = {
    scope: 'library' as const,
    filter: {
      journalAttributes: [
        {
          datasetId: saved.datasets![0].id,
          fieldId: 'band',
          operator: 'equals' as const,
          value: 'Gold'
        }
      ]
    }
  }
  expect(
    (await catalog.search(request)).entries.map((entry) => ('id' in entry ? entry.id : undefined))
  ).toEqual(['active-filter'])
  const deleted = await catalog.search({ ...request, lifecycle: 'deleted' })
  expect(deleted.totalCount).toBe(2)
  expect(deleted.entries.map((entry) => ('id' in entry ? entry.id : undefined)).sort()).toEqual([
    'deleted-filter',
    'merged-filter'
  ])
  expect(
    (await catalog.search(request)).entries.map((entry) => ('id' in entry ? entry.id : undefined))
  ).toEqual(['active-filter'])
  expect((await catalog.searchForAgent({ ...request, lifecycle: 'deleted' })).totalCount).toBe(2)
  const aligned = (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment!
  expect(aligned.rows.map(({ itemId }) => itemId)).toEqual(['active-filter'])
})

it('resolves confirmed journal attributes in trash consistently with filtering', async () => {
  const { service, client } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const reference = await client.literatureItem.create({
    data: {
      id: 'confirmed-trash-reference',
      itemType: 'journalArticle',
      title: 'Confirmed fictional reference',
      containerTitle: 'Unknown fictional journal'
    }
  })
  const target = (await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0]
  const audit = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  await service.run({
    action: 'bind',
    token: audit.token,
    itemId: reference.id,
    journalId: target.id,
    expectedMetadataRevision: reference.metadataRevision,
    expectedBindingRevision: null
  })
  await client.literatureItem.update({
    where: { id: reference.id },
    data: { deletedAt: new Date() }
  })
  service.referencesChanged()
  expect(
    await service.filterItemIds(
      client,
      [{ datasetId: saved.datasets![0].id, fieldId: 'band', operator: 'equals', value: 'Gold' }],
      'deleted'
    )
  ).toEqual([reference.id])
  const resolved = await service.run({
    action: 'resolve',
    identities: [{ itemId: reference.id, name: reference.containerTitle, aliases: [], issns: [] }]
  })
  expect(resolved.matches![0].status).toBe('matched')
  expect(resolved.matches![0].attributes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: `${saved.datasets![0].id}:band`, value: 'Gold' })
    ])
  )
  expect(
    (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment!.total
  ).toBe(0)
})

it('uses the native Prisma transaction for both reference validation and binding writes', async () => {
  const { service, client } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  await client.literatureItem.create({
    data: { id: 'guarded', itemType: 'journalArticle', title: 'Transaction boundary' }
  })
  const target = (await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0]
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  const request: Extract<JournalRequest, { action: 'bind' }> = {
    action: 'bind',
    token: report.token,
    itemId: 'guarded',
    journalId: target.id,
    expectedMetadataRevision: 1,
    expectedBindingRevision: null
  }
  const original = client.$transaction.bind(client)
  const transaction = vi.spyOn(client, '$transaction').mockImplementationOnce((async (
    operation: (tx: Prisma.TransactionClient) => Promise<unknown>
  ) =>
    original(async (tx) => {
      // Only the same native transaction can see this uncommitted reference revision.
      await tx.literatureItem.update({ where: { id: 'guarded' }, data: { metadataRevision: 2 } })
      return operation(tx)
    })) as typeof client.$transaction)
  await expect(service.run(request)).rejects.toThrow('changed')
  transaction.mockRestore()
  expect(
    (await client.literatureItem.findUniqueOrThrow({ where: { id: 'guarded' } })).metadataRevision
  ).toBe(1)
  expect(await client.journalItemBinding.count()).toBe(0)
  await service.run(request)
  expect(
    await client.journalItemBinding.findUnique({ where: { itemId: 'guarded' } })
  ).toMatchObject({ journalId: target.id })
})
