import { describe, expect, it, vi } from 'vitest'

import type { NotebookRunDocument, NotebookRunRecord } from '../../shared/notebook'
import { runDocumentToIpynb } from './ipynb-export'

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

describe('runDocumentToIpynb', () => {
  it('projects source, provenance, execution count, and every structured output kind', async () => {
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

    const notebook = await runDocumentToIpynb(makeDocument([run]), { appVersion: '1.2.3' })

    expect(notebook).toMatchObject({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name: 'python3', language: 'python' },
        open_science: {
          sessionId: 'session-123',
          projectName: 'default-project',
          appVersion: '1.2.3'
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
          startedAt: 100,
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

  it('uses flattened text only as a legacy fallback, without duplicating structured streams', async () => {
    const fallback = makeRun({
      runId: 'fallback',
      text: { stdout: 'out', stderr: 'err', traceback: 'boom', plain: [] }
    })
    const structured = makeRun({
      runId: 'structured',
      text: { stdout: 'duplicate', stderr: '', traceback: '', plain: [] },
      outputs: [{ type: 'stream', name: 'stdout', text: 'canonical' }]
    })

    const notebook = await runDocumentToIpynb(makeDocument([fallback, structured]))

    expect(notebook.cells[0].outputs).toHaveLength(3)
    expect(notebook.cells[1].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['canonical'] }
    ])
  })

  it('chooses the dominant data kernel and marks downgraded bash and repl cells', async () => {
    const notebook = await runDocumentToIpynb(
      makeDocument([
        makeRun({ runId: 'r-1', kernelKind: 'r', script: 'print(1)' }),
        makeRun({ runId: 'r-2', kernelKind: 'r', script: 'print(2)' }),
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
    expect(notebook.cells[3]).toMatchObject({
      source: ['%%bash\n', 'pwd'],
      metadata: { tags: ['open-science-bash'], open_science: { kernel: 'bash' } }
    })
    expect(notebook.cells[4]).toMatchObject({
      source: ['%%javascript\n', 'await host.mcp()'],
      metadata: { tags: ['open-science-repl'], open_science: { kernel: 'repl' } }
    })
  })

  it('sets unfinished execution counts to null and emits valid unique run-based cell ids', async () => {
    const notebook = await runDocumentToIpynb(
      makeDocument([
        makeRun({ runId: 'run.with invalid spaces', cellId: 'same', status: 'running' }),
        makeRun({ runId: 'run-2', cellId: 'same', status: 'interrupted' })
      ])
    )

    expect(notebook.cells.map((cell) => cell.id)).toEqual(['run-with-invalid-spaces', 'run-2'])
    expect(notebook.cells.map((cell) => cell.execution_count)).toEqual([null, null])
  })

  it('inlines resolved artifacts and degrades resolver failures to stderr', async () => {
    const run = makeRun({
      artifacts: [
        {
          id: 'a1',
          projectName: 'default-project',
          sessionId: 'session-123',
          runId: 'run-1',
          name: 'plot.png',
          path: '/data/plot.png',
          fileUrl: 'artifact://plot.png',
          mimeType: 'image/png',
          size: 3,
          mtimeMs: 1
        },
        {
          id: 'a2',
          projectName: 'default-project',
          sessionId: 'session-123',
          runId: 'run-1',
          name: 'missing.txt',
          path: '/data/missing.txt',
          fileUrl: 'artifact://missing.txt',
          mimeType: 'text/plain',
          size: 0,
          mtimeMs: 1
        }
      ]
    })
    const resolveArtifact = vi.fn(async (artifact: NotebookRunRecord['artifacts'][number]) => {
      if (artifact.id === 'a2') throw new Error('missing')
      return { mimeType: 'image/png', data: 'cG5n' }
    })

    const notebook = await runDocumentToIpynb(makeDocument([run]), { resolveArtifact })

    expect(notebook.cells[0].outputs).toEqual([
      { output_type: 'display_data', data: { 'image/png': 'cG5n' }, metadata: {} },
      {
        output_type: 'stream',
        name: 'stderr',
        text: ['[Open Science] Could not inline artifact: missing.txt\n']
      }
    ])
  })

  it('is idempotent for the same document and deterministic resolver', async () => {
    const document = makeDocument([makeRun()])
    const first = await runDocumentToIpynb(document)
    const second = await runDocumentToIpynb(document)

    expect(second).toEqual(first)
  })
})
