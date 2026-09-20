import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzePythonSources, analyzePythonNotebookSource } from './dependency-analysis-python'
import { projectNotebookFileContext, type FileContextEntry } from './dependency-file-context'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const cells = readFileSync(join(__dirname, 'reported-pycirclize.fixture.py'), 'utf8').split(
  '\n# %%\n'
)
const run = (script: string, index: number): NotebookRunRecord => ({
  runId: String(index),
  cellId: String(index),
  kernelKind: 'python',
  kernelEpochId: 'python',
  environment: 'python',
  source: 'agent',
  status: 'completed',
  kernelDispatched: true,
  startedAt: index,
  endedAt: index + 1,
  script,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it.each([0, 1])('captures source cell %i without unrelated file uncertainty', async (index) => {
  const files = await analyzeNotebookSourceFileAccess('python', cells[index]!)
  expect(files, JSON.stringify(files)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('reconstructs the reported workbook-to-chord cell dependencies', async () => {
  const facts = await analyzePythonSources(cells)
  const projection = projectNotebookDependencies(
    cells.map((script, i) => ({ run: run(script, i), facts: facts[i]! }))
  )
  for (const index of [0, 1, 2])
    expect(projection.stalenessByRunId[String(index)], `cell ${index}`).toEqual({ state: 'clear' })
  expect(projection.dependenciesByRunId?.['2']).toContain('1')
  expect(projection.dependenciesByRunId?.['2']).not.toContain('0')
})

it('captures the workbook input and both figure outputs', async () => {
  const files = await analyzeNotebookSourceFileAccess('python', cells.join('\n'))
  expect(files, JSON.stringify(files)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.pdf', 'chord_diagram.png']
  })
})

it('carries matrix identity and its input across cell file contexts', async () => {
  const entries: FileContextEntry[] = []
  for (const [index, script] of cells.entries()) {
    const context = projectNotebookFileContext('python', entries)
    const files = await analyzeNotebookSourceFileAccess('python', script, context)
    expect(files, JSON.stringify({ index, files })).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    const { facts, fileAccess } = await analyzePythonNotebookSource(script, context)
    entries.push({ facts, fileContext: fileAccess!.context })
  }
})

it.each(['chord_diagram', 'initialize_from_matrix'])(
  'captures %s with a path and direct savefig',
  async (method) => {
    const script = `from pycirclize import Circos as C\nc=C.${method}(matrix="inputs/matrix.tsv")\nc.savefig(savefile="chord.png")`
    expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/matrix.tsv'],
      writes: ['chord.png']
    })
  }
)

it.each(['"sum"', '["sum", "mean"]', '{"value": "sum"}'])(
  'recognizes named pivot reducers %s',
  async (aggfunc) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        cells[1]!.replace('aggfunc="sum"', `aggfunc=${aggfunc}`)
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
  }
)

it.each([
  cells.join('\n').replace('link_kws=dict(', 'link_kws_handler=custom, link_kws=dict('),
  cells.join('\n').replace('aggfunc="sum"', 'aggfunc=custom'),
  cells.join('\n').replace('aggfunc="sum"', 'aggfunc="custom"'),
  'from pycirclize import Circos\nCircos.chord_diagram=custom\nc=Circos.chord_diagram("matrix.tsv")',
  'from pycirclize import Circos\nc=Circos.chord_diagram(unknown_path)',
  'from pycirclize import Circos\nc=Circos.chord_diagram("matrix.tsv")\nc.unknown_method()'
])('retains unresolved input and callback effects: %#', async (script) => {
  const files = await analyzeNotebookSourceFileAccess('python', script)
  expect([files.readState, files.writeState, files.externalState], JSON.stringify(files)).toContain(
    'partial'
  )
})
