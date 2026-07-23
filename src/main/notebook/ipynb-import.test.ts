import { describe, expect, it } from 'vitest'

import type { NotebookRunDocument } from '../../shared/notebook'
import { runDocumentToIpynb } from './ipynb-export'
import { ipynbToRunRecords, type IpynbImportResult } from './ipynb-import'

const context = {
  importedAt: 1_000,
  createId: (() => {
    let value = 0
    return () => String(++value)
  })()
}

const importNotebook = (notebook: unknown): IpynbImportResult =>
  ipynbToRunRecords(notebook, {
    importedAt: context.importedAt,
    createId: context.createId
  })

describe('ipynbToRunRecords', () => {
  it('validates the nbformat major version and cells array', () => {
    expect(() => importNotebook({ nbformat: 3, cells: [] })).toThrow('expected nbformat 4')
    expect(() => importNotebook({ nbformat: 4 })).toThrow('cells must be an array')
  })

  it('imports code cells, skips markdown, and reconstructs all supported outputs', () => {
    const result = importNotebook({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', language: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['# Title\n'] },
        {
          cell_type: 'code',
          source: ['print("hello")\n', '2 + 2'],
          execution_count: 4,
          metadata: {
            open_science: { kernel: 'python', environment: 'analysis' }
          },
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['hello\n'] },
            { output_type: 'stream', name: 'stderr', text: 'warning\n' },
            {
              output_type: 'error',
              ename: 'ValueError',
              evalue: 'bad value',
              traceback: ['line 1\n', 'line 2']
            },
            {
              output_type: 'display_data',
              data: { 'image/png': 'aW1hZ2U=', 'text/plain': '<plot>' },
              metadata: {}
            },
            {
              output_type: 'display_data',
              data: { 'application/json': { answer: 42 } },
              metadata: {}
            },
            {
              output_type: 'execute_result',
              data: { 'text/plain': ['4'] },
              metadata: {},
              execution_count: 4
            }
          ]
        }
      ]
    })

    expect(result.skippedCellCount).toBe(1)
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]).toMatchObject({
      source: 'user',
      inputKind: 'cell',
      kernelKind: 'python',
      script: 'print("hello")\n2 + 2',
      status: 'imported',
      startedAt: 1_000,
      executionCount: 4,
      environment: 'analysis',
      text: {
        stdout: 'hello\n',
        stderr: 'warning\n',
        traceback: 'line 1\nline 2'
      }
    })
    expect(result.runs[0].outputs).toEqual([
      { type: 'stream', name: 'stdout', text: 'hello\n' },
      { type: 'stream', name: 'stderr', text: 'warning\n' },
      {
        type: 'error',
        name: 'ValueError',
        message: 'bad value',
        traceback: 'line 1\nline 2'
      },
      { type: 'display', data: { 'image/png': 'aW1hZ2U=', 'text/plain': '<plot>' } },
      { type: 'json', data: { answer: 42 } },
      { type: 'text', text: '4' }
    ])
  })

  it('uses kernelspec fallback and restores downgraded bash/repl source markers', () => {
    const result = importNotebook({
      nbformat: 4,
      metadata: { kernelspec: { name: 'ir', language: 'R' } },
      cells: [
        {
          cell_type: 'code',
          source: 'print(1)',
          execution_count: null,
          metadata: {},
          outputs: []
        },
        {
          cell_type: 'code',
          source: ['%%bash\n', 'pwd'],
          execution_count: null,
          metadata: { tags: ['open-science-bash'] },
          outputs: []
        },
        {
          cell_type: 'code',
          source: '%%javascript\nawait host.mcp()',
          execution_count: null,
          metadata: { open_science: { kernel: 'repl' } },
          outputs: []
        }
      ]
    })

    expect(result.runs.map(({ kernelKind, script }) => ({ kernelKind, script }))).toEqual([
      { kernelKind: 'r', script: 'print(1)' },
      { kernelKind: 'bash', script: 'pwd' },
      { kernelKind: 'repl', script: 'await host.mcp()' }
    ])
  })

  it('round-trips the supported Open Science subset in both directions', async () => {
    const source = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { display_name: 'Python 3', name: 'python3', language: 'python' } },
      cells: [
        {
          cell_type: 'code',
          id: 'source-cell',
          source: ['x = 1\n', 'x'],
          execution_count: 7,
          metadata: { open_science: { kernel: 'python', environment: 'analysis' } },
          outputs: [
            {
              output_type: 'execute_result',
              data: { 'text/plain': '1' },
              metadata: {},
              execution_count: 7
            }
          ]
        }
      ]
    }
    const imported = importNotebook(source)
    const document: NotebookRunDocument = {
      version: 1,
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/storage/notebooks/default-project/session-1',
      dataRoot: '/storage/notebooks/default-project/session-1/data',
      kernel: {
        language: 'python',
        kernelName: 'python3',
        runtimeRoot: '/storage/runtime',
        lastKnownStatus: 'idle'
      },
      runs: imported.runs,
      updatedAt: 1_000
    }

    const exported = await runDocumentToIpynb(document)
    expect(exported.cells[0]).toMatchObject({
      source: source.cells[0].source,
      execution_count: 7,
      outputs: source.cells[0].outputs,
      metadata: {
        open_science: { kernel: 'python', environment: 'analysis', status: 'imported' }
      }
    })

    const reimported = importNotebook(exported)
    expect(
      reimported.runs.map(({ script, kernelKind, executionCount, outputs }) => ({
        script,
        kernelKind,
        executionCount,
        outputs
      }))
    ).toEqual(
      imported.runs.map(({ script, kernelKind, executionCount, outputs }) => ({
        script,
        kernelKind,
        executionCount,
        outputs
      }))
    )
  })
})
