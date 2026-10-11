import { expect, it, vi } from 'vitest'
import type { JournalRequest } from '../src/contracts.js'
import { setup, preview, row } from './fixtures.js'

it('pages alignment results and invalidates them after reference edits without mutating references', async () => {
  const { service, addReference, references } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  for (let index = 0; index < 55; index++)
    addReference(`aligned-${String(index).padStart(3, '0')}`, {
      name: index % 2 ? row().name.toUpperCase() : 'A different displayed title',
      aliases: [],
      issns: index % 2 ? [] : ['1234-5679']
    })
  addReference('missing-empty')
  addReference('missing-name', { name: 'Unlisted invented journal', aliases: [], issns: [] })
  addReference('conflicting-name', { name: row().name, aliases: [], issns: ['2049-3630'] })
  const before = structuredClone([...references])
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
      .alignment!.rows
  ).toHaveLength(5)
  expect(
    (
      await service.run({
        action: 'audit',
        token: report.token,
        status: 'matched',
        offset: 25,
        limit: 25
      })
    ).alignment!.rows
  ).toEqual(matched.rows.slice(25, 50))
  const large = (
    await service.run({
      action: 'audit',
      token: report.token,
      status: 'matched',
      offset: 0,
      limit: 100
    })
  ).alignment!
  expect(large.rows).toHaveLength(55)
  expect(large.counts).toEqual(report.counts)
  const conflict = (
    await service.run({ action: 'audit', token: report.token, status: 'ambiguous', offset: 0 })
  ).alignment!.rows[0]
  expect(conflict.reason).toBe('identifier-conflict')
  expect(conflict.candidates[0].name).toBe(row().name)
  expect((await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0].name).toBe(
    row().name
  )
  expect([...references]).toEqual(before)
  addReference('new-reference', { name: '', aliases: ['Imag. Lunar Gard.'], issns: [] })
  service.referencesChanged()
  await expect(
    service.run({ action: 'audit', token: report.token, status: 'matched', offset: 0 })
  ).rejects.toThrow('expired')
  expect(
    (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment!.counts.matched
  ).toBe(56)
})

it('shares and expires alignment scans while reporting duplicate identifiers as conflicts', async () => {
  const { service, client, addReference } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  await client.saveJournals([
    {
      id: 'conflicting-journal',
      name: 'Imaginary conflicted periodical',
      aliases: [],
      issns: ['1234-5679']
    }
  ])
  addReference('shared-identifier', { name: '', aliases: [], issns: ['1234-5679'] })
  const results = await Promise.all(
    Array.from({ length: 8 }, () => service.run({ action: 'audit', status: 'missing', offset: 0 }))
  )
  expect(new Set(results.map(({ alignment }) => alignment!.token)).size).toBe(1)
  expect(client.references.read).toHaveBeenCalledTimes(1)
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

it('rejects a scan invalidated by a concurrent reference change and permits a fresh read', async () => {
  const { service, addReference, client } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  addReference('changing', { name: row().name, aliases: [], issns: [] })
  const original = client.references.read
  vi.spyOn(client.references, 'read').mockImplementationOnce(async (...args) => {
    const result = await original(...args)
    service.referencesChanged()
    return result
  })
  await expect(service.run({ action: 'audit', status: 'matched', offset: 0 })).rejects.toThrow(
    'changed'
  )
  expect(
    (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment!.counts.matched
  ).toBe(1)
})

it('isolates manual confirmation to the reviewed reference and restores automatic matching after unbinding', async () => {
  const { service, addReference, createService, bindings, references } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  const identity = { name: 'Unknown fictional review', aliases: [], issns: [] }
  addReference('first', identity)
  addReference('second', identity)
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
  const restarted = createService()
  const resolved = await restarted.run({
    action: 'resolve',
    identities: [
      { ...identity, itemId: 'first' },
      { ...identity, itemId: 'second' },
      identity,
      { ...identity, name: 'Old snapshot', itemId: 'first' }
    ]
  })
  expect(resolved.matches!.map(({ status }) => status)).toEqual([
    'matched',
    'missing',
    'missing',
    'missing'
  ])
  expect(resolved.matches![0].attributes).toHaveLength(2)
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
      .matches![0].status
  ).toBe('missing')
  const again = (await restarted.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  await restarted.run({ ...request, token: again.token })
  const dataset = (await restarted.run({ action: 'list' })).datasets![0]
  await restarted.run({
    action: 'remove',
    datasetId: dataset.id,
    expectedRevision: dataset.revision
  })
  expect(bindings()).toEqual([])
  expect(references.size).toBe(2)
})

it('rejects missing targets and reference revisions changed after review', async () => {
  const { service, addReference, bindings } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  const reference = addReference('guarded')
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  const request: Extract<JournalRequest, { action: 'bind' }> = {
    action: 'bind',
    token: report.token,
    itemId: reference.id,
    journalId: 'gone',
    expectedMetadataRevision: 1,
    expectedBindingRevision: null
  }
  await expect(service.run(request)).rejects.toThrow('no longer available')
  reference.metadataRevision++
  await expect(service.run(request)).rejects.toThrow('changed')
  expect(bindings()).toEqual([])
})

it('allows only one concurrent confirmation from the same reviewed state', async () => {
  const { service, addReference, bindings } = await setup()
  await service.run({
    action: 'commit',
    ...(await preview(service, [
      row(),
      row({ row: 3, name: 'Imaginary Second Review', aliases: [], issns: [] })
    ])),
    skipProblems: false
  })
  addReference('concurrent')
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
  expect(bindings()).toHaveLength(1)
})

it('preserves successful binding changes when application notifications throw', async () => {
  const { service, addReference, bindings, changed, integration } = await setup()
  await service.run({ action: 'commit', ...(await preview(service)), skipProblems: false })
  addReference('notify')
  const target = (await service.run({ action: 'candidates', query: 'Lunar' })).candidates![0]
  const report = (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!
  changed.mockImplementation(() => {
    throw Error('Notification failure')
  })
  const request: Extract<JournalRequest, { action: 'bind' }> = {
    action: 'bind',
    token: report.token,
    itemId: 'notify',
    journalId: target.id,
    expectedMetadataRevision: 1,
    expectedBindingRevision: null
  }
  await expect(service.run(request)).resolves.toEqual({})
  expect(bindings()).toHaveLength(1)
  await expect(
    service.run({ action: 'audit', token: report.token, status: 'missing', offset: 0 })
  ).rejects.toThrow('expired')
  const bound = (await service.run({ action: 'audit', status: 'matched', offset: 0 })).alignment!
  expect(bound.rows[0].reason).toBe('manual')
  await expect(
    service.run({
      ...request,
      token: bound.token,
      journalId: null,
      expectedBindingRevision: bound.rows[0].bindingRevision
    })
  ).resolves.toEqual({})
  expect(bindings()).toEqual([])
  expect(integration.warn).toHaveBeenCalledTimes(2)
})

it('bounds scan progress, isolates cancellation and rejects expired or invalidated scans', async () => {
  const { service, addReference } = await setup()
  for (let i = 0; i < 501; i++) addReference(`scan-${String(i).padStart(4, '0')}`)
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

it('requires renewed deletion review when manual confirmations change', async () => {
  const { service, addReference, bindings, references } = await setup()
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
  addReference('delete-review')
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
  expect(bindings()).toHaveLength(1)
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
  expect(bindings()).toEqual([])
  expect(references.size).toBe(1)
})

it('compares numeric filter equality by value while preserving text equality', async () => {
  const { service, client, addReference } = await setup()
  const rows = [
    row({ values: { signal: '4.80', band: '4.80' } }),
    row({
      row: 3,
      name: 'Imaginary Solar Gardens',
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
  rows.forEach((entry, i) =>
    addReference(`numeric-filter-${i}`, { name: entry.name, aliases: [], issns: [] })
  )
  for (const [fieldId, value, expected] of [
    ['signal', '4.8', ['numeric-filter-0']],
    ['signal', '10', ['numeric-filter-1']],
    ['signal', 'Infinity', []],
    ['band', '4.8', []],
    ['band', '4.80', ['numeric-filter-0']]
  ] as const)
    expect(
      await service.filterItemIds(client, [
        { datasetId: saved.datasets![0].id, fieldId, operator: 'equals', value }
      ])
    ).toEqual(expected)
})

it('uses the current database reference store when the opened database changes', async () => {
  const first = await setup()
  const second = await setup()
  first.addReference('first-library')
  second.addReference('second-library')
  let database = first.client
  const service = first.createService(async () => database)
  expect(
    (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!.rows.map(
      ({ itemId }) => itemId
    )
  ).toEqual(['first-library'])
  database = second.client
  expect(
    (await service.run({ action: 'audit', status: 'missing', offset: 0 })).alignment!.rows.map(
      ({ itemId }) => itemId
    )
  ).toEqual(['second-library'])
})
