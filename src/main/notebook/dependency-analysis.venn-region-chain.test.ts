import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import cells from './reported-venn-region-chain.fixture.json'

it('reconstructs the reported Excel, set-cleaning and Venn region chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-region-chain-'))
  const runs: NotebookRunRecord[] = cells.map(({ language, script }, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: language === 'r' ? 'r' : 'bash',
    kernelEpochId: language,
    environment: language,
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const result = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '4' })
      for (const id of ['2', '3', '4'])
        expect(result.stalenessByRunId[id], JSON.stringify(result)).toEqual({ state: 'clear' })
      const required = new Set(['4'])
      for (const id of required)
        for (const upstream of result.dependenciesByRunId?.[id] ?? []) required.add(upstream)
      expect([...required].sort()).toEqual(['2', '3', '4'])
      for (const index of [2, 3, 4]) {
        const context = await analyzer.sourceFileAccessContext({
          projectId: 'p',
          sessionId: 's',
          currentRunId: String(index),
          language: 'r',
          environment: 'r',
          kernelEpochId: 'r'
        })
        expect(
          await analyzeNotebookSourceFileAccess('r', cells[index]!.script, context)
        ).toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete',
          reads: index === 2 ? ['inputs/set-membership-111111111111.xlsx'] : [],
          writes: index === 4 ? ['proportional_venn_5sets.png'] : []
        })
      }
    }
    runs[4]!.script = 'cat(n)'
    const changed = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'p', sessionId: 's', throughRunId: '4' })
    expect(changed.stalenessByRunId['4']?.state).toBe('unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('analyzes the reported R chain in one cell', async () => {
  const { facts } = await analyzeRNotebookSource(
    cells
      .slice(2)
      .map((c) => c.script)
      .join('\n')
  )
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([
    'external-state'
  ])
})

it.each([
  'for(i in seq_along(sets)) for(j in seq_along(sets)) { n<-length(intersect(sets[[i]],sets[[j]]));cat(n) }',
  'for(i in seq_along(sets)) for(j in seq_along(sets)) if(j>i) { n<-length(intersect(sets[[i]],sets[[j]]));cat(n) }',
  'for(i in 1:3) if(i>1) { n<-i+1;cat(n) }'
])('isolates reporting values in bounded loops: %s', async (body) => {
  const { facts } = await analyzeRNotebookSource('sets<-list(A=1:3,B=2:4)\n' + body)
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([])
})

it.each([
  'for(i in seq_along(sets)) { if(i>1) n<-i;cat(n) }',
  'for(i in seq_along(sets)) if(i>1) {cat(n);n<-i}',
  'for(i in seq_along(sets)) if(i>1) n<-n+1',
  'for(i in seq_along(sets)) if(i>1) n<-i else cat(n)',
  'for(i in seq_along(sets)) if(i>n) {n<-i;cat(n)}',
  'for(i in seq_along(sets)) if(i>1) {n<-i;cat(n)}\ncat(n)',
  'for(i in seq_along(sets)) if(i>1) {n<<-i;cat(n)}',
  'for(i in seq_along(sets)) if(i>1) {n<-custom(i);cat(n)}',
  'for(i in seq_along(sets)) {if(i>1) break;n<-i;cat(n)}',
  'for(i in seq_along(sets)) {if(i>1) next;n<-i;cat(n)}',
  'for(i in seq_along(sets)) if(i>1) {if(i>2) n<-i;cat(n)}'
])('retains unresolved conditional values and side effects: %s', async (body) => {
  const { facts } = await analyzeRNotebookSource('sets<-list(A=1:3,B=2:4)\n' + body)
  expect(facts.state, JSON.stringify(facts)).toBe('unknown')
})
