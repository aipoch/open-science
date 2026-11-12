import Papa from 'papaparse'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
vi.mock('../../storage/migration-state', () => ({
  isMigrationPending: () => false,
  outsideDataRootWriteContext: (operation: () => unknown) => operation(),
  withDataRootWrite: (operation: () => unknown) => operation(),
  runDataRootStartupRecovery: (operation: () => unknown) => operation()
}))
vi.mock('@aipoch/durable-files', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aipoch/durable-files')>()
  return { ...original, writeDurableJsonFile: vi.fn(original.writeDurableJsonFile) }
})
import { LiteratureComparisons } from './owner'
import { ComparisonGlobalError, type ComparisonExtraction } from './extractor'
import type { ComparisonTable } from '../../../shared/literature-comparison'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const ready = (): ComparisonExtraction => ({
  status: 'succeeded',
  sourceKey: 'source-1',
  value: 'Result',
  coverage: 'abstract',
  model: 'model',
  evidence: [{ quote: 'Result', pageStart: null, pageEnd: null }]
})
const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
type OwnerOptions = ConstructorParameters<typeof LiteratureComparisons>[0]
type Extract = Awaited<ReturnType<OwnerOptions['capture']>>['extract']
async function fixture(extract: Mock<Extract> = vi.fn(async () => ready())): Promise<{
  owner: LiteratureComparisons
  table: ComparisonTable
  read(): Promise<ComparisonTable>
  path: string
  options: OwnerOptions
  extract: Mock<Extract>
  capture: Mock<OwnerOptions['capture']>
}> {
  const root = await mkdtemp(join(tmpdir(), 'comparison-'))
  roots.push(root)
  const path = join(root, 'tables.json')
  const capture = vi.fn(async () => ({ extract }))
  const options = {
    path: () => path,
    capture,
    extractor: {
      member: async (itemId: string) => ({
        itemId,
        title: 'Paper',
        abstract: 'Result',
        sourceKey: 'source-1'
      })
    }
  }
  const owner = new LiteratureComparisons(options)
  await owner.start()
  const created = await owner.run({
    action: 'create',
    name: 'Comparison',
    language: 'en',
    sourcePolicy: 'abstract',
    fields: [{ id: 'field', name: 'Result', rule: 'Extract result' }],
    itemIds: ['paper1', 'paper2']
  })
  const table = created.tables[0]
  const read = async (): Promise<ComparisonTable> => {
    const current = (await owner.run({ action: 'read', tableId: table.id })).tables[0]
    for (const cell of current.cells) {
      cell.history = []
      let offset: number | undefined = 0
      do {
        const page = await owner.run({
          action: 'read-cell',
          tableId: table.id,
          cellId: cell.id,
          offset
        })
        cell.history.push(...page.cell!.history)
        offset = page.nextOffset
      } while (offset !== undefined)
    }
    return current
  }
  return { owner, table, read, path, options, extract, capture }
}
it.each(['matrix', 'evidence'] as const)(
  'shares one immutable table between CSV kinds when %s finishes first',
  async (firstKind) => {
    const f = await fixture()
    try {
      await f.owner.run({ action: 'run', tableId: f.table.id })
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      const edit = {
        action: 'edit-cell' as const,
        tableId: f.table.id,
        cellId: f.table.cells[0].id,
        value: 'Before export',
        confirmed: false,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source-1'
      }
      await f.owner.run(edit)
      const first = await f.owner.run({ action: 'export', tableId: f.table.id, kind: firstKind })
      expect(first.nextOffset).toBeUndefined()
      await f.owner.run({ ...edit, value: 'After export' })
      const secondKind = firstKind === 'matrix' ? 'evidence' : 'matrix'
      const second = await f.owner.run({
        action: 'export',
        tableId: f.table.id,
        kind: secondKind,
        exportToken: first.exportToken
      })
      expect(second.exportToken).toBe(first.exportToken)
      expect(second.csv).toContain('Before export')
      expect(second.csv).not.toContain('After export')
      expect(second.csv!.split('\r\n')[1]).toMatch(/"false"$/)
      const fresh = await f.owner.run({ action: 'export', tableId: f.table.id, kind: secondKind })
      expect(fresh.exportToken).not.toBe(first.exportToken)
      expect(fresh.csv).toContain('After export')
      const retained = await f.owner.run({
        action: 'export',
        tableId: f.table.id,
        kind: firstKind,
        exportToken: first.exportToken
      })
      expect(retained.csv).toContain('Before export')
      expect(retained.csv).not.toContain('After export')
    } finally {
      await f.owner.dispose()
    }
  }
)
it.each(['source', 'rule'] as const)(
  'marks a retained manual value for review after a new machine result following a %s change',
  async (change) => {
    const f = await fixture()
    try {
      await f.owner.run({ action: 'run', tableId: f.table.id })
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      const cell = (await f.read()).cells[0]
      await f.owner.run({
        action: 'edit-cell',
        tableId: f.table.id,
        cellId: cell.id,
        value: 'Original human correction',
        confirmed: true,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source-1',
        expectedAttemptId: cell.history[0].id
      })
      const sourceKey = change === 'source' ? 'source-2' : 'source-1'
      if (change === 'source') {
        const member = f.options.extractor.member
        f.options.extractor.member = async (itemId) => ({ ...(await member(itemId)), sourceKey })
      } else {
        await f.owner.run({
          action: 'update',
          expectedRevision: (await f.read()).revision,
          tableId: f.table.id,
          name: f.table.name,
          sourcePolicy: 'abstract',
          fields: [{ id: 'field', name: 'Result', rule: 'Updated rule' }]
        })
      }
      f.extract.mockResolvedValue({ ...ready(), sourceKey, value: 'New machine result' })
      await f.owner.run({ action: 'run', tableId: f.table.id })
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      const result = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
      expect(result.csv!.split('\r\n')[1]).toContain(
        '"Original human correction","New machine result","Original human correction","succeeded: manual-needs-review","false"'
      )
      const current = (await f.read()).cells[0]
      expect(current.history).toHaveLength(2)
      expect(current.manual?.value).toBe('Original human correction')
    } finally {
      await f.owner.dispose()
    }
  }
)
it('exports unique matrix column identities for metadata names, derived suffixes and unusual IDs', async () => {
  const fields = [
    { id: 'field', name: 'Result', rule: 'Extract result' },
    { id: 'other:[]', name: 'Result reviewed', rule: 'Extract another result' },
    { id: 'quoted"/空', name: 'title', rule: 'Extract a title-like result' },
    { id: '\ud800', name: 'Quoted "label", with\nnewline', rule: 'Extract the last result' }
  ]
  const extract = vi.fn<Extract>(async (_table, field) => ({
    ...ready(),
    value: `value-${fields.findIndex((candidate) => candidate.id === field.id)}`
  }))
  const f = await fixture(extract)
  try {
    await f.owner.run({
      action: 'update',
      expectedRevision: (await f.read()).revision,
      tableId: f.table.id,
      name: f.table.name,
      sourcePolicy: 'abstract',
      fields
    })
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    const result = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
    // Exercise a real header-based CSV consumer: duplicate headers would rename or overwrite columns.
    const parsed = Papa.parse<Record<string, string>>(result.csv!, {
      header: true,
      skipEmptyLines: true
    })
    expect(parsed.errors).toEqual([])
    const headers = parsed.meta.fields!
    expect(headers).toHaveLength(2 + fields.length * 5)
    expect(new Set(headers).size).toBe(headers.length)
    expect(parsed.meta.renamedHeaders).toBeFalsy()
    expect(parsed.data).toHaveLength(2)
    expect(parsed.data[0].title).toBe('Paper')
    for (let i = 0; i < fields.length; i++) {
      expect(parsed.data[0][headers[2 + i * 5]]).toBe(`value-${i}`)
      expect(parsed.data[0][headers[3 + i * 5]]).toBe(`value-${i}`)
      expect(parsed.data[0][headers[4 + i * 5]]).toBe('')
      expect(parsed.data[0][headers[5 + i * 5]]).toBe('succeeded')
      expect(parsed.data[0][headers[6 + i * 5]]).toBe('false')
    }
  } finally {
    await f.owner.dispose()
  }
})
it.each([false, true])(
  'completes interleaved paged exports without mixing snapshots (different table: %s)',
  async (differentTable) => {
    const f = await fixture()
    try {
      const member = f.options.extractor.member
      f.options.extractor.member = async (id) => ({
        ...(await member(id)),
        title: 'Title '.repeat(600)
      })
      await f.owner.run({
        action: 'add-members',
        tableId: f.table.id,
        itemIds: Array.from({ length: 40 }, (_, i) => `extra-${i}`)
      })
      const other = differentTable
        ? (
            await f.owner.run({
              action: 'create',
              name: 'Other table',
              language: 'en',
              sourcePolicy: 'abstract',
              fields: [{ id: 'field', name: 'Result', rule: 'Extract result' }],
              itemIds: ['other', ...Array.from({ length: 40 }, (_, i) => `other-${i}`)]
            })
          ).tables[0]
        : f.table
      const edit = {
        action: 'edit-cell' as const,
        tableId: f.table.id,
        cellId: f.table.cells[0].id,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source-1',
        confirmed: false
      }
      await f.owner.run({ ...edit, value: 'First snapshot value' })
      const first = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
      await f.owner.run({ ...edit, value: 'Second snapshot value' })
      const second = await f.owner.run({ action: 'export', tableId: other.id, kind: 'matrix' })
      expect(first.exportToken).not.toBe(second.exportToken)
      expect(first.nextOffset).toBeDefined()
      expect(second.nextOffset).toBeDefined()
      const downloads = [
        { tableId: f.table.id, page: first, csv: first.csv! },
        { tableId: other.id, page: second, csv: second.csv! }
      ]
      while (downloads.some((download) => download.page.nextOffset !== undefined)) {
        for (const download of downloads) {
          if (download.page.nextOffset === undefined) continue
          const token = download.page.exportToken
          download.page = await f.owner.run({
            action: 'export',
            tableId: download.tableId,
            kind: 'matrix',
            exportToken: token,
            offset: download.page.nextOffset
          })
          expect(download.page.exportToken).toBe(token)
          download.csv += download.page.csv
        }
      }
      const rows = downloads.map((download) => Papa.parse<string[]>(download.csv).data)
      expect(rows[0]).toHaveLength(43)
      expect(rows[1]).toHaveLength(differentTable ? 42 : 43)
      expect(downloads[0].csv).toContain('First snapshot value')
      expect(downloads[0].csv).not.toContain('Second snapshot value')
      expect(downloads[1].csv).not.toContain('First snapshot value')
      if (!differentTable) expect(downloads[1].csv).toContain('Second snapshot value')
      else {
        await expect(
          f.owner.run({
            action: 'export',
            tableId: other.id,
            kind: 'matrix',
            exportToken: first.exportToken
          })
        ).rejects.toThrow('export-expired')
        await f.owner.run({ action: 'delete', tableId: f.table.id })
        const retained = await f.owner.run({
          action: 'export',
          tableId: other.id,
          kind: 'matrix',
          exportToken: second.exportToken
        })
        expect(retained.csv).toBe(second.csv)
      }
    } finally {
      await f.owner.dispose()
    }
  }
)
it('bounds concurrent exports without evicting active snapshots and reclaims expired capacity', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  try {
    const first = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
    await vi.advanceTimersByTimeAsync(1000)
    const later = []
    for (let i = 0; i < 7; i++)
      later.push(await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' }))
    await expect(
      f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
    ).rejects.toThrow('export-limit')
    expect(
      (
        await f.owner.run({
          action: 'export',
          tableId: f.table.id,
          kind: 'evidence',
          exportToken: first.exportToken
        })
      ).exportToken
    ).toBe(first.exportToken)
    await vi.advanceTimersByTimeAsync(299_001)
    await expect(
      f.owner.run({
        action: 'export',
        tableId: f.table.id,
        kind: 'matrix',
        exportToken: first.exportToken
      })
    ).rejects.toThrow('export-expired')
    for (const snapshot of later)
      expect(
        (
          await f.owner.run({
            action: 'export',
            tableId: f.table.id,
            kind: 'matrix',
            exportToken: snapshot.exportToken
          })
        ).exportToken
      ).toBe(snapshot.exportToken)
    await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
    expect(vi.getTimerCount()).toBe(8)
    await f.owner.dispose()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await f.owner.dispose()
    vi.useRealTimers()
  }
})
it('expires shared export tokens after five minutes, including offset zero of another kind', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  try {
    const first = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
    vi.setSystemTime(Date.now() + 300_001)
    await expect(
      f.owner.run({
        action: 'export',
        tableId: f.table.id,
        kind: 'evidence',
        exportToken: first.exportToken
      })
    ).rejects.toThrow('export-expired')
    const fresh = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })
    expect(fresh.exportToken).not.toBe(first.exportToken)
  } finally {
    await f.owner.dispose()
    vi.useRealTimers()
  }
})
it.each(['source', 'rule'] as const)(
  'retains separate machine and manual values without adopting outdated machine output after a %s change',
  async (change) => {
    const f = await fixture()
    try {
      await f.owner.run({ action: 'run', tableId: f.table.id })
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      const cell = (await f.read()).cells[0]
      await f.owner.run({
        action: 'edit-cell',
        tableId: f.table.id,
        cellId: cell.id,
        value: 'Human',
        confirmed: true,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source-1',
        expectedAttemptId: cell.history[0].id
      })
      if (change === 'source') {
        const member = f.options.extractor.member
        f.options.extractor.member = async (itemId) => ({
          ...(await member(itemId)),
          sourceKey: 'source-2',
          title: 'Updated paper'
        })
      } else {
        await f.owner.run({
          action: 'update',
          expectedRevision: (await f.read()).revision,
          tableId: f.table.id,
          name: f.table.name,
          sourcePolicy: 'abstract',
          fields: [{ id: 'field', name: 'Result', rule: 'Changed extraction rule' }]
        })
      }
      const result = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
      const rows = result.csv!.split('\r\n')
      expect(rows[0]).toBe(
        '\uFEFF"itemId","title","field:[""field"",""value""] Result","field:[""field"",""machine value""] Result","field:[""field"",""manual value""] Result","field:[""field"",""status""] Result","field:[""field"",""reviewed""] Result"'
      )
      const title = change === 'source' ? 'Updated paper' : 'Paper'
      expect(rows[1]).toBe(
        `"paper1","${title}","Human","Result","Human","pending: outdated: manual-needs-review","false"`
      )
      expect(rows[2]).toBe(`"paper2","${title}","","Result","","pending: outdated","false"`)
    } finally {
      await f.owner.dispose()
    }
  }
)
it('keeps failed, unavailable and unattempted rows in both CSVs without treating manual values as reviewed', async () => {
  const f = await fixture(
    vi.fn(async () => ({
      status: 'failed',
      sourceKey: 'source-1',
      value: null,
      issue: 'extraction-failed',
      evidence: []
    }))
  )
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    await f.owner.run({ action: 'add-members', tableId: f.table.id, itemIds: ['paper3'] })
    await f.owner.run({
      action: 'edit-cell',
      tableId: f.table.id,
      cellId: f.table.cells[0].id,
      value: 'Human',
      confirmed: true,
      expectedFieldVersion: 1,
      expectedSourceKey: 'source-1'
    })
    const member = f.options.extractor.member
    f.options.extractor.member = async (itemId) => {
      if (itemId === 'paper3') throw new Error('source-unavailable')
      return member(itemId)
    }
    const matrix = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
    const rows = matrix.csv!.split('\r\n')
    expect(rows).toHaveLength(4)
    expect(rows[1]).toBe(
      '"paper1","Paper","Human","","Human","failed: manual-needs-review: extraction-failed","false"'
    )
    expect(rows[2]).toBe('"paper2","Paper","","","","pending","false"')
    expect(rows[3]).toBe('"paper3","Paper","","","","unavailable","false"')
    const evidence = await f.owner.run({
      action: 'export',
      tableId: f.table.id,
      kind: 'evidence',
      exportToken: matrix.exportToken
    })
    expect(evidence.csv!.split('\r\n')).toHaveLength(4)
    expect(evidence.csv).toContain('"failed"')
    expect(evidence.csv).toContain('"pending"')
    expect(evidence.csv).toContain('"unavailable"')
    expect(
      evidence
        .csv!.split('\r\n')
        .slice(1)
        .every((row) => row.endsWith('"false"'))
    ).toBe(true)
  } finally {
    await f.owner.dispose()
  }
})
it('creates empty tables and persists independent manual edits without replacing machine history', async () => {
  const f = await fixture()
  const empty = await f.owner.run({
    action: 'create',
    name: 'Empty',
    language: 'en',
    sourcePolicy: 'abstract',
    fields: [],
    itemIds: []
  })
  expect(empty.tables[0].cells).toEqual([])
  await f.owner.run({
    action: 'edit-cell',
    tableId: f.table.id,
    cellId: f.table.cells[0].id,
    value: 'Human',
    confirmed: true,
    expectedFieldVersion: 1,
    expectedSourceKey: 'source-1'
  })
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const cell = (await f.read()).cells[0]
  expect(cell.manual?.value).toBe('Human')
  expect(cell.history[0].value).toBe('Result')
  expect(f.capture).toHaveBeenCalledTimes(1)
  await f.owner.dispose()
})
it('returns the persisted manual value for an edit outside the first table page', async () => {
  const f = await fixture()
  try {
    await f.owner.run({
      action: 'add-members',
      tableId: f.table.id,
      itemIds: Array.from({ length: 9 }, (_, index) => `extra-${index}`)
    })
    const page = await f.owner.run({ action: 'read', tableId: f.table.id, offset: 10 })
    const cellId = page.tables[0].cells[0].id
    const receipt = await f.owner.run({
      action: 'edit-cell',
      tableId: f.table.id,
      cellId,
      value: 'New manual value',
      confirmed: false,
      expectedFieldVersion: 1,
      expectedSourceKey: 'source-1'
    })
    expect(receipt.tables[0].cells.some((cell) => cell.id === cellId)).toBe(false)
    expect(receipt.cell).toMatchObject({
      id: cellId,
      history: [],
      manual: { value: 'New manual value', confirmed: false }
    })
    const saved = await f.owner.run({ action: 'read-cell', tableId: f.table.id, cellId })
    expect(receipt.cell?.manual).toEqual(saved.cell?.manual)
  } finally {
    await f.owner.dispose()
  }
})
it('pauses admission while an in-flight cell becomes durable and resumes only remaining targets', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(ready())
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  await f.owner.run({ action: 'pause', tableId: f.table.id })
  pending.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).cells[0].status).toBe('succeeded'))
  expect(extract).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await readFile(f.path, 'utf8')).tables[0].remainingCellIds).toHaveLength(1)
  await f.owner.run({ action: 'resume', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  expect(extract).toHaveBeenCalledTimes(2)
  await f.owner.dispose()
})
it('completes a paused task when its last in-flight result is saved', async () => {
  const pending = deferred<ComparisonExtraction>()
  const f = await fixture(vi.fn(() => pending.promise))
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledTimes(1))
    await f.owner.run({ action: 'pause', tableId: f.table.id })
    pending.resolve(ready())
    await vi.waitFor(async () => expect((await f.read()).cells[0].status).toBe('succeeded'))
    const saved = JSON.parse(await readFile(f.path, 'utf8')).tables[0]
    expect(saved.remainingCellIds).toEqual([])
    expect(saved.state).toBe('completed')
    const latePause = await f.owner.run({ action: 'pause', tableId: f.table.id })
    expect(latePause.tables[0].state).toBe('completed')
  } finally {
    pending.resolve(ready())
    await f.owner.dispose()
  }
})
it('preserves a paused queue until resume before allowing new extraction', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi
    .fn<Extract>()
    .mockRejectedValueOnce(new Error('bad output'))
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(ready())
  const f = await fixture(extract)
  try {
    await f.owner.run({ action: 'add-members', tableId: f.table.id, itemIds: ['paper3'] })
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2))
    await f.owner.run({ action: 'pause', tableId: f.table.id })
    pending.resolve(ready())
    await vi.waitFor(async () => expect((await f.read()).cells[1].status).toBe('succeeded'))
    const paused = await f.read()
    expect(paused.remainingCellIds).toEqual([paused.cells[2].id])
    const before = await readFile(f.path, 'utf8')
    const launchChecks = {
      tableId: f.table.id,
      expectedRevision: paused.revision,
      expectedSources: paused.members.map(({ itemId, sourceKey }) => ({ itemId, sourceKey }))
    }
    for (const request of [
      { ...launchChecks, action: 'run' as const },
      { ...launchChecks, action: 'retry' as const, cellIds: [paused.cells[0].id] },
      { ...launchChecks, action: 'rerun-field' as const, fieldId: 'field' }
    ])
      await expect(f.owner.run(request)).rejects.toThrow('comparison-busy')
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect(extract.mock.calls.map(([, , id]) => id)).toEqual(['paper1', 'paper2'])

    await f.owner.run({ ...launchChecks, action: 'resume' })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    await f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: [paused.cells[0].id] })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    expect(extract.mock.calls.map(([, , id]) => id)).toEqual([
      'paper1',
      'paper2',
      'paper3',
      'paper1'
    ])
  } finally {
    pending.resolve(ready())
    await f.owner.dispose()
  }
})
it.each(['paused', 'interrupted'] as const)(
  'repairs a persisted %s task with no remaining work on startup',
  async (state) => {
    const f = await fixture()
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    await f.owner.dispose()

    const saved = JSON.parse(await readFile(f.path, 'utf8'))
    saved.tables[0].state = state
    await writeFile(f.path, JSON.stringify(saved))
    const restored = new LiteratureComparisons(f.options)
    try {
      await restored.start()
      const result = await restored.run({ action: 'read', tableId: f.table.id })
      expect(result.tables[0].state).toBe('completed')
      expect(JSON.parse(await readFile(f.path, 'utf8')).tables[0].state).toBe('completed')
      expect(f.extract).toHaveBeenCalledTimes(2)
    } finally {
      await restored.dispose()
    }
  }
)

it('retries each selected failed cell exactly once even if an earlier retry fails again', async () => {
  const extract = vi.fn().mockRejectedValue(new Error('bad response'))
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  await f.owner.run({
    action: 'retry',
    tableId: f.table.id,
    cellIds: f.table.cells.map((c) => c.id)
  })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  expect(extract).toHaveBeenCalledTimes(4)
  expect((await f.read()).cells.map((c) => c.history.length)).toEqual([2, 2])
  await f.owner.dispose()
})
it('keeps late old-field results in history while the revised field remains pending', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi.fn(() => pending.promise)
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  await f.owner.run({
    action: 'update',
    expectedRevision: (await f.read()).revision,
    tableId: f.table.id,
    name: 'Revised',
    sourcePolicy: 'abstract',
    fields: [{ id: 'field', name: 'Result', rule: 'New rule' }]
  })
  pending.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).cells[0].history).toHaveLength(1))
  expect((await f.read()).cells[0].status).toBe('pending')
  expect((await f.read()).fields[0].version).toBe(2)
  expect((await f.read()).state).toBe('idle')
  expect((await f.read()).cells[0].history[0]).toMatchObject({
    fieldSnapshot: { id: 'field', name: 'Result', rule: 'Extract result', version: 1 },
    sourcePolicy: 'abstract'
  })
  const exported = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })
  expect(exported.csv!.split('\r\n')[1]).toContain(
    '"field","Result","Extract result","abstract","1"'
  )
  await f.owner.dispose()
})
it('pauses global model errors, preserving the unattempted queue for explicit resume', async () => {
  const extract = vi.fn().mockRejectedValue(new ComparisonGlobalError('model unavailable'))
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('paused'))
  expect((await f.read()).remainingCellIds).toHaveLength(2)
  expect(extract).toHaveBeenCalledTimes(1)
  await f.owner.dispose()
})
it('resumes other cells when a global failure exhausted one cell history', async () => {
  const extract = vi
    .fn<Extract>()
    .mockRejectedValueOnce(new ComparisonGlobalError('model unavailable'))
    .mockRejectedValueOnce(new ComparisonGlobalError('model unavailable'))
    .mockResolvedValue(ready())
  const f = await fixture(extract)
  let restored: LiteratureComparisons | undefined
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('paused'))
    await f.owner.dispose()

    const saved = JSON.parse(await readFile(f.path, 'utf8'))
    const first = saved.tables[0].cells[0].history[0]
    saved.tables[0].cells[0].history = Array.from({ length: 29 }, (_, index) => ({
      ...first,
      id: `attempt-${index}`
    }))
    await writeFile(f.path, JSON.stringify(saved))

    const owner = new LiteratureComparisons(f.options)
    restored = owner
    await owner.start()
    const read = async (): Promise<ComparisonTable> =>
      (await owner.run({ action: 'read', tableId: f.table.id })).tables[0]
    await owner.run({ action: 'resume', tableId: f.table.id })
    await vi.waitFor(async () => expect((await read()).state).toBe('paused'))
    const capped = (await read()).cells[0]
    expect(capped.history.at(-1)?.issue).toBe('model-unavailable')

    await owner.run({ action: 'resume', tableId: f.table.id })
    await vi.waitFor(async () => expect((await read()).state).toBe('completed'))
    const persisted = JSON.parse(await readFile(f.path, 'utf8')).tables[0]
    expect(persisted.issue).toBe('comparison-history-limit')
    expect(persisted.remainingCellIds).toEqual([])
    expect(persisted.cells[0].history).toHaveLength(30)
    expect(persisted.cells.map((cell: ComparisonTable['cells'][number]) => cell.status)).toEqual([
      'failed',
      'succeeded'
    ])
    expect(extract.mock.calls.map(([, , id]) => id)).toEqual(['paper1', 'paper1', 'paper2'])
  } finally {
    await f.owner.dispose()
    await restored?.dispose()
  }
})
it('drains disposal and marks restart interrupted without issuing inference', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi.fn(() => pending.promise)
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  const closing = f.owner.dispose()
  pending.resolve(ready())
  await closing
  await expect(f.owner.run({ action: 'list' })).rejects.toThrow('owner-unavailable')
  const restored = new LiteratureComparisons(f.options)
  await restored.start()
  expect((await restored.run({ action: 'read', tableId: f.table.id })).tables[0].state).toBe(
    'interrupted'
  )
  expect(extract).toHaveBeenCalledTimes(1)
  await restored.dispose()
})
it('invalidates source-dependent completion and manual confirmation after external source revision', async () => {
  const f = await fixture()
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const first = (await f.read()).cells[0]
  await f.owner.run({
    action: 'edit-cell',
    tableId: f.table.id,
    cellId: first.id,
    value: 'Result',
    confirmed: true,
    expectedFieldVersion: 1,
    expectedSourceKey: 'source-1',
    expectedAttemptId: first.history[0].id
  })
  f.options.extractor.member = async (itemId) => ({
    itemId,
    title: 'Revised',
    abstract: 'Revised',
    sourceKey: 'source-2'
  })
  const refreshed = await f.read()
  expect(refreshed.cells[0].status).toBe('pending')
  expect(refreshed.cells[0].manual?.confirmed).toBe(false)
  expect(refreshed.cells[0].history).toHaveLength(1)
  await expect(
    f.owner.run({
      action: 'edit-cell',
      tableId: f.table.id,
      cellId: first.id,
      value: 'Result',
      confirmed: true,
      expectedFieldVersion: 1,
      expectedSourceKey: 'source-2',
      expectedAttemptId: first.history[0].id
    })
  ).rejects.toThrow('review-changed')
  await f.owner.dispose()
})
it('requires explicit rebinding when an unfinished target source has changed', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(ready())
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  await f.owner.run({ action: 'pause', tableId: f.table.id })
  pending.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).cells[0].status).toBe('succeeded'))
  f.options.extractor.member = async (itemId) => ({
    itemId,
    title: 'Revised',
    abstract: 'Revised',
    sourceKey: 'source-2'
  })
  const refreshed = await f.read()
  await expect(f.owner.run({ action: 'resume', tableId: f.table.id })).rejects.toThrow(
    'comparison-task-changed'
  )
  extract.mockResolvedValue({ ...ready(), sourceKey: 'source-2' })
  await f.owner.run({
    action: 'resume',
    tableId: f.table.id,
    expectedRevision: refreshed.revision,
    expectedSources: refreshed.members.map(({ itemId, sourceKey }) => ({ itemId, sourceKey })),
    useCurrentSources: true
  })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  expect(
    extract.mock.calls[1][0].members.find((m: { itemId: string }) => m.itemId === 'paper2')
      .sourceKey
  ).toBe('source-2')
  await f.owner.dispose()
})
it('keeps a rebound in-flight cell queued when its old result returns', async () => {
  const old = deferred<ComparisonExtraction>()
  const extract = vi
    .fn<Extract>()
    .mockImplementationOnce(() => old.promise)
    .mockImplementation(async (table, _field, itemId) => ({
      ...ready(),
      sourceKey: table.members.find((member) => member.itemId === itemId)!.sourceKey
    }))
  const f = await fixture(extract)
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    const paused = await f.owner.run({ action: 'pause', tableId: f.table.id })
    f.options.extractor.member = async (itemId) => ({
      itemId,
      title: itemId,
      abstract: 'Result',
      sourceKey: 'source-2'
    })
    await f.owner.run({
      action: 'resume',
      tableId: f.table.id,
      expectedRevision: paused.tables[0].revision,
      expectedSources: f.table.itemIds.map((itemId) => ({ itemId, sourceKey: 'source-2' })),
      useCurrentSources: true
    })
    old.resolve(ready())
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    const calls = extract.mock.calls.map(([snapshot, , itemId]) => [
      itemId,
      snapshot.members.find((m) => m.itemId === itemId)?.sourceKey
    ])
    const state = await f.read()
    expect({ calls, statuses: state.cells.map((c) => c.status) }).toEqual({
      calls: [
        ['paper1', 'source-1'],
        ['paper1', 'source-2'],
        ['paper2', 'source-2']
      ],
      statuses: ['succeeded', 'succeeded']
    })
  } finally {
    old.resolve(ready())
    await f.owner.dispose()
  }
})

it.each([
  ['source changed after preflight', 'source-1', 'source-2'],
  ['preflight is newer than the displayed scope', 'source-2', 'source-2'],
  ['source returned to the displayed revision', 'source-2', 'source-1']
])('rejects extraction when %s', async (_scenario, checkedSourceKey, liveSourceKey) => {
  const f = await fixture()
  try {
    const revision = f.table.revision
    const persisted = await readFile(f.path, 'utf8')
    f.options.extractor.member = async (itemId) => ({
      itemId,
      title: itemId,
      abstract: 'Result',
      sourceKey: itemId === 'paper1' ? liveSourceKey : 'source-1'
    })
    await expect(
      f.owner.run({
        action: 'run',
        tableId: f.table.id,
        expectedRevision: revision,
        expectedSources: [
          { itemId: 'paper1', sourceKey: checkedSourceKey },
          { itemId: 'paper2', sourceKey: 'source-1' }
        ]
      })
    ).rejects.toThrow('comparison-task-changed')
    expect(f.capture).not.toHaveBeenCalled()
    expect(await readFile(f.path, 'utf8')).toBe(persisted)
  } finally {
    await f.owner.dispose()
  }
})
it('allows a checked run to proceed for available cells alongside a known missing source', async () => {
  const f = await fixture()
  try {
    const member = f.options.extractor.member
    f.options.extractor.member = async (itemId) => {
      if (itemId === 'paper2') throw new Error('source-unavailable')
      return member(itemId)
    }
    const table = await f.read()
    await f.owner.run({
      action: 'run',
      tableId: table.id,
      expectedRevision: table.revision,
      expectedSources: [
        { itemId: 'paper1', sourceKey: 'source-1' },
        { itemId: 'paper2', sourceKey: '' }
      ]
    })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    expect((await f.read()).cells.map((cell) => cell.status)).toEqual(['succeeded', 'unavailable'])
    expect(f.extract).toHaveBeenCalledTimes(1)
  } finally {
    await f.owner.dispose()
  }
})
it('includes every unattempted cell in evidence export and protects history from field removal', async () => {
  const f = await fixture()
  const exported = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })
  expect(exported.csv?.split('\r\n')).toHaveLength(3)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  await expect(
    f.owner.run({
      action: 'update',
      expectedRevision: (await f.read()).revision,
      tableId: f.table.id,
      name: 'Comparison',
      sourcePolicy: 'abstract',
      fields: []
    })
  ).rejects.toThrow('field-has-history')
  expect((await f.read()).cells[0].history).toHaveLength(1)
  await f.owner.dispose()
})

it('pauses on a rejected cell checkpoint instead of leaving a running worker with no owner', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi.fn(() => pending.promise)
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  vi.mocked(writeDurableJsonFile).mockRejectedValueOnce(new Error('disk unavailable'))
  pending.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).state).toBe('paused'))
  expect((await f.read()).issue).toBe('checkpoint-failed')
  expect((await f.read()).remainingCellIds).toHaveLength(2)
  expect(extract).toHaveBeenCalledTimes(1)
  await f.owner.dispose()
})
it('exports old manual confirmation as unreviewed during and after a new machine attempt', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi
    .fn()
    .mockResolvedValueOnce(ready())
    .mockImplementationOnce(() => pending.promise)
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const cell = (await f.read()).cells[0]
  await f.owner.run({
    action: 'edit-cell',
    tableId: f.table.id,
    cellId: cell.id,
    value: 'Result',
    confirmed: true,
    expectedFieldVersion: 1,
    expectedSourceKey: 'source-1',
    expectedAttemptId: cell.history[0].id
  })
  expect(
    (await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })).csv?.split(
      '\r\n'
    )[1]
  ).toMatch(/"true"$/)
  await f.owner.run({
    action: 'rerun-field',
    tableId: f.table.id,
    fieldId: 'field',
    itemIds: ['paper1']
  })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2))
  expect((await f.read()).cells[0].status).toBe('running')
  expect(
    (await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })).csv?.split(
      '\r\n'
    )[1]
  ).toMatch(/"false"$/)
  pending.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  expect(
    (await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })).csv?.split(
      '\r\n'
    )[1]
  ).toMatch(/"false"$/)
  await f.owner.dispose()
})
it('does not let an old task completion consume the same cell in a newly admitted task', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(ready())
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  const oldTask = (await f.read()).taskId
  await f.owner.run({ action: 'pause', tableId: f.table.id })
  await f.owner.run({
    action: 'update',
    expectedRevision: (await f.read()).revision,
    tableId: f.table.id,
    name: 'Revised',
    sourcePolicy: 'abstract',
    fields: [{ id: 'field', name: 'Result', rule: 'New rule' }]
  })
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  expect((await f.read()).taskId).not.toBe(oldTask)
  pending.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const result = (await f.read()).cells[0]
  expect(extract).toHaveBeenCalledTimes(2)
  expect(result.history.map((h) => h.fieldVersion)).toEqual([1, 2])
  expect(result.status).toBe('succeeded')
  await f.owner.dispose()
})

it.each(['{broken JSON', JSON.stringify({ version: 999, tables: [] })])(
  'isolates an unreadable comparison envelope without replacing it',
  async (content) => {
    const root = await mkdtemp(join(tmpdir(), 'comparison-corrupt-'))
    roots.push(root)
    const path = join(root, 'tables.json')
    await writeFile(path, content)
    const extract = vi.fn(async () => ready())
    const onError = vi.fn()
    const owner = new LiteratureComparisons({
      path: () => path,
      extractor: { member: vi.fn() },
      capture: async () => ({ extract }),
      onError
    })
    await expect(owner.start()).resolves.toBeUndefined()
    await expect(owner.run({ action: 'list' })).rejects.toThrow('comparison-storage-unavailable')
    await expect(
      owner.run({
        action: 'create',
        name: 'Must not overwrite',
        language: 'en',
        sourcePolicy: 'abstract',
        fields: [],
        itemIds: []
      })
    ).rejects.toThrow('comparison-storage-unavailable')
    expect(onError).toHaveBeenCalledOnce()
    expect(await readFile(path, 'utf8')).toBe(content)
    expect(extract).not.toHaveBeenCalled()
    await expect(owner.dispose()).resolves.toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(content)
  }
)

it.each([false, true])(
  'retries only selected recovered unavailable cells (refresh first: %s)',
  async (refreshFirst) => {
    const extract = vi.fn().mockRejectedValue(new Error('full-text-unavailable'))
    const f = await fixture(extract)
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    f.options.extractor.member = async (itemId) => ({
      itemId,
      title: 'Paper',
      abstract: 'Result',
      sourceKey: 'source-2'
    })
    extract.mockResolvedValue({ ...ready(), sourceKey: 'source-2' })
    if (refreshFirst) await f.owner.run({ action: 'list' })
    await f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: [f.table.cells[0].id] })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    expect(extract).toHaveBeenCalledTimes(3)
    expect((await f.read()).cells.map((c) => c.history.length)).toEqual([2, 1])
    await expect(
      f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: [f.table.cells[0].id] })
    ).rejects.toThrow('invalid-retry-targets')
    await expect(
      f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: ['unknown'] })
    ).rejects.toThrow('invalid-retry-targets')
    await f.owner.dispose()
  }
)
it('rejects pending retry targets that have never failed', async () => {
  const f = await fixture()
  await expect(
    f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: [f.table.cells[0].id] })
  ).rejects.toThrow('invalid-retry-targets')
  expect(f.extract).not.toHaveBeenCalled()
  await f.owner.dispose()
})
it.each(['running', 'paused'] as const)(
  'preserves %s task and remaining targets on table rename',
  async (state) => {
    const pending = deferred<ComparisonExtraction>()
    const extract = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(ready())
    const f = await fixture(extract)
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    if (state === 'paused') await f.owner.run({ action: 'pause', tableId: f.table.id })
    const before = await f.read()
    const renamed = (
      await f.owner.run({
        action: 'update',
        expectedRevision: (await f.read()).revision,
        tableId: f.table.id,
        name: 'Renamed',
        sourcePolicy: 'abstract',
        fields: [{ id: 'field', name: 'Result', rule: 'Extract result' }]
      })
    ).tables[0]
    expect(renamed).toMatchObject({
      name: 'Renamed',
      state,
      taskId: before.taskId,
      remainingCellIds: before.remainingCellIds,
      taskSources: before.taskSources
    })
    pending.resolve(ready())
    await vi.waitFor(async () => expect((await f.read()).cells[0].status).toBe('succeeded'))
    if (state === 'paused') {
      await f.owner.dispose()
      const restored = new LiteratureComparisons(f.options)
      await restored.start()
      const saved = (await restored.run({ action: 'read', tableId: f.table.id })).tables[0]
      expect(saved.remainingCellIds).toEqual([f.table.cells[1].id])
      await restored.run({ action: 'resume', tableId: f.table.id })
      await vi.waitFor(async () =>
        expect((await restored.run({ action: 'read', tableId: f.table.id })).tables[0].state).toBe(
          'completed'
        )
      )
      await restored.dispose()
    } else {
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      await f.owner.dispose()
    }
    expect(extract).toHaveBeenCalledTimes(2)
    expect(extract.mock.calls.map((call) => call[2])).toEqual(['paper1', 'paper2'])
  }
)
it('exports attempts with their original field name, rule and source policy after revisions', async () => {
  const f = await fixture()
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  await f.owner.run({
    action: 'update',
    expectedRevision: (await f.read()).revision,
    tableId: f.table.id,
    name: 'Comparison',
    sourcePolicy: 'full-text',
    fields: [{ id: 'field', name: 'Revised result', rule: 'New rule' }]
  })
  const attempt = (await f.read()).cells[0].history[0]
  expect(attempt).toMatchObject({
    fieldSnapshot: { id: 'field', name: 'Result', rule: 'Extract result', version: 1 },
    sourcePolicy: 'abstract'
  })
  const csv = (await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })).csv!
  expect(csv.split('\r\n')[0]).toContain('"fieldId","field","rule","sourcePolicy","fieldVersion"')
  expect(csv.split('\r\n')[1]).toContain('"field","Result","Extract result","abstract","1"')
  await f.owner.dispose()
})
it('snapshots known legacy fields before update and never relabels unknown legacy versions', async () => {
  const f = await fixture()
  await f.owner.dispose()
  const legacy = structuredClone(f.table)
  legacy.fields[0].version = 2
  legacy.cells[0].status = 'succeeded'
  legacy.cells[0].history = [1, 2].map((fieldVersion) => ({
    ...ready(),
    id: 'attempt-' + fieldVersion,
    at: new Date().toISOString(),
    fieldVersion
  }))
  await writeFile(f.path, JSON.stringify({ version: 1, tables: [legacy] }))
  const restored = new LiteratureComparisons(f.options)
  await restored.start()
  await restored.run({
    action: 'update',
    expectedRevision: legacy.revision,
    tableId: f.table.id,
    name: 'New',
    sourcePolicy: 'full-text',
    fields: [{ id: 'field', name: 'New name', rule: 'New rule' }]
  })
  const saved = (await restored.run({ action: 'read', tableId: f.table.id })).tables[0]
  saved.cells[0] = (
    await restored.run({ action: 'read-cell', tableId: f.table.id, cellId: saved.cells[0].id })
  ).cell!
  expect(saved.cells[0].history[0].fieldSnapshot).toBeUndefined()
  expect(saved.cells[0].history[1]).toMatchObject({
    fieldSnapshot: legacy.fields[0],
    sourcePolicy: 'abstract'
  })
  const csv = (await restored.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })).csv!
  expect(csv.split('\r\n')[1]).toContain('"field","","","","1"')
  expect(csv.split('\r\n')[2]).toContain('"field","Result","Extract result","abstract","2"')
  await restored.dispose()
})

it.each(['source-1', 'source-2'])(
  'keeps never-attempted unavailable targets retryable after source recovery: %s',
  async (sourceKey) => {
    const f = await fixture()
    f.options.extractor.member = async () => {
      throw new Error('source-unavailable')
    }
    expect((await f.read()).cells[0].status).toBe('unavailable')
    f.options.extractor.member = async (itemId) => ({
      itemId,
      title: 'Paper',
      abstract: 'Result',
      sourceKey
    })
    expect((await f.owner.run({ action: 'list' })).summaries![0].unavailable).toBe(2)
    f.extract.mockResolvedValue({ ...ready(), sourceKey })
    await f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: [f.table.cells[0].id] })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    expect(f.extract).toHaveBeenCalledTimes(1)
    expect((await f.read()).cells.map((c) => c.history.length)).toEqual([1, 0])
    await f.owner.dispose()
  }
)
it('accepts legacy pending targets only when their latest failure belongs to the current field', async () => {
  const f = await fixture()
  await f.owner.dispose()
  const legacy = structuredClone(f.table)
  legacy.cells[0].history = [
    {
      ...ready(),
      status: 'failed',
      id: 'failed-attempt',
      at: new Date().toISOString(),
      fieldVersion: 1
    }
  ]
  legacy.cells[1].history = [
    { ...legacy.cells[0].history[0], id: 'unknown-field-failure', fieldVersion: 2 }
  ]
  await writeFile(f.path, JSON.stringify({ version: 1, tables: [legacy] }))
  const restored = new LiteratureComparisons(f.options)
  await restored.start()
  await expect(
    restored.run({ action: 'retry', tableId: f.table.id, cellIds: [legacy.cells[1].id] })
  ).rejects.toThrow('invalid-retry-targets')
  await restored.run({ action: 'retry', tableId: f.table.id, cellIds: [legacy.cells[0].id] })
  await vi.waitFor(async () =>
    expect((await restored.run({ action: 'read', tableId: f.table.id })).tables[0].state).toBe(
      'completed'
    )
  )
  expect(f.extract).toHaveBeenCalledTimes(1)
  await restored.dispose()
})
it('exports pre-extraction manual confirmation as unreviewed until the current successful attempt is confirmed', async () => {
  const f = await fixture()
  const edit = {
    action: 'edit-cell' as const,
    tableId: f.table.id,
    cellId: f.table.cells[0].id,
    value: 'Human',
    confirmed: true,
    expectedFieldVersion: 1,
    expectedSourceKey: 'source-1'
  }
  await f.owner.run(edit)
  const reviewed = async (): Promise<string> =>
    (await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'evidence' })).csv!.split(
      '\r\n'
    )[1]
  expect(await reviewed()).toMatch(/"false"$/)
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  expect(await reviewed()).toMatch(/"false"$/)
  await f.owner.run({ ...edit, expectedAttemptId: (await f.read()).cells[0].history.at(-1)!.id })
  expect(await reviewed()).toMatch(/"true"$/)
  await f.owner.run({
    action: 'rerun-field',
    tableId: f.table.id,
    fieldId: 'field',
    itemIds: ['paper1']
  })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  expect(await reviewed()).toMatch(/"false"$/)
  await f.owner.run({ ...edit, expectedAttemptId: (await f.read()).cells[0].history.at(-1)!.id })
  expect(await reviewed()).toMatch(/"true"$/)
  const matrix = (await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })).csv!
  expect(matrix.split('\r\n')[1]).toMatch(/"true"$/)
  await f.owner.dispose()
})

it('releases superseded running cells when another field changes the task generation', async () => {
  const pending = deferred<ComparisonExtraction>()
  const extract = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(ready())
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  await f.owner.run({ action: 'pause', tableId: f.table.id })
  await f.owner.run({
    action: 'update',
    expectedRevision: (await f.read()).revision,
    tableId: f.table.id,
    name: 'Comparison',
    sourcePolicy: 'abstract',
    fields: [
      { id: 'field', name: 'Result', rule: 'Extract result' },
      { id: 'second', name: 'Other', rule: 'Extract other' }
    ]
  })
  pending.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).cells[0].history).toHaveLength(1))
  expect(await f.read()).toMatchObject({ state: 'idle', remainingCellIds: [] })
  expect((await f.read()).cells[0]).toMatchObject({ status: 'pending' })
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const completed = await f.read()
  expect(extract.mock.calls.map((call) => call[1].id)).toEqual(['field', 'field', 'second'])
  expect(
    completed.cells
      .filter((cell) => cell.itemId === 'paper1')
      .every((cell) => cell.status === 'succeeded')
  ).toBe(true)
  expect(completed.cells[0].history).toHaveLength(2)
  expect(
    completed.cells
      .filter((cell) => cell.itemId === 'paper2')
      .every((cell) => cell.history.length === 0)
  ).toBe(true)
  await f.owner.dispose()
})

it.each(['revised', 'deleted'] as const)(
  'invalidates reviewed exports for a %s source while another target is running',
  async (change) => {
    const pending = deferred<ComparisonExtraction>()
    const extract = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockImplementationOnce(() => pending.promise)
    const f = await fixture(extract)
    try {
      await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      const first = (await f.read()).cells[0]
      await f.owner.run({
        action: 'edit-cell',
        tableId: f.table.id,
        cellId: first.id,
        value: 'Result',
        confirmed: true,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source-1',
        expectedAttemptId: first.history[0].id
      })
      await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper2'] })
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2))
      const admitted = await f.read()
      const member = f.options.extractor.member
      f.options.extractor.member = async (itemId) => {
        if (itemId !== 'paper1') return member(itemId)
        if (change === 'deleted') throw new Error('source-unavailable')
        return { ...(await member(itemId)), sourceKey: 'source-2' }
      }
      for (const kind of ['matrix', 'evidence'] as const) {
        const exported = await f.owner.run({ action: 'export', tableId: f.table.id, kind })
        expect(exported.csv!.split('\r\n').find((row) => row.startsWith('"paper1",'))).toMatch(
          /"false"$/
        )
        expect(await f.read()).toMatchObject({
          state: 'running',
          taskId: admitted.taskId,
          taskSources: admitted.taskSources,
          remainingCellIds: admitted.remainingCellIds
        })
        expect((await f.read()).cells[0]).toMatchObject({
          status: change === 'deleted' ? 'unavailable' : 'pending',
          manual: { confirmed: false },
          history: first.history
        })
        expect((await f.read()).cells[1].status).toBe('running')
      }
      pending.resolve(ready())
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      expect(extract).toHaveBeenCalledTimes(2)
      expect((await f.read()).cells[1].status).toBe('succeeded')
    } finally {
      pending.resolve(ready())
      await f.owner.dispose()
    }
  }
)

it.each([
  { change: 'revised', refresh: false },
  { change: 'revised', refresh: true },
  { change: 'deleted', refresh: false },
  { change: 'deleted', refresh: true }
])(
  'rejects late success for its $change source (refresh: $refresh)',
  async ({ change, refresh }) => {
    const pending = deferred<ComparisonExtraction>()
    const extract = vi.fn<Extract>(() => pending.promise)
    const f = await fixture(extract)
    try {
      await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
      const admitted = await f.read()
      const member = f.options.extractor.member
      f.options.extractor.member = async (itemId) => {
        if (itemId !== 'paper1') return member(itemId)
        if (change === 'deleted') throw new Error('source-unavailable')
        return { ...(await member(itemId)), sourceKey: 'source-2' }
      }
      if (refresh) {
        await f.owner.run({ action: 'list' })
        const during = await f.read()
        expect(during).toMatchObject({
          state: 'running',
          taskId: admitted.taskId,
          taskSources: admitted.taskSources,
          remainingCellIds: admitted.remainingCellIds
        })
        expect(during.cells[0].status).toBe('running')
      }
      pending.resolve(ready())
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      const completed = await f.read()
      expect(completed.remainingCellIds).toEqual([])
      expect(completed.taskSources).toEqual(admitted.taskSources)
      expect(completed.cells[0].status).toBe('unavailable')
      expect(completed.cells[0].history).toHaveLength(1)
      expect(completed.cells[0].history[0]).toMatchObject({
        status: 'failed',
        sourceKey: 'source-1',
        issue: change === 'deleted' ? 'source-unavailable' : 'source-changed'
      })
      expect(completed.cells.some((cell) => cell.status === 'running')).toBe(false)
      expect(extract.mock.calls[0][0].members[0].sourceKey).toBe('source-1')
    } finally {
      pending.resolve(ready())
      await f.owner.dispose()
    }
  }
)

it.each([
  { issue: 'extraction-failed', status: 'failed' },
  { issue: 'full-text-unavailable', status: 'unavailable' }
])(
  'retains $status retry eligibility when its source changes during another extraction',
  async ({ issue, status }) => {
    const pending = deferred<ComparisonExtraction>()
    const extract = vi
      .fn()
      .mockRejectedValueOnce(new Error(issue))
      .mockImplementationOnce(() => pending.promise)
    const f = await fixture(extract)
    try {
      await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      expect((await f.read()).cells[0].status).toBe(status)
      await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper2'] })
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2))
      const member = f.options.extractor.member
      f.options.extractor.member = async (itemId) => ({
        ...(await member(itemId)),
        sourceKey: itemId === 'paper1' ? 'source-2' : 'source-1'
      })
      expect((await f.read()).cells[0].status).toBe(status)
      pending.resolve(ready())
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      extract.mockResolvedValue({ ...ready(), sourceKey: 'source-2' })
      await f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: [f.table.cells[0].id] })
      await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
      expect((await f.read()).cells[0].status).toBe('succeeded')
      expect(extract).toHaveBeenCalledTimes(3)
    } finally {
      pending.resolve(ready())
      await f.owner.dispose()
    }
  }
)

it('checks configuration revisions inside the owner queue when clients submit together', async () => {
  const f = await fixture()
  try {
    const update = {
      action: 'update' as const,
      tableId: f.table.id,
      expectedRevision: f.table.revision,
      name: f.table.name,
      sourcePolicy: f.table.sourcePolicy,
      fields: [{ id: 'field', name: 'Result', rule: 'Extract the primary result' }]
    }
    const [first, second] = await Promise.allSettled([
      f.owner.run(update),
      f.owner.run({
        ...update,
        name: 'Stale title',
        fields: [{ id: 'field', name: 'Result', rule: 'Extract result' }]
      })
    ])
    expect(first.status).toBe('fulfilled')
    expect(second).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        name: 'ApplicationCommandError',
        code: 'comparison-config-changed',
        message: 'comparison-config-changed'
      })
    })
    expect(await f.read()).toMatchObject({
      name: f.table.name,
      revision: f.table.revision + 1,
      fields: [{ id: 'field', rule: 'Extract the primary result', version: 2 }]
    })
  } finally {
    await f.owner.dispose()
  }
})

it('advances the view revision for worker, manual, and live source changes', async () => {
  const f = await fixture()
  const initial = (await f.read()).revision
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const completed = await f.read()
  expect(completed.revision).toBeGreaterThan(initial)
  await f.owner.run({
    action: 'edit-cell',
    tableId: f.table.id,
    cellId: completed.cells[0].id,
    value: 'manual',
    confirmed: false,
    expectedFieldVersion: 1,
    expectedSourceKey: 'source-1'
  })
  const edited = await f.read()
  expect(edited.revision).toBeGreaterThan(completed.revision)
  const member = f.options.extractor.member
  f.options.extractor.member = async (id) => ({ ...(await member(id)), sourceKey: 'new-source' })
  const refreshed = await f.read()
  expect(refreshed.revision).toBeGreaterThan(edited.revision)
  expect(refreshed.cells[0].status).toBe('pending')
  await f.owner.dispose()
})

it('keeps insufficient full text available for targeted retry with its own diagnosis', async () => {
  const extract = vi.fn<Extract>(async () => {
    throw new Error('full-text-insufficient')
  })
  const f = await fixture(extract)
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: ['paper1'] })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const cell = (await f.read()).cells[0]
  expect(cell.status).toBe('unavailable')
  expect(cell.history.at(-1)?.issue).toBe('full-text-insufficient')
  extract.mockResolvedValue(ready())
  await f.owner.run({ action: 'retry', tableId: f.table.id, cellIds: [cell.id] })
  await vi.waitFor(async () => expect((await f.read()).cells[0].status).toBe('succeeded'))
  await f.owner.dispose()
})

it('extracts later candidates without rerunning pending historical cells on the same reference', async () => {
  const f = await fixture()
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    const original = (await f.read()).cells.map((cell) => cell.history)
    await f.owner.run({
      action: 'update',
      expectedRevision: (await f.read()).revision,
      tableId: f.table.id,
      name: f.table.name,
      sourcePolicy: 'abstract',
      fields: [
        { id: 'field', name: 'Result', rule: 'Revised result' },
        { id: 'new-field', name: 'Analysis population', rule: 'Report analysis population' }
      ]
    })
    await f.owner.run({ action: 'add-members', tableId: f.table.id, itemIds: ['paper3', 'paper3'] })
    expect(f.extract).toHaveBeenCalledTimes(2)
    const before = await f.read()
    await f.owner.run({
      action: 'run',
      tableId: f.table.id,
      unattemptedOnly: true,
      expectedRevision: before.revision,
      expectedSources: before.members.map(({ itemId, sourceKey }) => ({ itemId, sourceKey }))
    })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    const after = await f.read()
    expect(f.extract.mock.calls.slice(2).map(([, field, itemId]) => [itemId, field.id])).toEqual([
      ['paper1', 'new-field'],
      ['paper2', 'new-field'],
      ['paper3', 'field'],
      ['paper3', 'new-field']
    ])
    expect(
      after.cells
        .filter((cell) => cell.itemId !== 'paper3' && cell.fieldId === 'field')
        .map((cell) => cell.history)
    ).toEqual(original)
    const saved = await readFile(f.path, 'utf8')
    await f.owner.run({ action: 'run', tableId: f.table.id, unattemptedOnly: true })
    expect(f.extract).toHaveBeenCalledTimes(6)
    expect(saved).toContain('paper3')
  } finally {
    await f.owner.dispose()
  }
})
it('keeps never-attempted missing sources eligible for their first batch extraction', async () => {
  const f = await fixture()
  try {
    const member = f.options.extractor.member
    f.options.extractor.member = async (id) => {
      if (id === 'paper2') throw new Error('source-unavailable')
      return member(id)
    }
    expect((await f.read()).cells[1]).toMatchObject({ status: 'unavailable', history: [] })
    f.options.extractor.member = member
    await f.owner.run({
      action: 'run',
      tableId: f.table.id,
      unattemptedOnly: true,
      itemIds: ['paper2']
    })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    expect(f.extract.mock.calls.map(([, , id]) => id)).toEqual(['paper2'])
    expect((await f.read()).cells[0].status).toBe('pending')
  } finally {
    await f.owner.dispose()
  }
})

it('preserves known unavailable sources across rule revisions without erasing their history', async () => {
  const f = await fixture(vi.fn().mockRejectedValue(new Error('full-text-unavailable')))
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const before = await f.read()
  await f.owner.run({
    action: 'update',
    expectedRevision: (await f.read()).revision,
    tableId: f.table.id,
    name: before.name,
    sourcePolicy: before.sourcePolicy,
    fields: [{ id: 'field', name: 'Result', rule: 'Extract the final result only' }]
  })
  const revised = await f.read()
  expect(revised.fields[0].version).toBe(2)
  expect(revised.cells.map((cell) => cell.status)).toEqual(['unavailable', 'unavailable'])
  expect(revised.cells.map((cell) => cell.history)).toEqual(
    before.cells.map((cell) => cell.history)
  )
  await f.owner.run({
    action: 'update',
    expectedRevision: (await f.read()).revision,
    tableId: f.table.id,
    name: before.name,
    sourcePolicy: 'full-text',
    fields: [{ id: 'field', name: 'Result', rule: 'Extract the final result only' }]
  })
  // A different source policy needs a fresh check rather than inheriting an abstract diagnosis.
  expect((await f.read()).cells.map((cell) => cell.status)).toEqual(['pending', 'pending'])
  await f.owner.dispose()
})

it('classifies unavailable sources before model work and batches only recovered pending reports', async () => {
  const first = deferred<ComparisonExtraction>()
  const f = await fixture(
    vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(ready())
  )
  let recovered = false
  f.options.extractor.checkSource = async (_table, itemId) => ({
    itemId,
    sourceKey: 'source-1',
    status: itemId === 'paper1' || recovered ? 'available' : 'missing'
  })
  const admitted = (await f.owner.run({ action: 'run', tableId: f.table.id })).tables[0]
  expect(admitted.cells[1]).toMatchObject({ status: 'unavailable', history: [] })
  expect(admitted.taskSources?.map((source) => source.cellId)).toEqual([f.table.cells[0].id])
  expect(admitted.remainingCellIds).toEqual([f.table.cells[0].id])
  await vi.waitFor(() => expect(f.extract).toHaveBeenCalledTimes(1))
  expect((await f.read()).cells[1].status).toBe('unavailable')
  first.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  const saved = (await f.read()).cells[0]
  recovered = true
  const summary = (await f.owner.run({ action: 'list' })).summaries![0]
  expect(summary.pendingItemIds).toEqual(['paper2'])
  await f.owner.run({ action: 'run', tableId: f.table.id, itemIds: summary.pendingItemIds })
  await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
  expect(f.extract).toHaveBeenCalledTimes(2)
  expect((await f.read()).cells[0]).toEqual(saved)
  expect((await f.read()).cells[1]).toMatchObject({
    status: 'succeeded',
    history: [expect.anything()]
  })
  await f.owner.dispose()
})

it('does not capture a model or create failed attempts when every admitted source is missing', async () => {
  const f = await fixture()
  f.options.extractor.checkSource = async (_table, itemId) => ({
    itemId,
    sourceKey: 'source-1',
    status: 'unreadable'
  })
  const admitted = (await f.owner.run({ action: 'run', tableId: f.table.id })).tables[0]
  expect(admitted.state).toBe('completed')
  expect(admitted.remainingCellIds).toEqual([])
  expect(admitted.taskSources).toEqual([])
  expect(
    admitted.cells.every((cell) => cell.status === 'unavailable' && !cell.history.length)
  ).toBe(true)
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.extract).not.toHaveBeenCalled()
  await f.owner.dispose()
})

it('keeps the original task and saved cells when an unfinished source is unavailable on resume', async () => {
  const first = deferred<ComparisonExtraction>()
  const f = await fixture(
    vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(ready())
  )
  await f.owner.run({ action: 'run', tableId: f.table.id })
  await vi.waitFor(() => expect(f.extract).toHaveBeenCalledTimes(1))
  await f.owner.run({ action: 'pause', tableId: f.table.id })
  first.resolve(ready())
  await vi.waitFor(async () => expect((await f.read()).cells[0].status).toBe('succeeded'))
  const paused = await f.read()
  f.options.extractor.checkSource = async (_table, itemId) => ({
    itemId,
    sourceKey: 'source-1',
    status: 'missing'
  })
  await f.owner.run({ action: 'resume', tableId: f.table.id })
  const resumed = await f.read()
  expect(resumed.taskId).toBe(paused.taskId)
  expect(resumed.state).toBe('completed')
  expect(resumed.cells[0]).toEqual(paused.cells[0])
  expect(resumed.cells[1]).toMatchObject({ status: 'unavailable', history: [] })
  expect(resumed.remainingCellIds).toEqual([])
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(f.capture).toHaveBeenCalledTimes(1)
  await f.owner.dispose()
})

it('reclaims table capacity durably without changing other tables', async () => {
  const f = await fixture()
  try {
    for (let index = 1; index < 30; index++)
      await f.owner.run({
        action: 'create',
        name: `Draft ${index}`,
        language: 'en',
        sourcePolicy: 'abstract',
        fields: [],
        itemIds: []
      })
    const create = {
      action: 'create' as const,
      name: 'Replacement',
      language: 'en',
      sourcePolicy: 'abstract' as const,
      fields: [],
      itemIds: []
    }
    await expect(f.owner.run(create)).rejects.toThrow('comparison-table-limit')
    const before = JSON.parse(await readFile(f.path, 'utf8')).tables as ComparisonTable[]
    await f.owner.run({ action: 'delete', tableId: f.table.id })
    const after = JSON.parse(await readFile(f.path, 'utf8')).tables as ComparisonTable[]
    expect(after).toEqual(before.filter((table) => table.id !== f.table.id))
    await expect(f.read()).rejects.toThrow('comparison-not-found')
    await f.owner.run(create)
    expect((await f.owner.run({ action: 'list' })).summaries).toHaveLength(30)
    await f.owner.dispose()
    const restored = new LiteratureComparisons(f.options)
    try {
      await restored.start()
      expect((await restored.run({ action: 'list' })).summaries).toHaveLength(30)
      await expect(restored.run({ action: 'read', tableId: f.table.id })).rejects.toThrow(
        'comparison-not-found'
      )
    } finally {
      await restored.dispose()
    }
  } finally {
    await f.owner.dispose()
  }
})

it('rolls back deletion when persistence fails', async () => {
  const f = await fixture()
  try {
    const before = await readFile(f.path, 'utf8')
    vi.mocked(writeDurableJsonFile).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(f.owner.run({ action: 'delete', tableId: f.table.id })).rejects.toThrow(
      'disk unavailable'
    )
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect((await f.read()).id).toBe(f.table.id)
    await f.owner.run({ action: 'delete', tableId: f.table.id })
    expect((await f.owner.run({ action: 'list' })).summaries).toEqual([])
  } finally {
    await f.owner.dispose()
  }
})

it('rejects deletion while extraction is in flight, including after pause', async () => {
  const blocked = deferred<ComparisonExtraction>()
  const f = await fixture(vi.fn(() => blocked.promise))
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledOnce())
    await expect(f.owner.run({ action: 'delete', tableId: f.table.id })).rejects.toThrow(
      'comparison-busy'
    )
    await f.owner.run({ action: 'pause', tableId: f.table.id })
    await expect(f.owner.run({ action: 'delete', tableId: f.table.id })).rejects.toThrow(
      'comparison-busy'
    )
    blocked.resolve(ready())
    await vi.waitFor(async () =>
      expect((await f.read()).cells.some((cell) => cell.status === 'running')).toBe(false)
    )
    await f.owner.run({ action: 'delete', tableId: f.table.id })
    expect((await f.owner.run({ action: 'list' })).summaries).toEqual([])
  } finally {
    blocked.resolve(ready())
    await f.owner.dispose()
  }
})

it('releases storage capacity after a rejected oversized mutation by deleting a table', async () => {
  const f = await fixture()
  try {
    f.options.extractor.member = async (itemId) => ({
      itemId,
      title: 'Paper',
      abstract: 'x'.repeat(100000),
      sourceKey: 'source-1'
    })
    const create = {
      action: 'create' as const,
      name: 'Large draft',
      language: 'en',
      sourcePolicy: 'abstract' as const,
      fields: [],
      itemIds: Array.from({ length: 79 }, (_, index) => `paper-${index}`)
    }
    const large: string[] = []
    for (let index = 0; index < 3; index++) large.push((await f.owner.run(create)).tables[0].id)
    const before = await readFile(f.path, 'utf8')
    const extra = { ...create, name: 'New content', itemIds: create.itemIds.slice(0, 4) }
    await expect(f.owner.run(extra)).rejects.toThrow('comparison-storage-limit')
    expect(await readFile(f.path, 'utf8')).toBe(before)
    await f.owner.run({ action: 'delete', tableId: large[0] })
    expect(Buffer.byteLength(await readFile(f.path, 'utf8'))).toBeLessThan(
      Buffer.byteLength(before) - 7000000
    )
    await expect(f.owner.run(extra)).resolves.toMatchObject({ tables: [{ name: 'New content' }] })
    expect((await f.owner.run({ action: 'list' })).summaries).toHaveLength(4)
  } finally {
    await f.owner.dispose()
  }
})

it('protects superseded in-flight extraction from deletion until its checkpoint drains', async () => {
  const blocked = deferred<ComparisonExtraction>()
  const f = await fixture(vi.fn(() => blocked.promise))
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledOnce())
    await f.owner.run({
      action: 'update',
      expectedRevision: (await f.read()).revision,
      tableId: f.table.id,
      name: f.table.name,
      sourcePolicy: 'abstract',
      fields: [{ id: 'field', name: 'Result', rule: 'Updated rule' }]
    })
    expect((await f.read()).state).toBe('idle')
    await expect(f.owner.run({ action: 'delete', tableId: f.table.id })).rejects.toThrow(
      'comparison-busy'
    )
    blocked.resolve(ready())
    await vi.waitFor(async () => expect((await f.read()).cells[0].history).toHaveLength(1))
    await f.owner.run({ action: 'delete', tableId: f.table.id })
    expect((await f.owner.run({ action: 'list' })).summaries).toEqual([])
  } finally {
    blocked.resolve(ready())
    await f.owner.dispose()
  }
})

it('repairs a saved paused task with an orphan running cell and remaining work', async () => {
  const f = await fixture()
  await f.owner.dispose()
  const saved = JSON.parse(await readFile(f.path, 'utf8'))
  const table = saved.tables[0]
  table.state = 'paused'
  table.remainingCellIds = [table.cells[0].id]
  table.cells[0].status = 'running'
  await writeFile(f.path, JSON.stringify(saved))
  const owner = new LiteratureComparisons(f.options)
  try {
    await owner.start()
    const restored = (await owner.run({ action: 'read', tableId: table.id })).tables[0]
    expect(restored.state).toBe('paused')
    expect(restored.remainingCellIds).toEqual(table.remainingCellIds)
    expect(restored.cells[0].status).toBe('pending')
    await owner.run({ action: 'resume', tableId: table.id })
    await vi.waitFor(async () =>
      expect((await owner.run({ action: 'read', tableId: table.id })).tables[0].state).toBe(
        'completed'
      )
    )
  } finally {
    await owner.dispose()
  }
})

it('skips unchanged catalog scans and refreshes after the catalog revision changes', async () => {
  const f = await fixture()
  let revision = 0
  f.options.sourceRevision = () => revision
  const member = vi.spyOn(f.options.extractor, 'member')
  try {
    await f.owner.run({ action: 'list' })
    expect(member).toHaveBeenCalledTimes(2)
    await f.owner.run({ action: 'list' })
    expect(member).toHaveBeenCalledTimes(2)
    revision++
    await f.owner.run({ action: 'list' })
    expect(member).toHaveBeenCalledTimes(4)
  } finally {
    await f.owner.dispose()
  }
})

it('checks just the requested source without blocking other comparison commands', async () => {
  const f = await fixture()
  const ready = deferred<void>()
  const check = vi.fn(async (_table: ComparisonTable, itemId: string) => {
    await ready.promise
    return { itemId, sourceKey: 's', status: 'available' as const }
  })
  f.options.extractor.checkSource = check
  try {
    const checking = f.owner.run({
      action: 'check-sources',
      tableId: f.table.id,
      itemIds: ['paper2']
    })
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    expect((await f.owner.run({ action: 'list' })).summaries).toHaveLength(1)
    ready.resolve()
    expect((await checking).sourceChecks?.map((s) => s.itemId)).toEqual(['paper2'])
  } finally {
    ready.resolve()
    await f.owner.dispose()
  }
})
it('allows resuming after a paused extraction checkpoint fails', async () => {
  const blocked = deferred<ComparisonExtraction>()
  const f = await fixture(vi.fn(() => blocked.promise))
  const onError = vi.fn()
  f.options.onError = onError
  try {
    await f.owner.run({ action: 'run', tableId: f.table.id })
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledOnce())
    await f.owner.run({ action: 'pause', tableId: f.table.id })
    vi.mocked(writeDurableJsonFile).mockRejectedValueOnce(new Error('checkpoint unavailable'))
    blocked.resolve(ready())
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    const paused = await f.read()
    expect(paused.state).toBe('paused')
    expect(paused.issue).toBe('checkpoint-failed')
    expect(paused.cells[0].status).toBe('pending')
    await f.owner.run({ action: 'resume', tableId: f.table.id })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    expect((await f.read()).cells.every((cell) => cell.history.length === 1)).toBe(true)
    await f.owner.run({ action: 'delete', tableId: f.table.id })
    expect((await f.owner.run({ action: 'list' })).summaries).toEqual([])
  } finally {
    blocked.resolve(ready())
    await f.owner.dispose()
  }
})

it('preserves a field-specific evidence gap in history and retries it after a rule revision', async () => {
  const extract = vi
    .fn()
    .mockRejectedValueOnce(new Error('full-text-insufficient'))
    .mockResolvedValue(ready())
  const f = await fixture(extract)
  try {
    const tableId = f.table.id
    await f.owner.run({ action: 'run', tableId })
    await vi.waitFor(async () => expect((await f.read()).state).toBe('completed'))
    const first = await f.read()
    expect(first.cells[0].status).toBe('unavailable')
    await f.owner.run({
      action: 'update',
      tableId,
      expectedRevision: first.revision,
      name: first.name,
      sourcePolicy: first.sourcePolicy,
      fields: [{ id: 'field', name: 'Result', rule: 'Revised search terms' }]
    })
    await f.owner.run({ action: 'run', tableId, itemIds: ['paper1'] })
    await vi.waitFor(async () => {
      const cell = (await f.read()).cells[0]
      expect(cell.status).toBe('succeeded')
      expect(cell.history.map(({ fieldVersion }) => fieldVersion)).toEqual([1, 2])
    })
  } finally {
    await f.owner.dispose()
  }
})

it('validates sources once per paged matrix read', async () => {
  const f = await fixture()
  try {
    const ids = Array.from({ length: 24 }, (_, index) => 'member-' + index)
    const table = (
      await f.owner.run({
        action: 'create',
        name: 'Paged',
        language: 'en',
        sourcePolicy: 'abstract',
        fields: [{ id: 'f', name: 'Field', rule: 'Rule' }],
        itemIds: ids
      })
    ).tables[0]
    const member = vi.spyOn(f.options.extractor, 'member')
    let offset: number | undefined
    do {
      const page = await f.owner.run({ action: 'read', tableId: table.id, offset })
      offset = page.nextOffset
    } while (offset !== undefined)
    expect(member).toHaveBeenCalledTimes(ids.length)
  } finally {
    await f.owner.dispose()
  }
})

it('releases the shared snapshot after fetching the final selected CSV', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 9; i++) {
      const first = await f.owner.run({ action: 'export', tableId: f.table.id, kind: 'matrix' })
      const final = await f.owner.run({
        action: 'export',
        tableId: f.table.id,
        kind: 'evidence',
        exportToken: first.exportToken,
        releaseOnComplete: true
      })
      expect(final.csv).toBeTruthy()
      await expect(
        f.owner.run({
          action: 'export',
          tableId: f.table.id,
          kind: 'matrix',
          exportToken: first.exportToken
        })
      ).rejects.toThrow('export-expired')
    }
  } finally {
    await f.owner.dispose()
  }
})
