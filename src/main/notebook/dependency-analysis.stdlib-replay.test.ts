import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

import { stdlibReplayCases as cases } from './stdlib-replay.fixture'

const project = async (
  scripts: readonly string[]
): Promise<NotebookDependencyProjection['stalenessByRunId'][string]> => {
  const root = await mkdtemp(join(tmpdir(), 'stdlib-replay-'))
  try {
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      kernelKind: 'python',
      kernelEpochId: 'fresh-epoch',
      environment: 'default-python',
      script,
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const projection = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: runs.at(-1)! })
    return projection.stalenessByRunId[runs.at(-1)!.runId]
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each(cases)('captures complete replay dependencies for %s', async (_name, script) => {
  const dependencies = await project([script])
  const files = await analyzeNotebookSourceFileAccess('python', script)
  expect.soft(dependencies, JSON.stringify(dependencies)).toEqual({ state: 'clear' })
  expect.soft(files, JSON.stringify(files)).toMatchObject({
    reads: [],
    writes: ['result.txt'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it.each([
  ['r', ['result.txt'], []],
  ['w', [], ['result.txt']],
  ['x', [], ['result.txt']],
  ['a', ['result.txt'], ['result.txt']],
  ['r+', ['result.txt'], ['result.txt']],
  ['w+', [], ['result.txt']],
  ['xb', [], ['result.txt']]
])('preserves Path.open mode %s effects', async (mode, reads, writes) => {
  const script = `from pathlib import Path as P
p = P('result.txt')
with p.open(mode='${mode}') as stream:
    pass`
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads,
    writes,
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  `from pathlib import Path
Path = custom_path
with Path('result.txt').open('x') as f:
    f.write('6')`,
  `from pathlib import Path
with Path('result.txt').open(mode) as f:
    f.write('6')`,
  `from decimal import Decimal, getcontext
getcontext().prec = 2
value = Decimal('6') / Decimal('7')
print(value)`,
  `from collections import defaultdict
values = defaultdict(custom_factory)
print(values['x'])`,
  `from collections import defaultdict
int = custom_factory
values = defaultdict(int)
print(values['x'])`,
  `from collections import defaultdict
values = defaultdict(int)
values.default_factory = custom_factory
print(values['x'])`
])('retains uncertainty for unmodeled state and callbacks: %s', async (script) => {
  const dependencies = await project([script])
  const files = await analyzeNotebookSourceFileAccess('python', script)
  expect(
    dependencies.state !== 'clear' ||
      files.readState !== 'complete' ||
      files.writeState !== 'complete' ||
      files.externalState !== 'complete'
  ).toBe(true)
})

it.each([
  'from decimal import Decimal\nprint(Decimal(0.1))',
  'from decimal import Decimal\nprint(Decimal(value))',
  "from decimal import Decimal\nprint(Decimal('not-a-number'))",
  "from collections import defaultdict\nvalues = defaultdict(lambda: open('secret.txt').read())\nprint(values['x'])"
])('does not certify unsupported constructors: %s', async (script) => {
  expect(await project([script])).not.toEqual({ state: 'clear' })
})

it('retains factory replacement across cells', async () => {
  expect(
    await project([
      'from collections import defaultdict\nvalues = defaultdict(int)',
      'values.default_factory = custom_factory',
      "print(values['x'])"
    ])
  ).not.toEqual({ state: 'clear' })
})
