import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-font-fallback-volcano.fixture.json'

const runs: NotebookRunRecord[] = cells.map((cell) => ({
  runId: String(cell.index),
  cellId: String(cell.index),
  script: cell.script,
  kernelKind: 'r',
  kernelEpochId: 'epoch',
  environment: 'r',
  source: 'agent',
  status: cell.status === 'failed' ? 'failed' : 'completed',
  kernelDispatched: true,
  startedAt: cell.index,
  endedAt: cell.index + 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
}))

it.each([9, 10, 11])(
  'does not treat known inspection calls as arbitrary namespace mutation: %s',
  async (index) => {
    const { facts } = await analyzeRNotebookSource(cells[index].script)
    expect(
      facts.state === 'unknown' ? facts.reasons.filter((r) => r === 'opaque-call') : [],
      JSON.stringify(facts)
    ).toEqual([])
  }
)

it.each([2, 5, 6, 12])('captures self-contained plot cell %s', async (index) => {
  const { facts } = await analyzeRNotebookSource(cells[index].script)
  const access = await analyzeNotebookSourceFileAccess('r', cells[index].script)
  expect(access, JSON.stringify(facts)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('keeps unrelated font inspection and overwritten failed cells out of the final plot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'font-fallback-'))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(projection.stalenessByRunId['12'], JSON.stringify(projection)).toEqual({
      state: 'clear'
    })
    expect(projection.dependenciesByRunId?.['12']).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'pdfFonts()',
  'grDevices::pdfFonts()',
  'grDevices::postscriptFonts()',
  'grDevices::quartzFonts()',
  'grDevices::windowsFonts()',
  'capabilities()',
  'base::capabilities("png")',
  'capabilities(what="aqua")'
])('recognizes a read-only runtime query: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).toEqual(['external-state'])
  expect(facts.mutatedNames).toEqual([])
})

it.each([
  'pdfFonts<-custom;pdfFonts()',
  'capabilities<-custom;capabilities("png")',
  'grDevices::pdfFonts(custom=custom_font)',
  'grDevices::quartzFonts(custom=custom_font)',
  'grDevices::windowsFonts(custom=custom_font)',
  'grDevices::pdfFonts(custom())',
  'base::capabilities(what=custom())'
])(
  'does not treat font registration, shadowed queries or callbacks as read-only: %s',
  async (script) => {
    const { facts } = await analyzeRNotebookSource(script)
    expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
  }
)
