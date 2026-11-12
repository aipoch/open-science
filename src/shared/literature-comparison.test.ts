import { describe, expect, it } from 'vitest'
import {
  comparisonRequestSchema,
  comparisonEvidenceSchema,
  comparisonAttemptSchema,
  comparisonCellView,
  comparisonTaskReference,
  isPendingComparisonCell,
  type ComparisonCell,
  type ComparisonField
} from './literature-comparison'

describe('comparison command boundaries', () => {
  it('allows an empty comparison before documents and fields are selected', () => {
    expect(
      comparisonRequestSchema.parse({
        action: 'create',
        name: 'Methods',
        language: 'en',
        sourcePolicy: 'full-text',
        fields: [],
        itemIds: []
      })
    ).toMatchObject({ fields: [], itemIds: [] })
  })

  it('accepts deletion only for one explicitly identified table', () => {
    expect(comparisonRequestSchema.parse({ action: 'delete', tableId: 'table' })).toEqual({
      action: 'delete',
      tableId: 'table'
    })
    expect(comparisonRequestSchema.safeParse({ action: 'delete' }).success).toBe(false)
    expect(
      comparisonRequestSchema.safeParse({ action: 'delete', tableId: 'table', all: true }).success
    ).toBe(false)
  })

  it('requires the displayed positive integer revision for configuration updates', () => {
    const update = {
      action: 'update',
      tableId: 'table',
      name: 'Methods',
      sourcePolicy: 'abstract',
      fields: [{ id: 'field', name: 'Population', rule: 'Report N' }]
    }
    expect(comparisonRequestSchema.parse({ ...update, expectedRevision: 3 })).toEqual({
      ...update,
      expectedRevision: 3
    })
    for (const expectedRevision of [undefined, 0, -1, 1.5, '3', null])
      expect(comparisonRequestSchema.safeParse({ ...update, expectedRevision }).success).toBe(false)
  })

  it('keeps selected reports in both pilot and field rerun requests', () => {
    for (const request of [
      { action: 'run', tableId: 'table', itemIds: ['report-b'] },
      { action: 'run', tableId: 'table', itemIds: ['report-b'], unattemptedOnly: true },
      { action: 'rerun-field', tableId: 'table', fieldId: 'population', itemIds: ['report-b'] }
    ])
      expect(comparisonRequestSchema.parse(request)).toEqual(request)
  })

  it('accepts the preflight snapshot on every confirmed launch command', () => {
    const checked = {
      tableId: 'table',
      expectedRevision: 3,
      expectedSources: [{ itemId: 'report', sourceKey: 'source' }]
    }
    for (const request of [
      { ...checked, action: 'run' },
      { ...checked, action: 'retry', cellIds: ['cell'] },
      { ...checked, action: 'rerun-field', fieldId: 'population' },
      { ...checked, action: 'resume', useCurrentSources: true }
    ])
      expect(comparisonRequestSchema.parse(request)).toEqual(request)
  })

  it('rejects unbounded or ambiguous extraction and export requests', () => {
    expect(
      comparisonRequestSchema.safeParse({ action: 'run', tableId: 'table', itemIds: [] }).success
    ).toBe(false)
    expect(
      comparisonRequestSchema.safeParse({
        action: 'add-members',
        tableId: 'table',
        itemIds: Array(101).fill('report')
      }).success
    ).toBe(false)
    expect(
      comparisonRequestSchema.safeParse({ action: 'retry', tableId: 'table', cellIds: [] }).success
    ).toBe(false)
    expect(
      comparisonRequestSchema.safeParse({ action: 'export', tableId: 'table', kind: 'outcomes' })
        .success
    ).toBe(false)
    expect(
      comparisonRequestSchema.safeParse({
        action: 'run',
        tableId: 'table',
        prompt: 'override system'
      }).success
    ).toBe(false)
  })

  it('validates bounded paging and rejects negative, fractional, or unknown cursors', () => {
    for (const action of [
      { action: 'read', tableId: 'table' },
      { action: 'read-cell', tableId: 'table', cellId: 'cell' },
      { action: 'export', tableId: 'table', kind: 'matrix', exportToken: 'snapshot' }
    ]) {
      expect(comparisonRequestSchema.parse({ ...action, offset: 10 })).toMatchObject({ offset: 10 })
      for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER])
        expect(comparisonRequestSchema.safeParse({ ...action, offset }).success).toBe(false)
    }
  })

  it('represents abstract quotations without inventing PDF page numbers', () => {
    expect(
      comparisonEvidenceSchema.parse({ pageStart: null, pageEnd: null, quote: 'Randomized trial.' })
    ).toMatchObject({ pageStart: null, pageEnd: null })
    expect(
      comparisonEvidenceSchema.safeParse({ pageStart: 0, pageEnd: 1, quote: 'Trial' }).success
    ).toBe(false)
  })
})

describe('comparison result and review semantics', () => {
  const field: ComparisonField = { id: 'field', name: 'Population', rule: 'Report N', version: 1 }
  const cell = (): ComparisonCell => ({
    id: 'cell',
    itemId: 'paper',
    fieldId: field.id,
    status: 'succeeded',
    history: [
      {
        id: 'attempt',
        fieldVersion: 1,
        sourceKey: 'source',
        at: 'now',
        status: 'succeeded',
        value: '20 patients',
        evidence: []
      }
    ],
    manual: {
      value: '20 patients',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: 'now'
    }
  })

  it('confirms only the successful current attempt and preserves the separate manual value', () => {
    const current = cell()
    current.manual!.value = 'Human correction'
    expect(comparisonCellView(current, field, 'source')).toMatchObject({
      confirmed: true,
      needsReview: false,
      value: 'Human correction'
    })
    expect(current.history[0].value).toBe('20 patients')
    current.manual!.confirmed = false
    expect(comparisonCellView(current, field, 'source').confirmed).toBe(false)
  })

  it('batches pending revisions and new reports without retrying past failures or saved results', () => {
    for (const status of ['pending', 'running', 'succeeded', 'failed', 'unavailable'] as const) {
      expect(isPendingComparisonCell({ ...cell(), status })).toBe(status === 'pending')
      expect(isPendingComparisonCell({ ...cell(), status, history: [] })).toBe(
        status === 'pending' || status === 'unavailable'
      )
    }
  })

  it.each(['pending', 'running', 'failed', 'unavailable'] as const)(
    'does not carry confirmation through a %s cell',
    (status) => {
      const current = cell()
      current.status = status
      expect(comparisonCellView(current, field, 'source')).toMatchObject({
        confirmed: false,
        needsReview: true,
        value: '20 patients'
      })
    }
  )

  it('requires reconfirmation after extraction when the manual value predates the first attempt', () => {
    const current = cell()
    delete current.manual!.attemptId
    expect(comparisonCellView(current, field, 'source')).toMatchObject({
      confirmed: false,
      needsReview: true
    })
    current.manual!.attemptId = current.history[0].id
    expect(comparisonCellView(current, field, 'source').confirmed).toBe(true)
  })

  it('invalidates confirmation on a changed attempt, field definition, or source', () => {
    const current = cell()
    expect(comparisonCellView(current, { ...field, version: 2 }, 'source').confirmed).toBe(false)
    expect(comparisonCellView(current, field, 'new-source').confirmed).toBe(false)
    current.history.push({ ...current.history[0], id: 'new-attempt' })
    expect(comparisonCellView(current, field, 'source').confirmed).toBe(false)
    current.manual!.attemptId = 'new-attempt'
    expect(comparisonCellView(current, field, 'source').confirmed).toBe(true)
    current.history.at(-1)!.status = 'failed'
    expect(comparisonCellView(current, field, 'source').confirmed).toBe(false)
  })

  it('accepts legacy attempts and preserves an immutable field and policy snapshot on new attempts', () => {
    const attempt = cell().history[0]
    expect(comparisonAttemptSchema.parse(attempt).fieldSnapshot).toBeUndefined()
    expect(
      comparisonAttemptSchema.parse({
        ...attempt,
        fieldSnapshot: field,
        sourcePolicy: 'abstract'
      })
    ).toMatchObject({ fieldSnapshot: field, sourcePolicy: 'abstract' })
  })

  it('links a running reference ahead of earlier pending work, without mutating the table', () => {
    const queued = { ...cell(), id: 'queued-cell', itemId: 'queued', status: 'pending' as const }
    const running = { ...cell(), id: 'running-cell', itemId: 'running', status: 'running' as const }
    const table = {
      cells: [queued, running],
      remainingCellIds: [],
      members: [
        { itemId: 'queued', title: 'Queued report', abstract: '', sourceKey: 'source' },
        { itemId: 'running', title: 'Running report', abstract: '', sourceKey: 'source' }
      ]
    }
    const before = structuredClone(table)
    expect(comparisonTaskReference(table)).toEqual({ itemId: 'running', title: 'Running report' })
    expect(table).toEqual(before)
    const completed = { ...running, status: 'succeeded' as const }
    expect(comparisonTaskReference({ ...table, cells: [queued, completed] })).toEqual({
      itemId: 'queued',
      title: 'Queued report'
    })
    expect(
      comparisonTaskReference({
        ...table,
        cells: [{ ...queued, status: 'succeeded' }, completed]
      })
    ).toEqual({ itemId: 'running', title: 'Running report' })
    expect(
      comparisonTaskReference({ cells: [], members: [], remainingCellIds: [] })
    ).toBeUndefined()
  })
})
