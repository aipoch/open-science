import { readFile } from 'node:fs/promises'

import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'

import type { NotebookRunDocument, NotebookRunRecord } from '../../shared/notebook'
import { runDocumentToIpynb, type NbformatOutput } from './ipynb-export'

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print("hello")\n2 + 2',
  status: 'completed',
  startedAt: 100,
  endedAt: 200,
  executionCount: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  environment: 'default-python',
  ...overrides
})

const makeDocument = (runs: NotebookRunRecord[]): NotebookRunDocument => ({
  version: 1,
  projectName: 'default-project',
  sessionId: 'session-123',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/data/notebooks/default-project/session-123',
  dataRoot: '/data/notebooks/default-project/session-123/data',
  kernel: {
    language: 'python',
    kernelName: 'python3',
    runtimeRoot: '/data/runtime',
    lastKnownStatus: 'idle'
  },
  runs,
  updatedAt: 300
})

// The vendored nbformat schema declares draft-04, which ajv 8 no longer loads; it only uses
// draft-07-compatible keywords (verified when vendoring), so it is validated as draft-07 here.
const validateAgainstNbformatSchema = async (notebook: unknown): Promise<void> => {
  const schemaUrl = new URL('../../../test/fixtures/nbformat.v4.5.schema.json', import.meta.url)
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8')) as Record<string, unknown>
  schema.$schema = 'http://json-schema.org/draft-07/schema#'

  const ajv = new Ajv({ strict: false })
  const validate = ajv.compile(schema)
  const valid = validate(notebook)

  expect(validate.errors).toBeNull()
  expect(valid).toBe(true)
}

describe('runDocumentToIpynb', () => {
  it('projects source, provenance, execution count, and every structured output kind', () => {
    const run = makeRun({
      outputs: [
        { type: 'stream', name: 'stdout', text: 'hello\nworld' },
        { type: 'stream', name: 'stderr', text: 'warning' },
        { type: 'display', data: { 'image/png': 'aW1hZ2U=', 'text/plain': '<plot>' } },
        { type: 'json', data: { answer: 42 } },
        { type: 'text', text: '4' },
        { type: 'error', name: 'ValueError', message: 'bad value', traceback: 'line 1\nline 2' }
      ]
    })

    const notebook = runDocumentToIpynb(makeDocument([run]), { appVersion: '1.2.3' })

    expect(notebook).toMatchObject({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name: 'python3', language: 'python' },
        open_science: {
          sessionId: 'session-123',
          projectName: 'default-project',
          appVersion: '1.2.3',
          environment: 'default-python'
        }
      }
    })
    expect(notebook.cells[0]).toMatchObject({
      cell_type: 'code',
      id: 'run-1',
      execution_count: 1,
      source: ['print("hello")\n', '2 + 2'],
      metadata: {
        open_science: {
          runId: 'run-1',
          cellId: 'cell-1',
          source: 'agent',
          startedAt: 100,
          endedAt: 200,
          status: 'completed',
          kernel: 'python',
          environment: 'default-python'
        }
      }
    })
    expect(notebook.cells[0].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['hello\n', 'world'] },
      { output_type: 'stream', name: 'stderr', text: ['warning'] },
      {
        output_type: 'display_data',
        data: { 'image/png': 'aW1hZ2U=', 'text/plain': '<plot>' },
        metadata: {}
      },
      { output_type: 'display_data', data: { 'application/json': { answer: 42 } }, metadata: {} },
      {
        output_type: 'execute_result',
        data: { 'text/plain': '4' },
        metadata: {},
        execution_count: 1
      },
      {
        output_type: 'error',
        ename: 'ValueError',
        evalue: 'bad value',
        traceback: ['line 1\n', 'line 2']
      }
    ])
  })

  it('uses flattened text only as a legacy fallback, without duplicating structured streams', () => {
    const fallback = makeRun({
      runId: 'fallback',
      text: { stdout: 'out', stderr: 'err', traceback: 'boom', plain: [] }
    })
    const structured = makeRun({
      runId: 'structured',
      text: { stdout: 'duplicate', stderr: '', traceback: '', plain: [] },
      outputs: [{ type: 'stream', name: 'stdout', text: 'canonical' }]
    })

    const notebook = runDocumentToIpynb(makeDocument([fallback, structured]))

    expect(notebook.cells[0].outputs).toHaveLength(3)
    expect(notebook.cells[1].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['canonical'] }
    ])
  })

  it('chooses the dominant data kernel and marks downgraded bash and repl cells', () => {
    const notebook = runDocumentToIpynb(
      makeDocument([
        makeRun({ runId: 'r-1', kernelKind: 'r', script: 'print(1)', environment: 'default-r' }),
        makeRun({ runId: 'r-2', kernelKind: 'r', script: 'print(2)', environment: 'default-r' }),
        makeRun({ runId: 'py', kernelKind: 'python' }),
        makeRun({ runId: 'bash', kernelKind: 'bash', script: 'pwd', environment: undefined }),
        makeRun({
          runId: 'repl',
          kernelKind: 'repl',
          script: 'await host.mcp()',
          environment: undefined
        })
      ])
    )

    expect(notebook.metadata.kernelspec).toEqual({
      display_name: 'R',
      language: 'R',
      name: 'ir'
    })
    // Notebook-level environment follows the dominant (r) kernel's runs, not the python minority.
    expect(notebook.metadata.open_science.environment).toBe('default-r')
    expect(notebook.cells[3]).toMatchObject({
      source: ['%%bash\n', 'pwd'],
      metadata: { tags: ['open-science-bash'], open_science: { kernel: 'bash' } }
    })
    expect(notebook.cells[4]).toMatchObject({
      source: ['%%javascript\n', 'await host.mcp()'],
      metadata: { tags: ['open-science-repl'], open_science: { kernel: 'repl' } }
    })
  })

  it('passes execution counts through for every run status, including interrupted', () => {
    const notebook = runDocumentToIpynb(
      makeDocument([
        makeRun({ runId: 'run.with invalid spaces', cellId: 'same', status: 'running' }),
        makeRun({ runId: 'run-2', cellId: 'same', status: 'interrupted' }),
        makeRun({ runId: 'run-3', cellId: 'other', status: 'cancelled', executionCount: undefined })
      ])
    )

    expect(notebook.cells.map((cell) => cell.id)).toEqual([
      'run-with-invalid-spaces',
      'run-2',
      'run-3'
    ])
    expect(notebook.cells.map((cell) => cell.execution_count)).toEqual([1, 1, null])
  })

  it('keeps cell ids unique and within nbformat’s 64-character budget', () => {
    const oversized = `run-${'x'.repeat(100)}`
    const notebook = runDocumentToIpynb(
      makeDocument([
        makeRun({ runId: oversized }),
        makeRun({ runId: `${oversized}-different-tail` }),
        makeRun({ runId: '!!!' })
      ])
    )

    const ids = notebook.cells.map((cell) => cell.id)
    expect(ids[0]).toBe(oversized.slice(0, 64))
    // The second runId truncates to the same 64 chars, so the dedup suffix kicks in.
    expect(ids[1]).toBe(`${oversized.slice(0, 62)}-2`)
    expect(ids[2]).toBe('open-science-cell')
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9-_]{1,64}$/)
    }
  })

  it('appends pre-resolved artifact outputs without doing any IO itself', () => {
    const artifactOutputs = new Map<string, NbformatOutput[]>([
      [
        'run-1',
        [
          {
            output_type: 'display_data',
            data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
            metadata: {}
          }
        ]
      ]
    ])

    const notebook = runDocumentToIpynb(makeDocument([makeRun()]), { artifactOutputs })

    expect(notebook.cells[0].outputs).toEqual([
      {
        output_type: 'display_data',
        data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
        metadata: {}
      }
    ])
  })

  it('is byte-identical for the same document and embeds no absolute paths', () => {
    const document = makeDocument([
      makeRun({ outputs: [{ type: 'display', data: { 'image/png': 'aW1hZ2U=' } }] })
    ])
    const artifactOutputs = new Map<string, NbformatOutput[]>([
      ['run-1', [{ output_type: 'display_data', data: { 'image/png': 'cG5n' }, metadata: {} }]]
    ])

    const first = `${JSON.stringify(runDocumentToIpynb(document, { appVersion: '1.2.3', artifactOutputs }), null, 2)}\n`
    const second = `${JSON.stringify(runDocumentToIpynb(document, { appVersion: '1.2.3', artifactOutputs }), null, 2)}\n`

    expect(first).toBe(second)
    expect(first).not.toContain('/workspace')
    expect(first).not.toContain('/data/notebooks')
    expect(first).not.toContain('/data/runtime')
  })

  it('validates against the nbformat 4.5 JSON schema', async () => {
    const document = makeDocument([
      makeRun({
        outputs: [
          { type: 'stream', name: 'stdout', text: 'hello\n' },
          { type: 'display', data: { 'image/png': 'aW1hZ2U=' } },
          { type: 'json', data: { answer: 42 } },
          { type: 'text', text: '4' },
          { type: 'error', name: 'ValueError', message: 'bad value', traceback: 'line 1\nline 2' }
        ]
      }),
      makeRun({ runId: 'bash-1', kernelKind: 'bash', script: 'pwd', environment: undefined }),
      makeRun({
        runId: 'repl-1',
        kernelKind: 'repl',
        script: 'await host.mcp()',
        environment: undefined
      }),
      makeRun({ runId: 'r-1', kernelKind: 'r', script: 'print(1)', environment: 'default-r' })
    ])
    const artifactOutputs = new Map<string, NbformatOutput[]>([
      [
        'run-1',
        [
          {
            output_type: 'display_data',
            data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
            metadata: {}
          }
        ]
      ]
    ])

    const notebook = runDocumentToIpynb(document, { appVersion: '1.2.3', artifactOutputs })

    await validateAgainstNbformatSchema(notebook)
  })
})
