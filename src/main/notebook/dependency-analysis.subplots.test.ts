import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './dependency-analysis'
import { analyzePythonSources } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { reportedSubplots, reportedSubplotsInput } from './reported-python-subplots.fixture'

it.each([
  ['inspection', reportedSubplotsInput],
  ['combined plot', reportedSubplots]
])('captures the reported CSV read in %s', async (_label, script) => {
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads: ['inputs/sample-groups-666666666666.csv'],
    readState: 'complete',
    writeState: 'complete'
  })
  if (script === reportedSubplots) {
    expect((await analyzeNotebookSourceFileAccess('python', script)).writes).toEqual([
      'synthetic_groups_group_plots.png'
    ])
  }
})

it('analyzes the reported combined plot without incomplete execution facts', async () => {
  const [facts] = await analyzePythonSources([reportedSubplots])
  expect(facts.state === 'unknown' ? facts.reasons : []).toEqual(['external-state'])
})

it.each([
  ['flat', 'fig, right = plt.subplots()'],
  ['nested', 'fig, (left, right) = plt.subplots(1, 2)']
])('isolates %s assignment', async (_name, body) => {
  const script = `import matplotlib.pyplot as plt\n${body}\nbars = right.bar([1], [2])\nfor bar in bars:\n    bar.get_height()`
  const [facts] = await analyzePythonSources([script])
  expect(facts.state === 'unknown' ? facts.reasons : []).toEqual([])
  expect((await analyzeNotebookSourceFileAccess('python', script)).readState).toBe('complete')
})

const run = (script: string, index: number): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  kernelKind: 'python',
  kernelEpochId: 'epoch',
  kernelDispatched: true,
  environment: 'default-python',
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it.each([
  ['flat', 'fig, right', ''],
  ['tuple', 'fig, (left, right)', '1, 2'],
  ['list', '[fig, [left, right]]', '1, 2'],
  ['grid', 'fig, ((a, b), (left, right))', '2, 2'],
  ['squeeze disabled', 'fig, ((left, right),)', '1, 2, squeeze=False']
])('preserves %s subplot unpacking across runs and cache reload', async (_name, target, args) => {
  const root = await mkdtemp(join(tmpdir(), 'nested-subplots-'))
  const runs = [
    `import matplotlib.pyplot as plt\n${target} = plt.subplots(${args})`,
    `bars = right.bar([1], [2])\nfor bar in bars:\n    ${target.includes('left') ? 'left' : 'right'}.text(0, bar.get_height(), "height")\nfig.savefig("panels.png")`
  ].map(run)
  const repository = { readSessionRuns: async () => runs }
  const request = { projectId: 'project', sessionId: 'session', interpreter: { command: 'unused' } }
  try {
    const analyzer = new NotebookDependencyAnalyzer({ storageRoot: root, repository })
    const projection = await analyzer.project({ ...request, completedRun: runs[1] })
    expect(projection.stalenessByRunId).toEqual({
      'run-0': { state: 'clear' },
      'run-1': { state: 'clear' }
    })
    expect(projection.dependenciesByRunId?.['run-1']).toEqual(['run-0'])
    const sidecarPath = join(root, 'notebooks/project/session/cache/dependency-analysis.json')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
    delete sidecar.projectionSnapshots
    await writeFile(sidecarPath, JSON.stringify(sidecar))
    const analyze = vi.fn(async () => {
      throw new Error('must reuse captured facts')
    })
    const reloaded = new NotebookDependencyAnalyzer({ storageRoot: root, repository, analyze })
    expect(await reloaded.project(request)).toEqual(projection)
    expect(analyze).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the second reported read self-contained in a two-block dependency projection', async () => {
  const runs = [reportedSubplotsInput, reportedSubplots].map(run)
  const facts = await analyzePythonSources(runs.map((run) => run.script))
  const projection = projectNotebookDependencies(
    runs.map((run, index) => ({ run, facts: facts[index]! }))
  )
  expect(projection.stalenessByRunId).toEqual({
    'run-0': { state: 'clear' },
    'run-1': { state: 'clear' }
  })
  expect(projection.dependenciesByRunId?.['run-1']).toEqual([])
})

it.each([
  'import matplotlib.pyplot as plt\nplt.subplots = custom_subplots\nfig, (a, b) = plt.subplots(1, 2)',
  'from custom_plotting import subplots\nfig, (a, b) = subplots(1, 2)'
])('does not certify an unknown subplot factory: %s', async (setup) => {
  const script = `${setup}\nbars = b.bar([1], [2])\nfor bar in bars:\n    bar.get_height()`
  const [facts] = await analyzePythonSources([script])
  expect(
    projectNotebookDependencies([{ run: run(script, 0), facts }]).stalenessByRunId['run-0'].state
  ).toBe('unknown')
})
