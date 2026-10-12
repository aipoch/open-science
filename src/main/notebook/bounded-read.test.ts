import { describe, expect, it } from 'vitest'
import { boundNotebookState, readNotebookContent, summarizeNotebookRun } from './bounded-read'
import type {
  NotebookContentCursor,
  NotebookRunRecord,
  NotebookSessionState
} from '../../shared/notebook'

const reference = {
  projectId: 'project',
  sessionId: 'session',
  workspaceCwd: '/workspace',
  revision: 'revision'
}
const run = (text: string, id = 'run'): NotebookRunRecord => ({
  runId: id,
  cellId: id,
  kernelKind: 'python',
  source: 'user',
  script: 'print(value)',
  status: 'completed',
  startedAt: 1,
  text: { stdout: text, stderr: '', traceback: '', plain: [] },
  outputs: [{ type: 'stream', name: 'stdout', text }],
  workingFiles: []
})
const state = (runs: NotebookRunRecord[]): NotebookSessionState => ({
  id: 'session',
  sessionId: 'session',
  cwd: '/workspace',
  notebookSessionRoot: '/notebook',
  dataRoot: '/data',
  runtimeRoot: '/runtime',
  runJsonPath: '/notebook/run.json',
  kernelStatus: 'idle',
  cells: [],
  runCount: runs.length,
  latestRunEnvironments: {},
  environments: [],
  runs,
  recentRuns: runs,
  historyPage: { hasEarlierRuns: false }
})
const envelopeBytes = (value: unknown): number =>
  Buffer.byteLength(
    JSON.stringify({ type: 'response', id: 'x'.repeat(1024), result: value }),
    'utf8'
  )
const readAll = (record: NotebookRunRecord): Map<number, string> => {
  const result = new Map<number, string>()
  let cursor: NotebookContentCursor | undefined = { part: 0, offset: 0 }
  while (cursor) {
    const chunk = readNotebookContent(
      record,
      { runId: record.runId, revision: 'revision', cursor },
      'revision'
    )
    expect(envelopeBytes(chunk)).toBeLessThan(16 * 1024 * 1024)
    result.set(cursor.part, (result.get(cursor.part) ?? '') + chunk.data)
    cursor = chunk.next
  }
  return result
}

describe('bounded Notebook reads', () => {
  it('opens three 1.5 MiB runs without duplicated output, then reads every character', () => {
    const text = 'x'.repeat(1.5 * 1024 * 1024)
    const records = [run(text, '1'), run(text, '2'), run(text, '3')]
    const result = boundNotebookState(
      state(records),
      { ...reference, readMode: 'bounded' },
      'revision',
      records
    )
    expect(result.runs).toHaveLength(3)
    expect(result.recentRuns).toEqual([])
    expect(envelopeBytes(result)).toBeLessThan(1024 * 1024)
    for (const record of records) expect(readAll(record).get(1)).toBe(text)
  })
  it('pages JSON escapes and multibyte/surrogate text exactly, with small actual envelopes', () => {
    const text = '\\"\n\u0000中文🧬'.repeat(100_000)
    expect(readAll(run(text)).get(1)).toBe(text)
    const record = run('')
    record.outputs = [{ type: 'json', data: { text, values: [1, true, null] } }]
    expect(JSON.parse(readAll(record).get(2)!)).toEqual({ text, values: [1, true, null] })
  })
  it('reads a near-limit single image through many chunks', () => {
    const image = Buffer.alloc(Math.floor(3.5 * 1024 * 1024), 17).toString('base64')
    const record = run('')
    record.outputs = [{ type: 'display', data: { 'image/png': image, 'text/plain': 'figure' } }]
    const output = readAll(record)
    expect(output.get(2)).toBe(image)
    expect(output.get(3)).toBe('figure')
  })
  it('keeps near-maximum text and twelve rich outputs available without a large response', () => {
    const text = 't'.repeat(2 * 1024 * 1024)
    const record = run(text)
    const images = Array.from({ length: 12 }, (_, index) =>
      Buffer.alloc(index === 0 ? Math.floor(3.5 * 1024 * 1024) : 400_000, index).toString('base64')
    )
    record.outputs = images.map((image) => ({ type: 'display', data: { 'image/png': image } }))
    const output = readAll(record)
    expect(output.get(1)).toBe(text)
    for (let index = 0; index < images.length; index++)
      expect(output.get(index + 3)).toBe(images[index])
  })
  it('uses a byte budget as well as the run-count budget and returns a contiguous cursor', () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      ...run('value', `run-${index}`),
      startedAt: index,
      cwdBefore: 'p'.repeat(16_000)
    }))
    const result = boundNotebookState(
      state(records),
      { ...reference, readMode: 'bounded' },
      'revision',
      records
    )
    expect(result.runs.length).toBeLessThan(100)
    expect(result.runs.at(-1)?.runId).toBe('run-99')
    expect(result.historyPage?.oldestCursor?.runId).toBe(result.runs[0].runId)
    expect(result.historyPage?.hasEarlierRuns).toBe(true)
    expect(envelopeBytes(result)).toBeLessThan(1024 * 1024 + 2048)
  })
  it('preserves identity and returns explicit previews for oversized imported metadata', () => {
    const record = {
      ...run('a'),
      inputFiles: Array.from({ length: 1000 }, () => ({ filename: 'x'.repeat(1024) }))
    } as NotebookRunRecord
    const result = boundNotebookState(
      state([record]),
      { ...reference, readMode: 'bounded' },
      'revision',
      [record]
    )
    expect(result.runs[0].runId).toBe(record.runId)
    expect(result.runs[0].contentRead).toMatchObject(reference)
    expect(envelopeBytes(result)).toBeLessThan(1024 * 1024)
  })
  it('rejects stale active content, missing run identity, and invalid offsets', () => {
    const record = run('a')
    expect(() =>
      readNotebookContent(
        record,
        { runId: 'run', revision: 'old', cursor: { part: 0, offset: 0 } },
        'new'
      )
    ).toThrow(/changed/)
    expect(() =>
      readNotebookContent(
        record,
        { runId: 'run', revision: 'revision', cursor: { part: 0, offset: -1 } },
        'revision'
      )
    ).toThrow(/cursor/)
    expect(() =>
      boundNotebookState(
        state([record]),
        {
          ...reference,
          readMode: 'bounded',
          contentRead: { runId: 'missing', revision: 'revision', cursor: { part: 0, offset: 0 } }
        },
        'revision',
        [record]
      )
    ).toThrow(/not found/)
  })
  it('rejects completed content too after repository revision changes', () => {
    const record = { ...run('done'), endedAt: 2 }
    const summary = summarizeNotebookRun(record, reference)
    expect(() =>
      readNotebookContent(
        record,
        {
          runId: record.runId,
          revision: summary.contentRead!.revision,
          cursor: { part: 0, offset: 0 }
        },
        'new-session-revision'
      )
    ).toThrow(/changed/)
  })
})

it('budgets 100 legal live CJK/escaped cell previews and retrieves complete live source', () => {
  const input = state([])
  input.cells = Array.from({ length: 100 }, (_, index) => ({
    id: `cell-${index}`,
    language: 'python',
    status: 'idle',
    code: '#' + (index % 2 ? '\0中文🧬' : '中文').repeat(20_000)
  }))
  const request = { ...reference, readMode: 'bounded' as const }
  const view = boundNotebookState(input, request, reference.revision, [])
  expect(view.cells).toHaveLength(100)
  expect(envelopeBytes(view)).toBeLessThan(256 * 1024)
  for (const cell of view.cells) {
    expect(Buffer.byteLength(JSON.stringify(cell.code))).toBeLessThanOrEqual(1024)
    expect(cell.sourceRead).toEqual({ cellId: cell.id, offset: 0 })
  }
  let offset = 0
  let revision: string | undefined
  let full = ''
  do {
    const read = boundNotebookState(
      input,
      { ...request, cellRead: { cellId: 'cell-1', offset, revision } },
      reference.revision,
      []
    )
    expect(envelopeBytes(read)).toBeLessThan(1024 * 1024)
    const chunk = read.contentChunk!
    full += chunk.data
    revision = chunk.revision
    offset = chunk.next?.offset ?? 0
  } while (offset)
  expect(full).toBe(input.cells[1].code)
  input.cells[1].code += 'changed'
  expect(() =>
    boundNotebookState(
      input,
      { ...request, cellRead: { cellId: 'cell-1', offset: 65536, revision } },
      reference.revision,
      []
    )
  ).toThrow('source changed')
})

it('preserves recovery from full diagnostics and WSL exclusion in summaries', () => {
  const failed = { ...run(''), status: 'failed' as const }
  failed.text.stderr =
    'warning\n'.repeat(1000) + "Permission denied: '/workspace/protected/data.csv'"
  const summary = summarizeNotebookRun(failed, reference)
  expect(summary.text.stderr).not.toContain('protected')
  expect(summary.folderAccessPath).toBe('/workspace/protected/data.csv')
  expect(
    summarizeNotebookRun(
      { ...failed, shellRuntime: { kind: 'wsl2-bash' } as NotebookRunRecord['shellRuntime'] },
      reference
    )
  ).toMatchObject({ shellRuntime: { kind: 'wsl2-bash' }, folderAccessPath: undefined })
})

it('keeps every rich MIME payload complete without interpreting HTML', () => {
  const record = run('')
  const html = '<table><tr><td>中文🧬</td></tr></table>'.repeat(10_000)
  record.outputs = [
    { type: 'display', data: { 'text/html': html, 'text/plain': 'table fallback' } },
    { type: 'json', data: { rows: [1, 2], label: '中文' } }
  ]
  const values = [...readAll(record).values()]
  expect(values).toContain(html)
  expect(values).toContain('table fallback')
  expect(values).toContain(JSON.stringify({ rows: [1, 2], label: '中文' }))
})
