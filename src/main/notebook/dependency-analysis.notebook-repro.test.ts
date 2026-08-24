import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookDependencyProjection } from './dependency-analysis-types'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const run = (index: number, script: string): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'python',
  kernelEpochId: 'epoch-1',
  environment: 'default-python',
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index,
  executionCount: index,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

const project = async (scripts: string[]): Promise<NotebookDependencyProjection> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-call-repro-'))
  temporaryRoots.push(storageRoot)
  const runs = scripts.map((script, index) => run(index + 1, script))
  return new NotebookDependencyAnalyzer({
    storageRoot,
    repository: { readSessionRuns: async () => runs }
  }).project({
    projectId: 'default-project',
    sessionId: 'session-1',
    completedRun: runs.at(-1),
    interpreter: { command: 'unused-python' }
  })
}

describe('reported Python call tracking regressions', () => {
  it('does not poison an unrelated later run after scoped control flow', async () => {
    const projection = await project(['for item in []:\n    value = item', 'unrelated = 1'])

    expect(projection.stalenessByRunId).toEqual({
      'run-1': { state: 'unknown', reasons: ['control-flow'] },
      'run-2': { state: 'clear' }
    })
  })

  it('classifies import and reflection helpers as read-only', async () => {
    const projection = await project([
      [
        'import importlib',
        'module = importlib.import_module("json")',
        'version = getattr(module, "__version__", "ok")'
      ].join('\n')
    ])

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies JSON decoding as read-only', async () => {
    const projection = await project(['import json\npayload = json.loads("{}")'])

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps dependencies on conditionally assigned names unknown', async () => {
    const projection = await project([
      'source = []\nvalue = 1',
      'snapshot = value',
      'for item in source:\n    value = item'
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['control-flow']
    })
  })

  it.each([
    ['method call', 'if enabled:\n    items.append(1)'],
    ['augmented assignment', 'if enabled:\n    items += [1]'],
    ['member write', 'if enabled:\n    items.value = 1']
  ])('keeps conditional %s mutations possible rather than definite', async (_, mutation) => {
    const projection = await project([
      'items = []\nenabled = True',
      'snapshot = len(items)',
      mutation
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('scopes unknown imported call effects to their arguments', async () => {
    const projection = await project([
      'from custom import transform\nsource = []\nresult = transform(source)',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['scoped-opaque-call'])
    })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('tracks captured names mutated by a local function', async () => {
    const projection = await project([
      'items = []',
      'snapshot = len(items)',
      'def update():\n    items.append(1)\nupdate()'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
  })

  it('keeps explicit global writes namespace-scoped', async () => {
    const projection = await project([
      'value = 1\ndef replace():\n    global value\n    value = 2\nreplace()',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('keeps nested helper effects namespace-scoped', async () => {
    const projection = await project([
      [
        'items = []',
        'def outer():',
        '    def nested():',
        '        items.append(1)',
        '    nested()',
        'outer()'
      ].join('\n'),
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('recognizes callables assigned from imported module attributes', async () => {
    const projection = await project([
      'import matplotlib.pyplot as plt\ncmap = plt.cm.Set2\ncolor = cmap(0)',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['scoped-opaque-call'])
    })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('keeps unknown members of from-import bindings scoped', async () => {
    const projection = await project([
      'from custom import namespace\nresult = namespace.build()',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['scoped-opaque-call'])
    })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })
})
