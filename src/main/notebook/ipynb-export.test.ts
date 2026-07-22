import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookRunDocument, NotebookRunRecord } from '../../shared/notebook'
import { projectRunDocumentToIpynb, stringifyIpynb } from './ipynb-export'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print("hello")',
  status: 'completed',
  startedAt: 1_700_000_000_000,
  executionCount: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const makeDocument = (runs: NotebookRunRecord[]): NotebookRunDocument => ({
  version: 1,
  projectName: 'project-a',
  sessionId: 'session-1',
  workspaceCwd: '/Users/example/workspace',
  notebookSessionRoot: '/data/notebooks/project-a/session-1',
  dataRoot: '/data/notebooks/project-a/session-1/data',
  kernel: {
    language: 'python',
    kernelName: 'python3',
    runtimeRoot: '/data/runtime',
    lastKnownStatus: 'idle'
  },
  runs,
  updatedAt: 1_700_000_100_000
})

describe('projectRunDocumentToIpynb', () => {
  it('emits an nbformat 4.5 document with kernelspec and open_science metadata', () => {
    const notebook = projectRunDocumentToIpynb(makeDocument([makeRun()]), { appVersion: '0.5.1' })

    expect(notebook.nbformat).toBe(4)
    expect(notebook.nbformat_minor).toBe(5)
    expect(notebook.metadata.kernelspec).toEqual({
      name: 'python3',
      display_name: 'Python 3',
      language: 'python'
    })
    expect(notebook.metadata.language_info).toEqual({ name: 'python' })
    expect(notebook.metadata.open_science).toEqual({
      sessionId: 'session-1',
      projectName: 'project-a',
      artifactSessionId: undefined,
      appVersion: '0.5.1'
    })
  })

  it('maps a run to a code cell preserving source lines, count, and provenance metadata', () => {
    const run = makeRun({
      runId: 'run-9',
      cellId: 'cell-9',
      script: 'import os\nimport requests\n',
      executionCount: 7,
      endedAt: 1_700_000_060_000,
      environment: 'default-python'
    })
    const [cell] = projectRunDocumentToIpynb(makeDocument([run])).cells

    expect(cell.cell_type).toBe('code')
    expect(cell.id).toBe('cell-9')
    expect(cell.source).toEqual(['import os\n', 'import requests\n'])
    expect(cell.execution_count).toBe(7)
    expect(cell.metadata.open_science).toEqual({
      kernel: 'python',
      runId: 'run-9',
      cellId: 'cell-9',
      source: 'agent',
      status: 'completed',
      startedAt: new Date(1_700_000_000_000).toISOString(),
      endedAt: new Date(1_700_000_060_000).toISOString(),
      environment: 'default-python'
    })
  })

  it('maps stream, display, json, and error outputs to their nbformat counterparts', () => {
    const run = makeRun({
      outputs: [
        { type: 'stream', name: 'stdout', text: 'first\nsecond\n' },
        { type: 'stream', name: 'stderr', text: 'warn' },
        { type: 'display', data: { 'image/png': 'aGVsbG8=' } },
        { type: 'json', data: { answer: 42 } },
        {
          type: 'error',
          message: 'ModuleNotFoundError: no module named requests',
          traceback: 'Traceback...\nModuleNotFoundError: no module named requests'
        }
      ]
    })
    const [cell] = projectRunDocumentToIpynb(makeDocument([run])).cells

    expect(cell.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['first\n', 'second\n'] },
      { output_type: 'stream', name: 'stderr', text: ['warn'] },
      { output_type: 'display_data', data: { 'image/png': 'aGVsbG8=' }, metadata: {} },
      { output_type: 'display_data', data: { 'application/json': { answer: 42 } }, metadata: {} },
      {
        output_type: 'error',
        ename: 'Error',
        evalue: 'ModuleNotFoundError: no module named requests',
        traceback: ['Traceback...', 'ModuleNotFoundError: no module named requests']
      }
    ])
  })

  it('falls back to the flattened text streams when a run has no structured outputs', () => {
    const run = makeRun({
      outputs: [],
      text: {
        stdout: 'ok\n',
        stderr: 'careful\n',
        traceback: 'line 1\nZeroDivisionError',
        plain: []
      }
    })
    const [cell] = projectRunDocumentToIpynb(makeDocument([run])).cells

    expect(cell.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['ok\n'] },
      { output_type: 'stream', name: 'stderr', text: ['careful\n'] },
      {
        output_type: 'error',
        ename: 'Error',
        evalue: '',
        traceback: ['line 1', 'ZeroDivisionError']
      }
    ])
  })

  it('downgrades bash runs to %%bash cells and exports repl runs verbatim with kernel tags', () => {
    const bash = makeRun({
      runId: 'run-b',
      cellId: 'bash-run-b',
      kernelKind: 'bash',
      script: 'ls -la'
    })
    const repl = makeRun({
      runId: 'run-r',
      cellId: 'repl-run-r',
      kernelKind: 'repl',
      script: 'await host.mcp()',
      executionCount: undefined
    })
    const [bashCell, replCell] = projectRunDocumentToIpynb(makeDocument([bash, repl])).cells

    expect(bashCell.source).toEqual(['%%bash\n', 'ls -la'])
    expect(bashCell.metadata.open_science.kernel).toBe('bash')
    expect(replCell.source).toEqual(['await host.mcp()'])
    expect(replCell.metadata.open_science.kernel).toBe('repl')
    expect(replCell.execution_count).toBeNull()
  })

  it('picks the dominant analysis kernel for the kernelspec', () => {
    const python = makeRun({ runId: 'p1', cellId: 'p1' })
    const r1 = makeRun({ runId: 'r1', cellId: 'r1', kernelKind: 'r' })
    const r2 = makeRun({ runId: 'r2', cellId: 'r2', kernelKind: 'r' })

    const rDominant = projectRunDocumentToIpynb(makeDocument([python, r1, r2]))
    expect(rDominant.metadata.kernelspec).toEqual({ name: 'ir', display_name: 'R', language: 'R' })
    expect(rDominant.metadata.language_info).toEqual({ name: 'R' })

    // Ties (and control-plane-only sessions) resolve to python3.
    const tied = projectRunDocumentToIpynb(makeDocument([python, r1]))
    expect(tied.metadata.kernelspec.name).toBe('python3')

    const shellOnly = projectRunDocumentToIpynb(
      makeDocument([makeRun({ kernelKind: 'bash', script: 'ls' })])
    )
    expect(shellOnly.metadata.kernelspec.name).toBe('python3')
  })

  it('produces unique, tooling-safe cell ids even from unsanitary or duplicated cellIds', () => {
    const runs = [
      makeRun({ runId: 'a', cellId: 'cell 1.2' }),
      makeRun({ runId: 'b', cellId: 'cell 1.2' }),
      makeRun({ runId: 'c', cellId: '...' })
    ]
    const cells = projectRunDocumentToIpynb(makeDocument(runs)).cells

    expect(cells[0].id).toBe('cell-1-2')
    expect(cells[1].id).toBe('cell-1-2-2')
    expect(cells[2].id).toBe('cell-2')
    expect(new Set(cells.map((cell) => cell.id)).size).toBe(3)
    for (const cell of cells) {
      expect(cell.id).toMatch(/^[A-Za-z0-9-_]+$/)
    }
  })

  it('is deterministic and embeds no absolute paths', () => {
    const document = makeDocument([
      makeRun({ outputs: [{ type: 'display', data: { 'image/png': 'aGVsbG8=' } }] })
    ])

    const first = stringifyIpynb(projectRunDocumentToIpynb(document, { appVersion: '0.5.1' }))
    const second = stringifyIpynb(projectRunDocumentToIpynb(document, { appVersion: '0.5.1' }))

    expect(first).toBe(second)
    expect(first.endsWith('\n')).toBe(true)
    expect(first).not.toContain('/Users/example/workspace')
    expect(first).not.toContain('/data/notebooks')
    // Round-trip: the serialized bytes parse back to the same projection.
    expect(JSON.parse(first)).toEqual(projectRunDocumentToIpynb(document, { appVersion: '0.5.1' }))
  })
})

describe('NotebookRuntimeService.exportIpynb', () => {
  let storageRoot: string | undefined

  const createStorageRoot = async (): Promise<string> => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-ipynb-export-'))
    return storageRoot
  }

  afterEach(async () => {
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true })
      storageRoot = undefined
    }
  })

  it('returns null without creating run.json when the session has none', async () => {
    const dataRoot = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: join(dataRoot, 'config'),
      dataRoot,
      projectName: 'project-a'
    })

    await expect(
      service.exportIpynb({ sessionId: 'missing', workspaceCwd: '/workspace' })
    ).resolves.toBeNull()
    await expect(
      service.exportIpynb({ sessionId: 'missing', workspaceCwd: '/workspace' })
    ).resolves.toBeNull()
  })

  it('projects the persisted run.json through the real repository path', async () => {
    const dataRoot = await createStorageRoot()
    const repository = new NotebookRunRepository(dataRoot)
    await repository.loadOrCreate({
      projectName: 'project-a',
      sessionId: '134d5d81aa-bbbb',
      workspaceCwd: '/workspace'
    })
    await repository.appendRun({
      projectName: 'project-a',
      sessionId: '134d5d81aa-bbbb',
      run: makeRun({ outputs: [{ type: 'stream', name: 'stdout', text: 'ok\n' }] })
    })
    const service = new NotebookRuntimeService({
      configRoot: join(dataRoot, 'config'),
      dataRoot,
      projectName: 'project-a',
      repository,
      appVersion: '0.5.1'
    })

    const exported = await service.exportIpynb({
      sessionId: '134d5d81aa-bbbb',
      workspaceCwd: '/workspace'
    })

    if (!exported) {
      throw new Error('expected an export for a persisted session')
    }

    expect(exported.suggestedName).toBe('notebook-134d5d81.ipynb')
    const notebook = JSON.parse(exported.json) as ReturnType<typeof projectRunDocumentToIpynb>
    expect(notebook.nbformat).toBe(4)
    expect(notebook.cells).toHaveLength(1)
    expect(notebook.cells[0].source).toEqual(['print("hello")'])
    expect(notebook.cells[0].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['ok\n'] }
    ])
    expect(notebook.metadata.open_science.appVersion).toBe('0.5.1')
  })
})
