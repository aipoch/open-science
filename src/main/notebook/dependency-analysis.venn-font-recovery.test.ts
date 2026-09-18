import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-venn-font-recovery.fixture.json'
const corrected = readFileSync(join(__dirname, 'reported-venn-font-recovery.R'), 'utf8')
const run = (script: string, index: number): NotebookRunRecord => ({
  runId: String(index),
  cellId: String(index),
  script,
  kernelKind: 'r',
  kernelEpochId: 'r',
  environment: 'r',
  source: 'agent',
  status: 'completed',
  kernelDispatched: true,
  startedAt: index,
  endedAt: index + 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})
it.each([cells[0]!.script, corrected])(
  'captures ordinary formatting and the Venn workflow: %#',
  async (script) => {
    const { facts } = await analyzeRNotebookSource(script)
    expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([
      'external-state'
    ])
    expect(facts.rOptionWrites).toEqual(['scipen'])
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/set-membership-111111111111.xlsx']
    })
  }
)
it.each([2, 3, 4, 5])('does not certify uncaptured font state in cell %i', async (index) => {
  const { facts } = await analyzeRNotebookSource(cells[index]!.script)
  expect(facts.state).toBe('unknown')
  expect((await analyzeNotebookSourceFileAccess('r', cells[index]!.script)).externalState).toBe(
    'partial'
  )
})
it.each(['options(scipen=999)', 'base::options(digits=7,width=120,max.print=1000)'])(
  'recognizes formatting setup: %s',
  async (script) => {
    expect((await analyzeRNotebookSource(script)).facts.state).toBe('available')
  }
)
it.each([
  'options(scipen=custom())',
  'options(scipen=999,device=custom)',
  'options(error=custom)',
  'options(scipen=NA)',
  'options(scipen=Inf)',
  'options(list(scipen=999))',
  'options<-custom;options(scipen=999)',
  'other::options(scipen=999)',
  'options()'
])('retains uncertain or executable options: %s', async (script) => {
  expect((await analyzeRNotebookSource(script)).facts.state).toBe('unknown')
})
it.each([false, true])(
  'keeps formatting setup in cross-cell dependencies, failed=%s',
  async (failed) => {
    const root = await mkdtemp(join(tmpdir(), 'r-options-'))
    const runs = [run('options(scipen=999)', 0), run('unrelated<-42', 1), run('print(1e9)', 2)]
    if (failed) runs[0]!.status = 'failed'
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const analyzer = new NotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => runs }
        })
        const projection = await analyzer.project({
          projectId: 'p',
          sessionId: 's',
          throughRunId: '2'
        })
        expect(projection.stalenessByRunId['2']?.state).toBe(failed ? 'unknown' : 'clear')
        if (!failed) expect(projection.dependenciesByRunId?.['2']).toEqual(['0'])
      }
      runs[2]!.kernelEpochId = 'new'
      const projection = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: '2' })
      expect(projection.stalenessByRunId['2']).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.['2']).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
it('recovers the corrected script in a fresh kernel after failed font attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-font-recovery-'))
  const runs: NotebookRunRecord[] = cells.map((cell, index) => ({
    ...run(cell.script, index),
    status: cell.status === 'failed' ? 'failed' : 'completed'
  }))
  runs.push({ ...run(corrected, 6), kernelEpochId: 'fresh' })
  try {
    const projection = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'p', sessionId: 's', throughRunId: '6' })
    expect(projection.stalenessByRunId['5']?.state).toBe('unknown')
    expect(projection.stalenessByRunId['6']).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.['6']).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
