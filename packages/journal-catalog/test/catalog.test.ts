import { expect, it, vi } from 'vitest'
import type { JournalDatabase, JournalStore } from '../src/index.js'
import {
  journalIdentityFromItem,
  journalColumnKey,
  journalResultSchema,
  journalRequestSchema,
  normalizeIssn,
  journalNumber,
  type JournalImportRow,
  type JournalRequest,
  type JournalResult
} from '../src/contracts.js'

import { setup, fields, definition, row, preview } from './fixtures.js'
it('validates identifiers and preserves qualified numbers without inventing precision', () => {
  expect(normalizeIssn('1234 5679')).toBe('1234-5679')
  expect(normalizeIssn('1234-5678')).toBeUndefined()
  expect(journalNumber('<0.5')).toEqual({ value: 0.5, comparator: '<' })
  expect(journalNumber('N/A')).toBeUndefined()
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
  expect((await client.listJournals())[0].issns).toEqual([])
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

function rowIdentity(): Pick<JournalImportRow, 'name' | 'aliases' | 'issns'> {
  const { name, aliases, issns } = row()
  return { name, aliases, issns }
}

it('rolls back catalog changes on adapter failure and coalesces a reviewed retry', async () => {
  const { service, client, changed, entries } = await setup()
  const draft = await preview(service)
  const transaction = client.transaction.bind(client)
  const failure = vi.spyOn(client, 'transaction').mockImplementation((operation) =>
    transaction((tx) => {
      tx.saveEntries = async () => {
        throw new Error('storage failure')
      }
      return operation(tx)
    })
  )
  await expect(service.run({ action: 'commit', ...draft, skipProblems: false })).rejects.toThrow(
    'storage failure'
  )
  expect(await client.listJournals()).toEqual([])
  expect(await client.listDatasets()).toEqual([])
  expect(changed).not.toHaveBeenCalled()
  failure.mockRestore()
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      service.run({ action: 'commit', ...draft, skipProblems: false })
    )
  )
  expect(results.every((result) => result.imported === 1)).toBe(true)
  expect(entries()).toHaveLength(1)
  expect(changed).toHaveBeenCalledTimes(1)
})

it('waits for an in-flight transaction to roll back before disposal completes', async () => {
  const { service, client, changed, entries } = await setup()
  const draft = await preview(service)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const transaction = client.transaction.bind(client)
  vi.spyOn(client, 'transaction').mockImplementation((operation) =>
    transaction(async (tx) => {
      const save = tx.saveEntries.bind(tx)
      tx.saveEntries = async (entries) => {
        await save(entries)
        entered()
        await gate
      }
      return operation(tx)
    })
  )
  const pending = service.run({ action: 'commit', ...draft, skipProblems: false })
  const rejected = expect(pending).rejects.toThrow('closed')
  await started
  let disposed = false
  const closing = service.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release()
  await Promise.all([rejected, closing])
  expect(entries()).toEqual([])
  expect(await client.listJournals()).toEqual([])
  expect(changed).not.toHaveBeenCalled()
})

it('previews without writes, persists selected attributes, resolves identity, and removes only the dataset', async () => {
  const { service, changed, createService } = await setup()
  const draft = await preview(service)
  expect((await service.run({ action: 'list' })).datasets).toEqual([])
  const saved = await service.run({ action: 'commit', ...draft, skipProblems: false })
  expect(saved.imported).toBe(1)
  expect(changed).toHaveBeenCalledTimes(1)
  const restarted = createService()
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
  const { service, changed, createService } = await setup()
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
  const restarted = createService()
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
  expect((await client.listJournals()).map(({ name }) => name).sort()).toEqual([
    'Imaginary Other Review',
    row().name
  ])
  const resolved = await service.run({
    action: 'resolve',
    identities: [{ name: row().name, aliases: [], issns: [] }]
  })
  expect(resolved.matches![0].attributes).toEqual([
    expect.objectContaining({ value: '9.4', year: 2032 })
  ])
})

it('keeps import stages bound to their original data root', async () => {
  const first = await setup()
  const second = await setup()
  let current = first.client
  const service = first.createService(async () => current)
  const draft = await preview(service)
  current = second.client
  await expect(service.run({ action: 'commit', ...draft, skipProblems: false })).rejects.toThrow(
    'expired'
  )
  expect((await service.run({ action: 'list' })).datasets).toEqual([])
})

it('coalesces concurrent commits and safely retries a successful commit without writing twice', async () => {
  const { service, changed, client, entries } = await setup()
  const draft = await preview(service)
  const request = { action: 'commit' as const, ...draft, skipProblems: false }
  const [first, concurrent] = await Promise.all([service.run(request), service.run(request)])
  expect(concurrent).toEqual(first)
  expect(await service.run(request)).toEqual(first)
  expect(changed).toHaveBeenCalledTimes(1)
  expect((await client.listJournals()).length).toBe(1)
  expect(entries().length).toBe(1)
  expect(first.datasets?.[0].revision).toBe(1)
  await expect(
    service.run({ action: 'append', token: draft.token, offset: 0, rows: [row()] })
  ).rejects.toThrow('busy')
})

it('reuses reviewed pages and management pages, invalidating them on saved field changes', async () => {
  const { service, client } = await setup()
  const count = 1000
  const generated = Array.from({ length: count }, (_, i) =>
    row({
      row: i + 1,
      name: `Imaginary Benchmark Review ${i}`,
      aliases: [],
      issns: [],
      values: { signal: String(i), band: i % 2 ? 'Silver' : 'Gold' }
    })
  )
  const { token } = await service.run({ action: 'begin', definition, policy: 'fill' })
  for (let offset = 0; offset < generated.length; offset += 200)
    await service.run({
      action: 'append',
      token: token!,
      offset,
      rows: generated.slice(offset, offset + 200)
    })
  const draft = await service.run({ action: 'preview', token: token!, offset: 0 })
  expect(draft.ready).toBe(count)
  const query = vi.spyOn(client, 'readDatasetRows')
  const values = vi.spyOn(client, 'readEntries')
  const transaction = vi.spyOn(client, 'transaction')
  const page = await service.run({ action: 'preview', token: token!, offset: 50 })
  expect(page.rows?.[0].row).toBe(51)
  expect(transaction).not.toHaveBeenCalled()
  const saved = await service.run({
    action: 'commit',
    token: token!,
    digest: draft.digest!,
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const entryRequest = {
    action: 'entries' as const,
    datasetId: dataset.id,
    query: '',
    offset: 0,
    descending: true,
    sortField: 'signal'
  }
  const first = await service.run(entryRequest)
  expect(first.entries?.[0].values.signal).toBe(String(count - 1))
  query.mockClear()
  const next = await service.run({ ...entryRequest, offset: 50 })
  expect(next.entries?.[0].values.signal).toBe(String(count - 51))
  expect(query).toHaveBeenCalledTimes(1)
  const identities = generated
    .slice(0, 200)
    .map(({ name, aliases, issns }) => ({ name, aliases, issns }))
  await service.run({ action: 'resolve', identities })
  query.mockClear()
  values.mockClear()
  const resolved = await service.run({ action: 'resolve', identities })
  expect(resolved.matches).toHaveLength(200)
  expect(values).toHaveBeenCalledTimes(1)
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
}, 120_000)

it('retains an in-flight commit through expiry and waits for rollback before disposal', async () => {
  const { service, client, changed, entries } = await setup()
  const draft = await preview(service)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = client.transaction.bind(client)
  const transaction = vi.spyOn(client, 'transaction').mockImplementation((async (
    callback: (tx: JournalStore) => Promise<unknown>
  ) => {
    entered()
    await gate
    return original(callback)
  }) as typeof client.transaction)
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
    expect(entries().length).toBe(0)
    expect(closed).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  } finally {
    date.mockRestore()
    transaction.mockRestore()
  }
})

it('rolls back written batches before disposal without changing previously committed data', async () => {
  const { service, client, changed, entries } = await setup()
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
  const original = client.transaction.bind(client)
  const transaction = vi.spyOn(client, 'transaction').mockImplementation((async (
    callback: (tx: JournalStore) => Promise<unknown>
  ) =>
    original(async (tx) => {
      const save = tx.saveEntries.bind(tx)
      tx.saveEntries = async (entries) => {
        await save(entries)
        entered()
        await gate
      }
      return callback(tx)
    })) as typeof client.transaction)
  const pending = service.run({ action: 'commit', ...draft, skipProblems: false })
  await started
  const failed = expect(pending).rejects.toThrow('Journal service is closed.')
  const closing = service.dispose()
  release()
  await Promise.all([failed, closing])
  transaction.mockRestore()
  expect((await client.listDatasets()).length).toBe(1)
  expect(entries().length).toBe(1)
  expect((await client.listJournals()).length).toBe(1)
  expect(changed).toHaveBeenCalledTimes(1)
})

it('shares one cold identity read across concurrent clients and retries failed reads', async () => {
  const { service, client } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  const read = vi.spyOn(client, 'listJournals')
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
  expect(read).toHaveBeenCalledTimes(1)
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
  const rows = await client.listJournals()
  let release!: (rows: unknown) => void
  const pendingRows = new Promise((resolve) => {
    release = resolve
  })
  const read = vi
    .spyOn(client, 'listJournals')
    .mockReturnValueOnce(pendingRows as ReturnType<JournalDatabase['listJournals']>)
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
  expect(read).not.toHaveBeenCalled()
  read.mockRestore()
})

it('round-trips a portable bundle with all rows and presentation into an independent library', async () => {
  const { exportJournalBundle, importJournalBundle, readJournalBundle } =
    await import('@aipoch/journal-catalog/files')
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
  expect(target.bindings()).toEqual([])
})

it('rejects stale export pages and imports no partial bundle when a row is invalid', async () => {
  const { exportJournalBundle, importJournalBundle, readJournalBundle } =
    await import('@aipoch/journal-catalog/files')
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
  expect(await target.client.listJournals()).toEqual([])
  const badVersion = new TextEncoder().encode(JSON.stringify({ ...bundle, version: 99 }))
  expect(() => readJournalBundle(badVersion.buffer)).toThrow()
})

it('shares catalog reads across clients and export pages and invalidates after writes', async () => {
  const { service, client } = await setup()
  const saved = await service.run({
    action: 'commit',
    ...(await preview(service)),
    skipProblems: false
  })
  const dataset = saved.datasets![0]
  const read = vi.spyOn(client, 'listDatasets')
  read.mockRejectedValueOnce(new Error('temporary catalog failure'))
  await expect(service.run({ action: 'list' })).rejects.toThrow('temporary catalog failure')
  read.mockClear()
  const lists = await Promise.all(Array.from({ length: 8 }, () => service.run({ action: 'list' })))
  expect(lists.every((result) => result.datasets![0].id === dataset.id)).toBe(true)
  expect(read).toHaveBeenCalledTimes(1)
  read.mockClear()
  const rowReads = vi.spyOn(client, 'readDatasetRows')
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
  expect(read).not.toHaveBeenCalled()
  expect(rowReads).toHaveBeenCalledTimes(2)
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
    const method = action === 'entries' ? 'readDatasetRows' : 'readEntries'
    const original = client[method]
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = vi
      .spyOn(client, method)
      .mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        // The selected method and arguments are paired by the spy.
        const result = await Reflect.apply(original, client, args)
        await gate
        return result
      })
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
