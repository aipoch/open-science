import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Prisma, PrismaClient } from '@prisma/client'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { JournalAttributes } from './journal-attributes'
import {
  journalIdentityFromItem,
  journalRequestSchema,
  journalResultSchema,
  journalColumnKey,
  normalizeIssn,
  journalNumber,
  type JournalImportRow,
  type JournalRequest,
  type JournalResult
} from '../../shared/journal-attributes'

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
it('validates identifiers and preserves qualified numbers without inventing precision', () => {
  expect(normalizeIssn('1234 5679')).toBe('1234-5679')
  expect(normalizeIssn('1234-5678')).toBeUndefined()
  expect(journalNumber('<0.5')).toEqual({ value: 0.5, comparator: '<' })
  expect(journalNumber('N/A')).toBeUndefined()
})
it('previews without writes, persists selected attributes, resolves identity, and removes only the dataset', async () => {
  const { service, client, changed } = await setup()
  const draft = await preview(service)
  expect((await service.run({ action: 'list' })).datasets).toEqual([])
  const saved = await service.run({ action: 'commit', ...draft, skipProblems: false })
  expect(saved.imported).toBe(1)
  expect(changed).toHaveBeenCalledTimes(1)
  const restarted = new JournalAttributes(async () => client)
  const result = await restarted.run({
    action: 'resolve',
    identities: [
      { name: 'Another spelling', aliases: [], issns: ['12345679'] },
      { name: 'imag. lunar gard.', aliases: [], issns: [] }
    ]
  })
  expect(result.matches?.map((match) => match.status)).toEqual(['matched', 'matched'])
  expect(result.matches?.[0].attributes[0].value).toBe('<0.5')
  const dataset = saved.datasets![0]
  await service.run({ action: 'remove', datasetId: dataset.id, expectedRevision: dataset.revision })
  expect(
    (
      await service.run({
        action: 'resolve',
        identities: [{ name: row().name, aliases: [], issns: [] }]
      })
    ).matches?.[0].status
  ).toBe('missing')
})
it('persists a display name without changing matching or source grouping, and preserves it on reimport', async () => {
  const { service, client, changed } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const rename = {
    action: 'rename' as const,
    datasetId: dataset.id,
    expectedRevision: dataset.revision
  }
  await expect(service.run({ ...rename, name: '   ' })).rejects.toThrow()
  await expect(service.run({ ...rename, name: 'x'.repeat(101) })).rejects.toThrow()
  const result = await service.run({ ...rename, name: '  My journal rankings  ' })
  expect(result.datasets![0]).toMatchObject({
    id: dataset.id,
    name: 'My journal rankings',
    source: dataset.source,
    year: dataset.year,
    revision: dataset.revision + 1,
    count: dataset.count,
    fields: dataset.fields
  })
  expect(changed).toHaveBeenCalledTimes(2)
  await expect(service.run({ ...rename, name: 'Stale edit' })).rejects.toThrow(
    'Journal data changed'
  )
  const restarted = new JournalAttributes(async () => client)
  services.push(restarted)
  expect((await restarted.run({ action: 'list' })).datasets![0].name).toBe('My journal rankings')
  const match = await restarted.run({
    action: 'resolve',
    identities: [{ name: row().name, aliases: [], issns: row().issns }]
  })
  expect(match.matches![0].status).toBe('matched')
  expect(match.matches![0].attributes[0].value).toBe('<0.5')
  const updated = await preview(service, [row()], {
    datasetId: dataset.id,
    expectedRevision: result.datasets![0].revision
  })
  expect(
    (await service.run({ action: 'commit', ...updated, skipProblems: false })).datasets![0].name
  ).toBe('My journal rankings')
})

it('updates one journal entry and rejects invalid or stale edits', async () => {
  const { service } = await setup()
  const draft = await preview(service)
  const saved = await service.run({ action: 'commit', ...draft, skipProblems: false })
  const dataset = saved.datasets![0]
  const entry = (
    await service.run({
      action: 'entries',
      datasetId: dataset.id,
      query: '',
      offset: 0,
      descending: false
    })
  ).entries![0]
  const updated = await service.run({
    action: 'entry',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    journalId: entry.id,
    values: { signal: '8.25', band: 'Platinum' }
  })
  expect(updated.datasets?.[0].revision).toBe(dataset.revision + 1)
  expect(
    (
      await service.run({
        action: 'entries',
        datasetId: dataset.id,
        query: '',
        offset: 0,
        descending: false
      })
    ).entries?.[0].values
  ).toEqual({ signal: '8.25', band: 'Platinum' })
  await expect(
    service.run({
      action: 'entry',
      datasetId: dataset.id,
      expectedRevision: updated.datasets![0].revision,
      journalId: entry.id,
      values: { signal: 'not a number', band: 'Platinum' }
    })
  ).rejects.toThrow('Invalid')
  await expect(
    service.run({
      action: 'entry',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      journalId: entry.id,
      values: { signal: '8.5', band: 'Platinum' }
    })
  ).rejects.toThrow('changed')
})
it('matches namespaced external identifiers and filters the library by journal attributes', async () => {
  const { service, client } = await setup()
  const imported = await preview(service, [
    row({ externalIds: [{ namespace: 'JCR', value: 'fictional-417' }] })
  ])
  const saved = await service.run({ action: 'commit', ...imported, skipProblems: false })
  const dataset = saved.datasets![0]
  const resolved = await service.run({
    action: 'resolve',
    identities: [
      {
        name: 'Unrelated title',
        aliases: [],
        issns: [],
        externalIds: [{ namespace: 'jcr', value: 'fictional-417' }]
      }
    ]
  })
  expect(resolved.matches?.[0].status).toBe('matched')
  expect(resolved.matches?.[0].identity?.externalIds).toEqual([
    { namespace: 'jcr', value: 'fictional-417' }
  ])
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
  const aligned = (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment!
  expect(aligned.rows.find(({ itemId }) => itemId === 'namespaced-identifier-item')?.reason).toBe(
    'external-id'
  )
  expect(
    await service.filterItemIds(client, [
      { datasetId: dataset.id, fieldId: 'signal', operator: 'gt', value: '0.4' }
    ])
  ).toEqual(['attribute-filter-item', 'external-id-filter-item', 'namespaced-identifier-item'])
})
it('rejects unreviewed writes and stale previews after another import', async () => {
  const { service } = await setup()
  const draft = await preview(service)
  await expect(
    service.run({
      action: 'commit',
      token: draft.token,
      digest: 'a'.repeat(64),
      skipProblems: false
    })
  ).rejects.toThrow('Review')
  const other = await preview(service, [row({ name: 'Imaginary Annals of Clouds' })], {
    definition: { ...definition, source: 'Second fictional source' }
  })
  await service.run({ action: 'commit', ...other, skipProblems: false })
  await expect(service.run({ action: 'commit', ...draft, skipProblems: false })).rejects.toThrow(
    'changed'
  )
})
it('imports external-ID-only rows only when they identify an existing journal', async () => {
  const { service, client } = await setup()
  await service.run({
    action: 'commit',
    ...(await preview(service, [
      row({ externalIds: [{ namespace: 'jcr', value: 'known' }] }),
      row({
        row: 3,
        name: 'Imaginary Other Review',
        aliases: [],
        issns: [],
        externalIds: [{ namespace: 'nlm', value: 'other' }]
      })
    ])),
    skipProblems: false
  })
  const rows = [
    [{ namespace: 'JCR', value: 'known' }],
    [{ namespace: 'jcr', value: 'unknown' }],
    [{ namespace: 'scopus', value: 'known' }],
    [],
    [
      { namespace: 'jcr', value: 'known' },
      { namespace: 'nlm', value: 'other' }
    ]
  ].map((externalIds, index) =>
    row({
      row: index + 2,
      name: '',
      aliases: [],
      issns: [],
      externalIds,
      values: { signal: '9.4' }
    })
  )
  const draft = await preview(service, rows, { definition: { ...definition, year: 2032 } })
  const reviewed = await service.run({ action: 'preview', token: draft.token, offset: 0 })
  expect(reviewed.rows?.map(({ status }) => status)).toEqual([
    'matched',
    'invalid',
    'invalid',
    'invalid',
    'ambiguous'
  ])
  expect(reviewed.ready).toBe(1)
  const saved = await service.run({ action: 'commit', ...draft, skipProblems: true })
  expect(saved.imported).toBe(1)
  expect(await client.$queryRaw`SELECT name FROM "Journal" ORDER BY name`).toEqual([
    { name: 'Imaginary Other Review' },
    { name: row().name }
  ])
  const resolved = await service.run({
    action: 'resolve',
    identities: [{ name: row().name, aliases: [], issns: [] }]
  })
  expect(resolved.matches![0].attributes).toEqual([
    expect.objectContaining({ value: '9.4', year: 2032 })
  ])
})
it('blocks name fallback with conflicting external IDs without changing stronger matches', async () => {
  const { service } = await setup()
  await service.run({
    action: 'commit',
    ...(await preview(service, [row({ externalIds: [{ namespace: 'jcr', value: 'original' }] })])),
    skipProblems: false
  })
  const conflict = {
    name: row().name,
    aliases: [],
    issns: [],
    externalIds: [{ namespace: 'JCR', value: 'different' }]
  }
  const result = await service.run({
    action: 'resolve',
    identities: [
      conflict,
      { ...conflict, issns: row().issns },
      { ...conflict, externalIds: [{ namespace: 'nlm', value: 'different' }] },
      { ...conflict, externalIds: [{ namespace: 'jcr', value: 'original' }] }
    ]
  })
  expect(result.matches?.map(({ status }) => status)).toEqual([
    'ambiguous',
    'matched',
    'matched',
    'matched'
  ])
  expect(result.matches![0].attributes).toEqual([])
  const draft = await preview(service, [row(conflict)], {
    definition: { ...definition, year: 2032 }
  })
  const review = await service.run({ action: 'preview', token: draft.token, offset: 0 })
  expect(review.rows![0]).toMatchObject({ status: 'ambiguous', warnings: ['identity-conflict'] })
  expect(review.ready).toBe(0)
})
it('blocks conflicting identifiers and every duplicate row rather than taking the last value', async () => {
  const { service } = await setup()
  const draft = await preview(service, [row(), row({ row: 3, values: { signal: '8' } })])
  const review = await service.run({ action: 'preview', token: draft.token, offset: 0 })
  expect(review.rows?.map(({ status }) => status)).toEqual(['duplicate', 'duplicate'])
  await expect(service.run({ action: 'commit', ...draft, skipProblems: true })).rejects.toThrow(
    'Resolve'
  )
  const good = await preview(service)
  await service.run({ action: 'commit', ...good, skipProblems: false })
  const result = await service.run({
    action: 'resolve',
    identities: [{ name: row().name, aliases: [], issns: ['2345-6787'] }]
  })
  expect(result.matches?.[0].status).toBe('ambiguous')
})
it('fills missing values, allows reviewed replacement and keeps blanks from erasing data', async () => {
  const { service } = await setup()
  const first = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  let dataset = first.datasets![0]
  for (const [policy, expected] of [
    ['fill', '<0.5'],
    ['replace', '7.25']
  ] as const) {
    const next = await preview(service, [row({ values: { signal: '7.25', band: 'N/A' } })], {
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      policy
    })
    const saved = await service.run({ action: 'commit', ...next, skipProblems: false })
    dataset = saved.datasets![0]
    const entry = (
      await service.run({
        action: 'entries',
        datasetId: dataset.id,
        query: '',
        offset: 0,
        descending: false
      })
    ).entries![0]
    expect(entry.values).toEqual({ signal: expected, band: 'Gold' })
  }
})
it('retains zero, rejects invalid numeric cells and makes skipping problems explicit', async () => {
  const { service } = await setup()
  const draft = await preview(service, [
    row({ values: { signal: '0' } }),
    row({ row: 3, name: 'Imaginary Marine Almanac', issns: [], values: { signal: 'lots' } })
  ])
  await expect(service.run({ action: 'commit', ...draft, skipProblems: false })).rejects.toThrow(
    'Resolve'
  )
  expect((await service.run({ action: 'commit', ...draft, skipProblems: true })).imported).toBe(1)
  expect(
    (
      await service.run({
        action: 'resolve',
        identities: [{ name: row().name, aliases: [], issns: [] }]
      })
    ).matches?.[0].attributes[0].value
  ).toBe('0')
})

it('keeps import stages bound to their original data root', async () => {
  const first = await setup()
  const second = await setup()
  let current = first.client
  const service = new JournalAttributes(async () => current)
  services.push(service)
  const draft = await preview(service)
  current = second.client
  await expect(service.run({ action: 'commit', ...draft, skipProblems: false })).rejects.toThrow(
    'expired'
  )
  expect((await service.run({ action: 'list' })).datasets).toEqual([])
})
it('shows the latest year per source and applies saved visibility and category colors', async () => {
  const { service } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  const newer = await preview(service, [row({ values: { signal: '2', band: 'Silver' } })], {
    definition: { ...definition, year: 2032 }
  })
  const saved = await service.run({ action: 'commit', ...newer, skipProblems: false })
  const dataset = saved.datasets!.find(({ year }) => year === 2032)!
  await service.run({
    action: 'fields',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    fields: dataset.fields.map((field) =>
      field.id === 'signal'
        ? { ...field, visible: false }
        : { ...field, colors: { Silver: 'blue' as const } }
    )
  })
  const result = await service.run({
    action: 'resolve',
    identities: [{ name: row().name, aliases: [], issns: [] }]
  })
  expect(result.matches?.[0].attributes).toMatchObject([
    { label: 'Editorial band', value: 'Silver', year: 2032, colors: { Silver: 'blue' as const } }
  ])
})

it('resolves an explicitly selected year or hides a source without falling back', async () => {
  const { service } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  await service.run({
    action: 'commit',
    ...(await preview(service, [row({ values: { signal: '8' } })], {
      definition: { ...definition, year: 2032 }
    })),
    skipProblems: false
  })
  const resolve = (year: number | null): Promise<JournalResult> =>
    service.run({
      action: 'resolve',
      identities: [{ name: row().name, aliases: [], issns: [] }],
      sourceYears: { [definition.source]: year }
    })
  expect((await resolve(2031)).matches?.[0].attributes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ year: 2031, label: 'Signal index', value: '<0.5' })
    ])
  )
  expect((await resolve(2032)).matches?.[0].attributes).toEqual(
    expect.arrayContaining([expect.objectContaining({ year: 2032, value: '8' })])
  )
  expect((await resolve(null)).matches?.[0].attributes).toEqual([])
  expect((await resolve(2030)).matches?.[0].attributes).toEqual([])
})

it('coalesces concurrent commits and safely retries a successful commit without writing twice', async () => {
  const { service, client, changed } = await setup()
  const draft = await preview(service)
  const request = { action: 'commit' as const, ...draft, skipProblems: false }
  const [first, concurrent] = await Promise.all([service.run(request), service.run(request)])
  expect(concurrent).toEqual(first)
  expect(await service.run(request)).toEqual(first)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(await client.journal.count()).toBe(1)
  expect(await client.journalDatasetEntry.count()).toBe(1)
  expect(first.datasets?.[0].revision).toBe(1)
  await expect(
    service.run({ action: 'append', token: draft.token, offset: 0, rows: [row()] })
  ).rejects.toThrow('busy')
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

it('does not use skipped rows to teach aliases to another row', async () => {
  const { service } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  const draft = await preview(
    service,
    [
      row({ aliases: ['Invented Mist Almanac'] }),
      row({ row: 3, aliases: [] }),
      row({ row: 4, name: 'Invented Mist Almanac', aliases: [], issns: [] })
    ],
    { definition: { ...definition, year: 2032 } }
  )
  const result = await service.run({ action: 'preview', token: draft.token, offset: 0 })
  expect(result.rows?.map(({ status }) => status)).toEqual(['duplicate', 'duplicate', 'new'])
  expect((await service.run({ action: 'commit', ...draft, skipProblems: true })).imported).toBe(1)
  const matches = await service.run({
    action: 'resolve',
    identities: [{ name: 'Invented Mist Almanac', aliases: [], issns: [] }]
  })
  expect(matches.matches?.[0].attributes[0].year).toBe(2032)
})

it('rejects placeholder identities, drops invalid identifiers, and never silently truncates aliases', async () => {
  const { service, client } = await setup()
  const draft = await preview(service, [
    row({ name: 'N/A', aliases: [], issns: [] }),
    row({ row: 3, name: '---', aliases: [], issns: [] }),
    row({ row: 4, issns: ['invalid identifier'] })
  ])
  const result = await service.run({ action: 'preview', token: draft.token, offset: 0 })
  expect(result.rows?.map(({ status }) => status)).toEqual(['invalid', 'invalid', 'new'])
  await service.run({ action: 'commit', ...draft, skipProblems: true })
  expect(JSON.parse((await client.journal.findFirstOrThrow()).issnsJson)).toEqual([])
  const overflow = await preview(
    service,
    [row({ aliases: Array.from({ length: 20 }, (_, i) => `Invented alias ${i}`), issns: [] })],
    { definition: { ...definition, year: 2032 } }
  )
  expect(
    (await service.run({ action: 'preview', token: overflow.token, offset: 0 })).rows?.[0]
  ).toMatchObject({ status: 'invalid', warnings: ['identity-limit'] })
})

it('keeps append atomic when a chunk repeats a row number', async () => {
  const { service } = await setup()
  const { token } = await service.run({ action: 'begin', definition, policy: 'fill' })
  await expect(
    service.run({ action: 'append', token: token!, offset: 0, rows: [row(), row()] })
  ).rejects.toThrow('repeated')
  expect(
    (await service.run({ action: 'append', token: token!, offset: 0, rows: [row()] })).total
  ).toBe(1)
})

it('reuses reviewed pages and management pages, invalidating them on saved field changes', async () => {
  const { service, client } = await setup()
  const count = Number(process.env.JOURNAL_BENCHMARK_ROWS ?? 1000)
  const generated = Array.from({ length: count }, (_, i) =>
    row({
      row: i + 1,
      name: `Imaginary Benchmark Review ${i}`,
      aliases: [],
      issns: [],
      values: { signal: String(i), band: i % 2 ? 'Silver' : 'Gold' }
    })
  )
  const times: Record<string, number> = {}
  let start = performance.now()
  const { token } = await service.run({ action: 'begin', definition, policy: 'fill' })
  for (let offset = 0; offset < generated.length; offset += 200)
    await service.run({
      action: 'append',
      token: token!,
      offset,
      rows: generated.slice(offset, offset + 200)
    })
  times.append = performance.now() - start
  start = performance.now()
  const draft = await service.run({ action: 'preview', token: token!, offset: 0 })
  times.preview = performance.now() - start
  expect(draft.ready).toBe(count)
  const query = vi.spyOn(client, '$queryRaw')
  const transaction = vi.spyOn(client, '$transaction')
  start = performance.now()
  const page = await service.run({ action: 'preview', token: token!, offset: 50 })
  times.previewPage = performance.now() - start
  expect(page.rows?.[0].row).toBe(51)
  expect(transaction).not.toHaveBeenCalled()
  start = performance.now()
  const saved = await service.run({
    action: 'commit',
    token: token!,
    digest: draft.digest!,
    skipProblems: false
  })
  times.commit = performance.now() - start
  const dataset = saved.datasets![0]
  const entryRequest = {
    action: 'entries' as const,
    datasetId: dataset.id,
    query: '',
    offset: 0,
    descending: true,
    sortField: 'signal'
  }
  start = performance.now()
  const first = await service.run(entryRequest)
  times.entries = performance.now() - start
  expect(first.entries?.[0].values.signal).toBe(String(count - 1))
  query.mockClear()
  start = performance.now()
  const next = await service.run({ ...entryRequest, offset: 50 })
  times.entriesPage = performance.now() - start
  expect(next.entries?.[0].values.signal).toBe(String(count - 51))
  expect(query).toHaveBeenCalledTimes(1)
  const identities = generated
    .slice(0, 200)
    .map(({ name, aliases, issns }) => ({ name, aliases, issns }))
  await service.run({ action: 'resolve', identities })
  query.mockClear()
  start = performance.now()
  const resolved = await service.run({ action: 'resolve', identities })
  times.resolve200 = performance.now() - start
  expect(resolved.matches).toHaveLength(200)
  expect(query).toHaveBeenCalledTimes(1)
  await service.run({
    action: 'fields',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    fields: dataset.fields.map((field) => ({ ...field, visible: false }))
  })
  query.mockClear()
  await service.run(entryRequest)
  expect(query).toHaveBeenCalled()
  expect(
    (await service.run({ action: 'resolve', identities })).matches?.every(
      ({ attributes }) => attributes.length === 0
    )
  ).toBe(true)
  query.mockRestore()
  transaction.mockRestore()
  if (process.env.JOURNAL_BENCHMARK_REPORT)
    await writeFile(
      process.env.JOURNAL_BENCHMARK_REPORT,
      JSON.stringify({ rows: count, milliseconds: times }, null, 2)
    )
}, 120_000)

it('preserves saved presentation when importing updates from an older mapping', async () => {
  const { service } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const customized = await service.run({
    action: 'fields',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    fields: dataset.fields.map((field) => ({
      ...field,
      label: `Revised ${field.label}`,
      visible: false
    }))
  })
  const draft = await preview(service, [row({ values: { signal: '8' } })], {
    datasetId: dataset.id,
    expectedRevision: customized.datasets![0].revision,
    policy: 'replace'
  })
  const updated = await service.run({ action: 'commit', ...draft, skipProblems: false })
  expect(updated.datasets![0].fields).toEqual(customized.datasets![0].fields)
})

it('expires untouched stages proactively, renews active ones and stops its timer on disposal', async () => {
  const { service } = await setup()
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const first = await service.run({ action: 'begin', definition, policy: 'fill' })
  const second = await service.run({ action: 'begin', definition, policy: 'fill' })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(29 * 60_000)
  await service.run({ action: 'append', token: second.token!, offset: 0, rows: [row()] })
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(
    service.run({ action: 'append', token: first.token!, offset: 0, rows: [row()] })
  ).rejects.toThrow('expired')
  expect((await service.run({ action: 'preview', token: second.token!, offset: 0 })).ready).toBe(1)
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  expect(vi.getTimerCount()).toBe(0)
  await expect(service.run({ action: 'preview', token: second.token!, offset: 0 })).rejects.toThrow(
    'expired'
  )
  await service.run({ action: 'begin', definition, policy: 'fill' })
  await service.dispose()
  expect(vi.getTimerCount()).toBe(0)
  await expect(service.run({ action: 'list' })).rejects.toThrow('closed')
})

it('enforces the staging budget across imports and frees the budget after discard', async () => {
  const { service } = await setup()
  const first = await service.run({ action: 'begin', definition, policy: 'fill' })
  const second = await service.run({ action: 'begin', definition, policy: 'fill' })
  const bytes = vi.spyOn(Buffer, 'byteLength').mockReturnValue(64 * 1024 * 1024)
  try {
    await service.run({ action: 'append', token: first.token!, offset: 0, rows: [row()] })
    await expect(
      service.run({ action: 'append', token: second.token!, offset: 0, rows: [row()] })
    ).rejects.toThrow('too large')
    await service.run({ action: 'discard', token: first.token! })
    expect(
      (await service.run({ action: 'append', token: second.token!, offset: 0, rows: [row()] }))
        .total
    ).toBe(1)
  } finally {
    bytes.mockRestore()
  }
})

it('paginates only problem rows without changing the reviewed commit digest', async () => {
  const { service } = await setup()
  const draft = await preview(service, [
    row(),
    ...Array.from({ length: 65 }, (_, i) =>
      row({
        row: i + 3,
        name: `Imaginary Invalid Review ${i}`,
        issns: [],
        aliases: [],
        values: { signal: 'unknown' }
      })
    )
  ])
  const first = await service.run({
    action: 'preview',
    token: draft.token,
    offset: 0,
    problemsOnly: true
  })
  const second = await service.run({
    action: 'preview',
    token: draft.token,
    offset: 50,
    problemsOnly: true
  })
  expect(first.rows).toHaveLength(50)
  expect(second.rows).toHaveLength(15)
  expect(second.rows?.[0].row).toBe(53)
  expect(first.problems).toBe(65)
  expect(first.digest).toBe(draft.digest)
  expect((await service.run({ action: 'commit', ...draft, skipProblems: true })).imported).toBe(1)
})

it('retains an in-flight commit through expiry and waits for rollback before disposal', async () => {
  const { service, client, changed } = await setup()
  const draft = await preview(service)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = client.$transaction.bind(client)
  const transaction = vi.spyOn(client, '$transaction').mockImplementation((async (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>
  ) => {
    entered()
    await gate
    return original(callback)
  }) as typeof client.$transaction)
  const request = { action: 'commit' as const, ...draft, skipProblems: false }
  const pending = service.run(request)
  await started
  const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
  const retry = service.run(request)
  // Let the retry reach the shared committing promise before shutting down.
  await Promise.resolve()
  let closed = false
  const closing = service.dispose().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  release()
  try {
    const results = await Promise.allSettled([pending, retry])
    await closing
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected')
        expect(result.reason.message).toBe('Journal service is closed.')
    }
    expect(await client.journalDatasetEntry.count()).toBe(0)
    expect(closed).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  } finally {
    date.mockRestore()
    transaction.mockRestore()
  }
})

it('rolls back written batches before disposal without changing previously committed data', async () => {
  const { service, client, changed } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  const draft = await preview(
    service,
    Array.from({ length: 200 }, (_, index) =>
      row({
        row: index + 2,
        name: `Imaginary shutdown journal ${index}`,
        aliases: [],
        issns: []
      })
    ),
    { definition: { ...definition, source: 'Interrupted fictional source' } }
  )
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = client.$transaction.bind(client)
  const transaction = vi.spyOn(client, '$transaction').mockImplementation((async (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>
  ) =>
    original(async (tx) => {
      const execute = tx.$executeRaw.bind(tx)
      vi.spyOn(tx, '$executeRaw').mockImplementation((async (
        ...args: Parameters<typeof execute>
      ) => {
        const result = await execute(...args)
        if ((args[0] as Prisma.Sql).sql?.includes('INSERT INTO "JournalDatasetEntry"')) {
          entered()
          await gate
        }
        return result
      }) as typeof tx.$executeRaw)
      return callback(tx)
    })) as typeof client.$transaction)
  const pending = service.run({ action: 'commit', ...draft, skipProblems: false })
  await started
  const failed = expect(pending).rejects.toThrow('Journal service is closed.')
  const closing = service.dispose()
  release()
  await Promise.all([failed, closing])
  transaction.mockRestore()
  expect(await client.journalDataset.count()).toBe(1)
  expect(await client.journalDatasetEntry.count()).toBe(1)
  expect(await client.journal.count()).toBe(1)
  expect(changed).toHaveBeenCalledTimes(1)
})

it('shares one cold identity read across concurrent clients and retries failed reads', async () => {
  const { service, client } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  const read = vi.spyOn(client, '$queryRaw')
  const request = {
    action: 'resolve' as const,
    identities: [{ name: '', aliases: [], issns: ['1234-5679'] }]
  }
  read.mockRejectedValueOnce(new Error('temporary read failure'))
  await expect(Promise.all(Array.from({ length: 8 }, () => service.run(request)))).rejects.toThrow(
    'temporary read failure'
  )
  expect(read).toHaveBeenCalledTimes(1)
  read.mockClear()
  const results = await Promise.all(Array.from({ length: 8 }, () => service.run(request)))
  expect(results.every((result) => result.matches?.[0].status === 'matched')).toBe(true)
  expect(
    read.mock.calls.filter(
      ([sql]) => Array.isArray(sql) && sql.join('').includes('SELECT * FROM "Journal"')
    )
  ).toHaveLength(1)
  // Identity + dataset metadata once, then one bounded values read per caller.
  expect(read).toHaveBeenCalledTimes(10)
  read.mockRestore()
})

it('does not publish an old in-flight identity snapshot after a dataset mutation', async () => {
  const { service, client } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const rows = await client.$queryRawUnsafe('SELECT * FROM "Journal"')
  let release!: (rows: unknown) => void
  const pendingRows = new Promise((resolve) => {
    release = resolve
  })
  const read = vi
    .spyOn(client, '$queryRaw')
    .mockReturnValueOnce(pendingRows as ReturnType<PrismaClient['$queryRaw']>)
  const request = {
    action: 'resolve' as const,
    identities: [{ name: row().name, aliases: [], issns: [] }]
  }
  const old = service.run(request)
  const rejected = expect(old).rejects.toThrow('changed')
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  await service.run({
    action: 'fields',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    fields: dataset.fields.map((field) => ({ ...field, label: `Updated ${field.label}` }))
  })
  const current = await service.run(request)
  release(rows)
  await rejected
  expect(current.matches?.[0].attributes[0].label).toBe('Updated Signal index')
  read.mockClear()
  expect(await service.run(request)).toEqual(current)
  expect(read).toHaveBeenCalledTimes(1)
  read.mockRestore()
})

it('reads all categorical choices independently of table pages and keeps draft versions strict', async () => {
  const { service } = await setup()
  const many = Array.from({ length: 135 }, (_, i) =>
    row({
      row: i + 2,
      name: `Invented Color Review ${i}`,
      issns: [],
      aliases: [],
      values: { signal: String(i), band: `Band ${i}` }
    })
  )
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service, many)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const query = {
    action: 'choices' as const,
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    fieldId: 'band',
    query: '',
    offset: 0
  }
  const first = await service.run(query)
  expect(first.total).toBe(135)
  expect(first.choices).toHaveLength(50)
  expect((await service.run({ ...query, offset: 100 })).choices).toHaveLength(35)
  expect((await service.run({ ...query, query: 'Band 134' })).choices).toEqual(['Band 134'])
  const updated = await service.run({
    action: 'fields',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    fields: dataset.fields.map((field) =>
      field.id === 'band' ? { ...field, colors: { 'Reserved band': 'blue' as const } } : field
    )
  })
  await expect(service.run(query)).rejects.toThrow('changed')
  expect(
    (
      await service.run({
        ...query,
        expectedRevision: updated.datasets![0].revision,
        query: 'Reserved'
      })
    ).choices
  ).toEqual(['Reserved band'])
  const multi = await service.run({
    action: 'commit',
    ...(await preview(service, [row({ values: { band: '["Leaf", "Moon"]' } })], {
      definition: { ...definition, year: 2032, fields: [{ ...fields[1], kind: 'multiSelect' }] }
    })),
    skipProblems: false
  })
  const multiDataset = multi.datasets!.find((d) => d.year === 2032)!
  expect(
    (await service.run({ ...query, datasetId: multiDataset.id, expectedRevision: 1 })).choices
  ).toEqual(['Leaf', 'Moon'])
})

it('uses journal identities from references without mixing article or provider IDs', async () => {
  const { service } = await setup()
  const first = row({ issns: ['1234-5679', '2049-3630'] })
  await service.run({
    action: 'commit',
    ...(await preview(service, [
      first,
      row({ row: 3, name: 'Imaginary Other Review', issns: ['0378-5955'], aliases: [] })
    ])),
    skipProblems: false
  })
  const fromItem = journalIdentityFromItem({
    containerTitle: 'Unrelated displayed title',
    typeFields: { issn: '1234 5679', eissn: '20493630', journalAbbreviation: 'Imag. Lunar Gard.' },
    identifiers: [
      { scheme: 'issn', value: '1234-5679' },
      { scheme: 'doi', value: '0378-5955' },
      { scheme: 'pmid', value: '0378-5955' },
      { scheme: 'nlm', value: '0378-5955' }
    ]
  })
  expect(fromItem.issns).toEqual(['1234-5679', '2049-3630'])
  const result = await service.run({
    action: 'resolve',
    identities: [
      fromItem,
      { ...fromItem, issns: ['2049-3630'] },
      { ...fromItem, issns: ['1234-5679', '0378-5955'] },
      { name: first.name, aliases: [], issns: ['0378-5955'] },
      { name: first.name, aliases: [], issns: ['9999-9994'] },
      { name: 'Imag. Lunar Gard.', aliases: [], issns: [] }
    ]
  })
  expect(result.matches?.map((m) => m.status)).toEqual([
    'matched',
    'matched',
    'ambiguous',
    'matched',
    'ambiguous',
    'matched'
  ])
  expect(
    (
      await service.run({
        action: 'entries',
        datasetId: (await service.run({ action: 'list' })).datasets![0].id,
        offset: 0,
        query: '',
        descending: false
      })
    ).total
  ).toBe(2)
})

it('checks historical journal articles by names and ISSNs, pages results and invalidates after reference edits', async () => {
  const { service, client } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  await client.literatureItem.createMany({
    data: [
      ...Array.from({ length: 55 }, (_, index) => ({
        id: `aligned-${String(index).padStart(3, '0')}`,
        itemType: 'journalArticle',
        title: `Invented reference ${index}`,
        containerTitle: index % 2 ? row().name.toUpperCase() : 'A different displayed title',
        typeFieldsJson: JSON.stringify(index % 2 ? {} : { eissn: '1234 5679' })
      })),
      { id: 'missing-empty', itemType: 'journalArticle', title: 'No identity' },
      {
        id: 'missing-name',
        itemType: 'journalArticle',
        title: 'Unknown identity',
        containerTitle: 'Unlisted invented journal'
      },
      {
        id: 'conflicting-name',
        itemType: 'journalArticle',
        title: 'Conflicting identity',
        containerTitle: row().name,
        typeFieldsJson: JSON.stringify({ issn: '2049-3630' })
      },
      { id: 'ignored-book', itemType: 'book', title: 'Invented book', containerTitle: row().name },
      {
        id: 'ignored-trash',
        itemType: 'journalArticle',
        title: 'Trashed reference',
        deletedAt: new Date()
      },
      {
        id: 'ignored-merged',
        itemType: 'journalArticle',
        title: 'Merged reference',
        deletedAt: new Date(),
        mergedIntoItemId: 'aligned-000'
      }
    ]
  })
  const before = await client.literatureItem.findMany({ orderBy: { id: 'asc' } })
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  expect(report.counts).toEqual({ matched: 55, missing: 2, ambiguous: 1 })
  expect(report.rows.map(({ reason }) => reason)).toEqual(['missing-identity', 'not-found'])
  const matched = (
    await service.run({ action: 'audit', token: report.token, status: 'matched', offset: 0 })
  ).alignment!
  expect(matched.rows).toHaveLength(50)
  expect(matched.rows.slice(0, 2).map(({ reason }) => reason)).toEqual(['issn', 'name'])
  expect(
    (await service.run({ action: 'audit', token: report.token, status: 'matched', offset: 50 }))
      .alignment?.rows
  ).toHaveLength(5)
  const smallPage = (
    await service.run({
      action: 'audit',
      token: report.token,
      status: 'matched',
      offset: 25,
      limit: 25
    })
  ).alignment!
  expect(smallPage.rows).toEqual(matched.rows.slice(25, 50))
  const largePage = (
    await service.run({
      action: 'audit',
      token: report.token,
      status: 'matched',
      offset: 0,
      limit: 100
    })
  ).alignment!
  expect(largePage.rows).toHaveLength(55)
  expect(largePage.counts).toEqual(report.counts)
  const conflicting = (
    await service.run({ action: 'audit', token: report.token, status: 'ambiguous', offset: 0 })
  ).alignment!.rows[0]
  expect(conflicting.reason).toBe('identifier-conflict')
  expect(conflicting.candidates[0].name).toBe(row().name)
  expect((await service.run({ action: 'candidates', query: 'Lunar' })).candidates?.[0].name).toBe(
    row().name
  )
  expect(await client.literatureItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before)
  await client.literatureItem.create({
    data: {
      id: 'new-reference',
      itemType: 'journalArticle',
      title: 'New invented reference',
      typeFieldsJson: JSON.stringify({ journalAbbreviation: 'Imag. Lunar Gard.' })
    }
  })
  service.referencesChanged()
  await expect(
    service.run({ action: 'audit', token: report.token, status: 'matched', offset: 0 })
  ).rejects.toThrow('expired')
  expect(
    (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment?.counts.matched
  ).toBe(56)
})

it('reports duplicated journal IDs as conflicts while sharing and expiring read-only alignment scans', async () => {
  const { service, client } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  await client.journal.create({
    data: {
      id: 'conflicting-journal',
      name: 'Imaginary conflicted periodical',
      normalizedName: 'imaginary conflicted periodical',
      aliasesJson: '[]',
      issnsJson: '["1234-5679"]'
    }
  })
  await client.literatureItem.create({
    data: {
      id: 'shared-identifier',
      itemType: 'journalArticle',
      title: 'Invented identifier conflict',
      identifiers: {
        create: { scheme: 'issn', rawValue: '1234-5679', normalizedValue: '12345679' }
      }
    }
  })
  const read = vi.spyOn(client, '$queryRaw')
  const results = await Promise.all(
    Array.from({ length: 8 }, () => service.run({ action: 'audit', status: 'missing', offset: 0 }))
  )
  expect(new Set(results.map(({ alignment }) => alignment?.token)).size).toBe(1)
  expect(
    read.mock.calls.filter(([sql]) => (sql as Prisma.Sql).sql?.includes('FROM "LiteratureItem" i'))
  ).toHaveLength(1)
  const token = results[0].alignment!.token
  const conflict = (await service.run({ action: 'audit', status: 'ambiguous', offset: 0, token }))
    .alignment!.rows[0]
  expect(conflict.reason).toBe('multiple-candidates')
  expect(conflict.candidateTotal).toBe(2)
  vi.useFakeTimers()
  await service.run({ action: 'audit', status: 'ambiguous', offset: 0, token })
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  await expect(
    service.run({ action: 'audit', status: 'ambiguous', offset: 0, token })
  ).rejects.toThrow('expired')
})

it('rejects an alignment scan changed while reading rather than publishing mixed results', async () => {
  const { service, client } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  await client.literatureItem.create({
    data: {
      id: 'changing-reference',
      itemType: 'journalArticle',
      title: 'Changing invented reference',
      containerTitle: row().name
    }
  })
  const original = client.$queryRaw.bind(client)
  let changed = false
  const read = vi.spyOn(client, '$queryRaw').mockImplementation((async (
    ...args: Parameters<typeof original>
  ) => {
    const result = await original(...args)
    if (!changed && (args[0] as Prisma.Sql).sql?.includes('FROM "LiteratureItem" i')) {
      changed = true
      service.referencesChanged()
    }
    return result
  }) as typeof client.$queryRaw)
  await expect(service.run({ action: 'audit', status: 'matched', offset: 0 })).rejects.toThrow(
    'changed'
  )
  read.mockRestore()
  expect(
    (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment?.counts.matched
  ).toBe(1)
})

it('persists a confirmation only for its reference, rejects stale writes, and restores automatic matching', async () => {
  const { service, client } = await setup()
  const draft = await preview(service)
  await service.run({ action: 'commit', ...draft, skipProblems: false })
  for (const id of ['first', 'second'])
    await client.literatureItem.create({
      data: {
        id,
        itemType: 'journalArticle',
        title: `Synthetic ${id}`,
        containerTitle: '  Unknown fictional review  '
      }
    })
  const target = (await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0]
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  const request: Extract<JournalRequest, { action: 'bind' }> = {
    action: 'bind',
    token: report.token,
    itemId: 'first',
    journalId: target.id,
    expectedMetadataRevision: 1,
    expectedBindingRevision: null
  }
  await service.run(request)
  await expect(service.run(request)).rejects.toThrow('changed')
  const restarted = new JournalAttributes(async () => client)
  services.push(restarted)
  const identity = { name: 'Unknown fictional review', aliases: [], issns: [] }
  const resolved = await restarted.run({
    action: 'resolve',
    identities: [
      { ...identity, itemId: 'first' },
      { ...identity, itemId: 'second' },
      identity,
      { ...identity, name: 'Old snapshot', itemId: 'first' }
    ]
  })
  expect(resolved.matches?.map(({ status }) => status)).toEqual([
    'matched',
    'missing',
    'missing',
    'missing'
  ])
  expect(resolved.matches?.[0].attributes).toHaveLength(2)
  const matched = (await restarted.run({ action: 'audit', status: 'matched', offset: 0 }))
    .alignment!
  expect(matched.counts).toEqual({ matched: 1, missing: 1, ambiguous: 0 })
  expect(matched.rows[0].reason).toBe('manual')
  await restarted.run({
    ...request,
    token: matched.token,
    journalId: null,
    expectedBindingRevision: matched.rows[0].bindingRevision
  })
  expect(
    (await restarted.run({ action: 'resolve', identities: [{ ...identity, itemId: 'first' }] }))
      .matches?.[0].status
  ).toBe('missing')
  const again = (await restarted.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  await restarted.run({ ...request, token: again.token })
  const dataset = (await restarted.run({ action: 'list' })).datasets![0]
  await restarted.run({
    action: 'remove',
    datasetId: dataset.id,
    expectedRevision: dataset.revision
  })
  expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toEqual([])
  expect(await client.literatureItem.count()).toBe(2)
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

it('checks reference revisions and target existence inside the binding transaction', async () => {
  const { service, client } = await setup()
  const draft = await preview(service)
  await service.run({ action: 'commit', ...draft, skipProblems: false })
  await client.literatureItem.create({
    data: { id: 'guarded', title: 'Guarded synthetic reference', itemType: 'journalArticle' }
  })
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  const request: Extract<JournalRequest, { action: 'bind' }> = {
    action: 'bind',
    token: report.token,
    itemId: 'guarded',
    journalId: 'gone',
    expectedMetadataRevision: 1,
    expectedBindingRevision: null
  }
  await expect(service.run(request)).rejects.toThrow('no longer available')
  await client.literatureItem.update({ where: { id: 'guarded' }, data: { metadataRevision: 2 } })
  await expect(service.run(request)).rejects.toThrow('changed')
  expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toEqual([])
})

it('allows only one concurrent confirmation from the same reviewed state', async () => {
  const { service, client } = await setup()
  const draft = await preview(service, [
    row(),
    row({ row: 3, name: 'Imaginary Second Review', aliases: [], issns: [] })
  ])
  await service.run({ action: 'commit', ...draft, skipProblems: false })
  await client.literatureItem.create({
    data: { id: 'concurrent', title: 'Independent concurrent fixture', itemType: 'journalArticle' }
  })
  const candidates = (await service.run({ action: 'candidates', query: 'Imaginary' })).candidates!
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  const results = await Promise.allSettled(
    candidates.map((target) =>
      service.run({
        action: 'bind',
        token: report.token,
        itemId: 'concurrent',
        journalId: target.id,
        expectedMetadataRevision: 1,
        expectedBindingRevision: null
      })
    )
  )
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toHaveLength(1)
})

it('keeps committed confirmations and removals successful when their notification fails', async () => {
  const { service, client, changed } = await setup()
  const draft = await preview(service)
  await service.run({ action: 'commit', ...draft, skipProblems: false })
  await client.literatureItem.create({
    data: {
      id: 'notification-reference',
      title: 'Synthetic notification fixture',
      itemType: 'journalArticle'
    }
  })
  const target = (await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0]
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  changed.mockImplementation(() => {
    throw new Error('Synthetic notification failure')
  })
  await expect(
    service.run({
      action: 'bind',
      token: report.token,
      itemId: 'notification-reference',
      journalId: target.id,
      expectedMetadataRevision: 1,
      expectedBindingRevision: null
    })
  ).resolves.toEqual({})
  expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toHaveLength(1)
  await expect(
    service.run({ action: 'audit', token: report.token, status: 'missing', offset: 0 })
  ).rejects.toThrow('expired')
  const bound = (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment!
  expect(bound.rows[0].reason).toBe('manual')
  await expect(
    service.run({
      action: 'bind',
      token: bound.token,
      itemId: 'notification-reference',
      journalId: null,
      expectedMetadataRevision: 1,
      expectedBindingRevision: bound.rows[0].bindingRevision
    })
  ).resolves.toEqual({})
  expect(await client.$queryRaw`SELECT * FROM "JournalItemBinding"`).toEqual([])
})

it('reports bounded scan progress, isolates cancellation and rejects expired or changed scans', async () => {
  const { service, client } = await setup()
  await client.literatureItem.createMany({
    data: Array.from({ length: 501 }, (_, index) => ({
      id: `scan-${String(index).padStart(4, '0')}`,
      title: 'Synthetic scan',
      itemType: 'journalArticle'
    }))
  })
  const first = (await service.run({ action: 'audit-step' })).scan!
  expect(first).toMatchObject({ processed: 500, done: false })
  const other = (await service.run({ action: 'audit-step' })).scan!
  await service.run({ action: 'audit-cancel', token: first.token })
  await expect(service.run({ action: 'audit-step', token: first.token })).rejects.toThrow('expired')
  const done = (await service.run({ action: 'audit-step', token: other.token })).scan!
  expect(done).toMatchObject({ processed: 501, done: true })
  const page = (
    await service.run({ action: 'audit', token: done.token, status: 'missing', offset: 500 })
  ).alignment!
  expect(page.total).toBe(501)
  expect(page.rows).toHaveLength(1)
  const stale = (await service.run({ action: 'audit-step' })).scan!
  service.referencesChanged()
  await expect(service.run({ action: 'audit-step', token: stale.token })).rejects.toThrow('expired')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const expiring = (await service.run({ action: 'audit-step' })).scan!
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  await expect(service.run({ action: 'audit-step', token: expiring.token })).rejects.toThrow(
    'expired'
  )
})

it('reviews deletion effects and refuses a changed set of manual confirmations', async () => {
  const { service, client } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const before = (
    await service.run({
      action: 'remove-preview',
      datasetId: dataset.id,
      expectedRevision: dataset.revision
    })
  ).removal!
  expect(before).toMatchObject({ journals: 1, bindings: 0 })
  await client.literatureItem.create({
    data: { id: 'delete-review', itemType: 'journalArticle', title: 'Synthetic deletion review' }
  })
  const journal = (await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0]
  const audit = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  await service.run({
    action: 'bind',
    token: audit.token,
    itemId: 'delete-review',
    journalId: journal.id,
    expectedMetadataRevision: 1,
    expectedBindingRevision: null
  })
  await expect(
    service.run({
      action: 'remove',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      expectedRemovalDigest: before.digest
    })
  ).rejects.toThrow('changed')
  expect(await client.journalItemBinding.count()).toBe(1)
  const reviewed = (
    await service.run({
      action: 'remove-preview',
      datasetId: dataset.id,
      expectedRevision: dataset.revision
    })
  ).removal!
  expect(reviewed).toMatchObject({ journals: 1, bindings: 1 })
  await service.run({
    action: 'remove',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    expectedRemovalDigest: reviewed.digest
  })
  expect(await client.journalItemBinding.count()).toBe(0)
  expect(await client.literatureItem.count()).toBe(1)
})

it('preserves explicitly inherited field keys across years without falling back to older values', async () => {
  const { service } = await setup()
  const old = (
    await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  ).datasets![0]
  const inherited = old.fields.map((field) => ({ ...field, columnKey: `${old.id}:${field.id}` }))
  const next = { ...definition, year: 2032, fields: inherited }
  const draft = await preview(service, [row({ values: { signal: '4', band: '' } })], {
    definition: next
  })
  const saved = await service.run({ action: 'commit', ...draft, skipProblems: false })
  const latest = saved.datasets![0]
  const result = await service.run({ action: 'resolve', identities: [rowIdentity()] })
  expect(
    result.matches![0].attributes.map(({ key, value, year }) => ({ key, value, year }))
  ).toEqual([{ key: `${old.id}:signal`, value: '4', year: 2032 }])
  await expect(
    service.run({
      action: 'fields',
      datasetId: latest.id,
      expectedRevision: latest.revision,
      fields: inherited.map((field) => ({ ...field, columnKey: 'different' }))
    })
  ).rejects.toThrow('Journal attribute identities')
  await expect(
    preview(service, [row()], { definition: { ...next, source: 'Another synthetic source' } })
  ).rejects.toThrow('previous year')
  await service.run({ action: 'remove', datasetId: old.id, expectedRevision: old.revision })
  // Deleting the old dataset does not change the key stored in the new year's fields.
  expect(
    (await service.run({ action: 'resolve', identities: [rowIdentity()] })).matches![0]
      .attributes[0].key
  ).toBe(`${old.id}:signal`)
})
function rowIdentity(): Pick<JournalImportRow, 'name' | 'aliases' | 'issns'> {
  const { name, aliases, issns } = row()
  return { name, aliases, issns }
}

it('keeps missing values last in both numeric and text sort directions', async () => {
  const { service } = await setup()
  const rows = [
    ['Zero', '0', 'Alpha'],
    ['Two', '2', 'Beta'],
    ['Ten', '10', 'Zeta'],
    ['Blank', '', ''],
    ['Unknown', 'N/A', 'N/A'],
    ['Dash', '—', '—']
  ].map(([name, signal, band], index) =>
    row({ row: index + 2, name, aliases: [], issns: [], values: { signal, band } })
  )
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service, rows)),
    skipProblems: false
  })
  const datasetId = saved.datasets![0].id
  for (const sortField of ['signal', 'band']) {
    for (const descending of [false, true]) {
      const result = await service.run({
        action: 'entries',
        datasetId,
        sortField,
        descending,
        query: '',
        offset: 0
      })
      expect(result.entries!.slice(0, 3).map((entry) => entry.name)).toEqual(
        descending ? ['Ten', 'Two', 'Zero'] : ['Zero', 'Two', 'Ten']
      )
      expect(
        result
          .entries!.slice(3)
          .map((entry) => entry.name)
          .sort()
      ).toEqual(['Blank', 'Dash', 'Unknown'])
    }
  }
})

it('validates type changes before saving and preserves values and field order', async () => {
  const { service } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  await expect(
    service.run({
      action: 'fields',
      datasetId: dataset.id,
      expectedRevision: 1,
      fields: dataset.fields.map((field) =>
        field.id === 'band' ? { ...field, kind: 'number' } : field
      )
    })
  ).rejects.toThrow('selected type')
  expect((await service.run({ action: 'list' })).datasets![0].revision).toBe(1)
  const revised = dataset.fields
    .map((field) => (field.id === 'signal' ? { ...field, kind: 'text' as const } : field))
    .reverse()
  const result = await service.run({
    action: 'fields',
    datasetId: dataset.id,
    expectedRevision: 1,
    fields: revised
  })
  expect(result.datasets![0].fields).toEqual(revised)
  const entries = await service.run({
    action: 'entries',
    datasetId: dataset.id,
    query: '',
    offset: 0,
    descending: false
  })
  expect(entries.entries![0].values).toEqual(row().values)
})

it('edits source and year atomically, refreshes latest-year resolution, and rejects duplicates', async () => {
  const { service } = await setup()
  const first = (
    await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  ).datasets![0]
  await service.run({
    action: 'commit',
    ...(await preview(service, [row({ values: { signal: '9', band: 'Silver' } })], {
      definition: {
        ...definition,
        year: 2032,
        fields: first.fields.map((field) => ({
          ...field,
          columnKey: journalColumnKey(first.id, field)
        }))
      }
    })),
    skipProblems: false
  })
  const resolve = (): Promise<JournalResult> =>
    service.run({
      action: 'resolve',
      identities: [{ name: row().name, issns: row().issns, aliases: [] }]
    })
  expect((await resolve()).matches![0].attributes[0].value).toBe('9')
  const request = {
    action: 'rename' as const,
    datasetId: first.id,
    expectedRevision: first.revision,
    name: 'Earlier survey',
    source: definition.source,
    year: 2032
  }
  await expect(service.run(request)).rejects.toThrow(
    'A dataset with this source and year already exists.'
  )
  await expect(service.run({ ...request, year: 1799 })).rejects.toThrow()
  await expect(service.run({ ...request, source: ' ' })).rejects.toThrow()
  const unchanged = (await service.run({ action: 'list' })).datasets!.find(
    ({ id }) => id === first.id
  )!
  expect(unchanged).toMatchObject({ revision: first.revision, year: first.year, name: null })
  await service.run({ ...request, year: 2033 })
  expect((await resolve()).matches![0].attributes[0]).toMatchObject({
    value: '<0.5',
    year: 2033,
    source: definition.source
  })
  await service.run({
    ...request,
    expectedRevision: first.revision + 1,
    source: 'Another survey',
    year: 2033
  })
  const attributes = (await resolve()).matches![0].attributes
  expect(new Set(attributes.map(({ key }) => key)).size).toBe(attributes.length)
  expect(new Set(attributes.map(({ source }) => source))).toEqual(
    new Set([definition.source, 'Another survey'])
  )
})

it('paginates journal rows with a bounded requested page size', async () => {
  const { service } = await setup()
  const rows = Array.from({ length: 61 }, (_, index) =>
    row({
      row: index + 2,
      name: `Journal ${String(index).padStart(3, '0')}`,
      issns: [],
      aliases: []
    })
  )
  const dataset = (
    await service.run({ action: 'commit', ...(await preview(service, rows)), skipProblems: false })
  ).datasets![0]
  const request = {
    action: 'entries' as const,
    datasetId: dataset.id,
    limit: 25 as const,
    query: '',
    offset: 0,
    descending: false
  }
  const first = await service.run(request)
  const second = await service.run({ ...request, offset: 25 })
  expect(first.entries).toHaveLength(25)
  expect(second.entries).toHaveLength(25)
  expect(first.total).toBe(61)
  expect(new Set([...first.entries!, ...second.entries!].map(({ id }) => id)).size).toBe(50)
  expect((await service.run({ ...request, offset: 50 })).entries).toHaveLength(11)
  expect(
    journalResultSchema.parse(await service.run({ ...request, limit: 100 })).entries
  ).toHaveLength(61)
  expect(journalRequestSchema.safeParse({ ...request, limit: 1000 }).success).toBe(false)
})

it('round-trips a portable bundle with all rows and presentation into an independent library', async () => {
  const { exportJournalBundle, importJournalBundle, readJournalBundle } =
    await import('../../renderer/src/pages/literature/journal-bundle')
  const origin = await setup()
  const target = await setup()
  const portableFields = [
    { ...fields[1], colors: { Gold: 'blue' as const }, visible: false },
    fields[0]
  ]
  const rows = Array.from({ length: 105 }, (_, index) =>
    row({
      row: index + 1,
      name: `Synthetic Bundle Review ${index}`,
      aliases: [],
      issns: [],
      externalIds: [{ namespace: 'nlm', value: `synthetic-${index}` }]
    })
  )
  const draft = await preview(origin.service, rows, {
    definition: { ...definition, name: 'My journal collection', fields: portableFields }
  })
  const saved = await origin.service.run({ action: 'commit', ...draft, skipProblems: false })
  const dataset = saved.datasets![0]
  const bytes = await exportJournalBundle(
    origin.service.run.bind(origin.service),
    dataset,
    () => false
  )
  const bundle = readJournalBundle(bytes.buffer)
  expect(bundle.dataset).toEqual({
    name: 'My journal collection',
    source: definition.source,
    year: definition.year,
    fields: portableFields
  })
  expect(bundle.rows).toHaveLength(105)
  expect(new Set(bundle.rows.map(({ row }) => row)).size).toBe(105)
  expect(bundle.rows.every((entry) => !('id' in entry))).toBe(true)
  const result = await importJournalBundle(
    target.service.run.bind(target.service),
    bundle,
    () => false
  )
  const imported = result.datasets![0]
  expect(imported.id).not.toBe(dataset.id)
  expect(imported).toMatchObject({ name: dataset.name, fields: portableFields, count: 105 })
  const again = readJournalBundle(
    (await exportJournalBundle(target.service.run.bind(target.service), imported, () => false))
      .buffer
  )
  const content = (value: typeof bundle): JournalImportRow[] =>
    value.rows.map((entry) => ({ ...entry, row: 1 })).sort((a, b) => a.name.localeCompare(b.name))
  expect(content(again)).toEqual(content(bundle))
  await expect(
    importJournalBundle(target.service.run.bind(target.service), bundle, () => false)
  ).rejects.toThrow('already exist')
  expect((await target.service.run({ action: 'list' })).datasets).toHaveLength(1)
  expect(await target.client.$queryRawUnsafe('SELECT * FROM "JournalItemBinding"')).toEqual([])
})

it('rejects stale export pages and imports no partial bundle when a row is invalid', async () => {
  const { exportJournalBundle, importJournalBundle, readJournalBundle } =
    await import('../../renderer/src/pages/literature/journal-bundle')
  const origin = await setup()
  const draft = await preview(origin.service)
  const saved = await origin.service.run({ action: 'commit', ...draft, skipProblems: false })
  const dataset = saved.datasets![0]
  const first = await origin.service.run({
    action: 'export',
    datasetId: dataset.id,
    expectedRevision: dataset.revision
  })
  expect(journalResultSchema.parse(first).exportPage!.rows).toHaveLength(1)
  const bundle = readJournalBundle(
    (await exportJournalBundle(origin.service.run.bind(origin.service), dataset, () => false))
      .buffer
  )
  await origin.service.run({
    action: 'rename',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    name: 'Changed'
  })
  await expect(
    origin.service.run({
      action: 'export',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      snapshot: first.exportPage!.snapshot,
      after: first.exportPage!.next
    })
  ).rejects.toThrow('changed')
  const target = await setup()
  bundle.rows[0].values.signal = 'invalid numeric value'
  await expect(
    importJournalBundle(target.service.run.bind(target.service), bundle, () => false)
  ).rejects.toThrow('invalid or conflicting')
  expect((await target.service.run({ action: 'list' })).datasets).toEqual([])
  expect(await target.client.$queryRawUnsafe('SELECT * FROM "Journal"')).toEqual([])
  const badVersion = new TextEncoder().encode(JSON.stringify({ ...bundle, version: 99 }))
  expect(() => readJournalBundle(badVersion.buffer)).toThrow()
})

it('pages import previews in groups of 25 while retaining counts and the reviewed digest', async () => {
  const { service } = await setup()
  const rows = Array.from({ length: 53 }, (_, index) =>
    row({
      row: index + 2,
      name: `Paging fixture ${index}`,
      aliases: [],
      issns: [],
      values: { signal: index % 2 ? 'unknown' : '1' }
    })
  )
  const draft = await preview(service, rows)
  const request = { action: 'preview' as const, token: draft.token, limit: 25 as const, offset: 0 }
  const first = await service.run(journalRequestSchema.parse(request))
  const second = await service.run({ ...request, offset: 25 })
  const last = await service.run({ ...request, offset: 50 })
  expect(first.rows).toHaveLength(25)
  expect(second.rows).toHaveLength(25)
  expect(last.rows).toHaveLength(3)
  expect([...first.rows!, ...second.rows!, ...last.rows!].map(({ row }) => row)).toEqual(
    rows.map(({ row }) => row)
  )
  expect(
    [first, second, last].every(
      (page) =>
        page.digest === draft.digest &&
        page.total === 53 &&
        page.problems === 26 &&
        page.ready === 27
    )
  ).toBe(true)
  const problems = await service.run({ ...request, problemsOnly: true })
  const remaining = await service.run({ ...request, problemsOnly: true, offset: 25 })
  expect(problems.rows).toHaveLength(25)
  expect(remaining.rows).toHaveLength(1)
  expect(problems.digest).toBe(draft.digest)
  expect(problems.total).toBe(53)
  expect(problems.problems).toBe(26)
  expect(problems.rows!.every(({ warnings }) => warnings.includes('invalid-value'))).toBe(true)
})

it('shares catalog reads across clients and export pages and invalidates after writes', async () => {
  const { service, client } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const read = vi.spyOn(client, '$queryRaw')
  read.mockRejectedValueOnce(new Error('temporary catalog failure'))
  await expect(service.run({ action: 'list' })).rejects.toThrow('temporary catalog failure')
  read.mockClear()
  const lists = await Promise.all(Array.from({ length: 8 }, () => service.run({ action: 'list' })))
  expect(lists.every((result) => result.datasets![0].id === dataset.id)).toBe(true)
  expect(read).toHaveBeenCalledTimes(1)
  read.mockClear()
  const first = (
    await service.run({
      action: 'export',
      datasetId: dataset.id,
      expectedRevision: dataset.revision
    })
  ).exportPage!
  await service.run({
    action: 'export',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    after: first.next,
    snapshot: first.snapshot
  })
  expect(read).toHaveBeenCalledTimes(2) // Row reads only; no repeated dataset counts per export page.
  await service.run({
    action: 'rename',
    datasetId: dataset.id,
    expectedRevision: dataset.revision,
    name: 'Updated catalog'
  })
  read.mockClear()
  expect((await service.run({ action: 'list' })).datasets![0].name).toBe('Updated catalog')
  expect(read).toHaveBeenCalledTimes(1)
  read.mockRestore()
})

it.each(['entries', 'resolve'] as const)(
  'rejects a late %s values read after the dataset changes',
  async (action) => {
    const { service, client } = await setup()
    const saved = await service.run({
      action: 'commit',
      ...(await preview(service)),
      skipProblems: false
    })
    const dataset = saved.datasets![0]
    const request: JournalRequest =
      action === 'entries'
        ? { action, datasetId: dataset.id, offset: 0, query: '', descending: false }
        : { action, identities: [{ name: row().name, aliases: [], issns: [] }] }
    await service.run(request)
    const query = client.$queryRaw.bind(client)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = vi.spyOn(client, '$queryRaw').mockImplementationOnce(
      (...args) =>
        query(...args).then(async (rows) => {
          await gate
          return rows
        }) as ReturnType<PrismaClient['$queryRaw']>
    )
    const pending = service.run(request)
    const rejected = expect(pending).rejects.toThrow('Journal data changed')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await service.run({
      action: 'fields',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      fields: dataset.fields.map((field) => ({ ...field, label: `Updated ${field.label}` }))
    })
    release()
    await rejected
    expect(await service.run(request)).toBeTruthy()
    read.mockRestore()
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

it('compares numeric filter equality by value while preserving text equality', async () => {
  const { service, client } = await setup()
  const rows = [
    row({ values: { signal: '4.80', band: '4.80' } }),
    row({
      row: 3,
      name: 'Imaginary Review of Solar Gardens',
      aliases: [],
      issns: [],
      values: { signal: '1e1', band: 'Gold' }
    })
  ]
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service, rows)),
    skipProblems: false
  })
  await client.literatureItem.createMany({
    data: rows.map((entry, index) => ({
      id: `numeric-filter-${index}`,
      itemType: 'journalArticle',
      title: 'Numeric filter fictional reference',
      containerTitle: entry.name
    }))
  })
  for (const [fieldId, value, expected] of [
    ['signal', '4.8', ['numeric-filter-0']],
    ['signal', '10', ['numeric-filter-1']],
    ['signal', 'Infinity', []],
    ['band', '4.8', []],
    ['band', '4.80', ['numeric-filter-0']]
  ] as const) {
    expect(
      await service.filterItemIds(client, [
        { datasetId: saved.datasets![0].id, fieldId, operator: 'equals', value }
      ])
    ).toEqual(expected)
  }
})
