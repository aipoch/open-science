import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-venn-layers.fixture.json'

it.each(
  [
    [5, 6],
    [4, 5, 6],
    [2, 5, 6],
    [3, 5, 6],
    [0, 1, 2, 3, 4, 5, 6]
  ].map((indices) => ({ indices }))
)('captures final Venn outputs with history $indices', async ({ indices }) => {
  const root = await mkdtemp(join(tmpdir(), 'venn-layers-'))
  const runs: NotebookRunRecord[] = cells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
    source: 'agent',
    status: index === 4 ? 'failed' : 'completed',
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
        repository: { readSessionRuns: async () => runs.filter((_, i) => indices.includes(i)) }
      })
      const projection = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        throughRunId: '6'
      })
      expect(projection.stalenessByRunId['6'], JSON.stringify(projection)).toEqual({
        state: 'clear'
      })
      expect(projection.dependenciesByRunId?.['6']).toEqual([])
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: '6',
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      expect(await analyzeNotebookSourceFileAccess('r', cells[6], context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['inputs/set-membership-111111111111.xlsx'],
        writes: ['proportional_venn_5sets.png', 'proportional_venn_5sets_hires.png']
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it.each([
  cells[2],
  cells[3],
  'base::system2("fc-list", args=":lang=zh", stdout=TRUE)',
  'sysfonts::font_add("font", "external.ttf")'
])('keeps primitive external effects out of R namespace mutation: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).toEqual(['external-state'])
  // No claim that the external font or command has itself been captured.
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})

it.each([
  'system<-custom;system("fc-list")',
  'other::system("fc-list")',
  'base::system(command())',
  'sysfonts::font_add("font", custom())',
  'other::font_add("font", "external.ttf")'
])('retains unknown external dispatch: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})

const plot = 'ggplot2::ggplot(data.frame(x=1:3,y=2:4),ggplot2::aes(x,y))+ggplot2::geom_point()'
it.each(['theme_void', 'theme_minimal', 'theme_bw', 'theme_dark'])(
  'recognizes a plot-owned complete %s',
  async (theme) => {
    const { facts } = await analyzeRNotebookSource(
      `p <- ${plot}+ggplot2::${theme}();ggplot2::ggsave("plot.png",p)`
    )
    expect(facts.rThemeState).toEqual({ reads: false, writes: false })
  }
)

it.each([
  `p <- ${plot};ggplot2::ggsave("plot.png",p)`,
  `p <- ${plot}+ggplot2::theme(legend.position="none");ggplot2::ggsave("plot.png",p)`,
  `p <- ${plot}+ggplot2::theme_void();p$theme <- ggplot2::theme();ggplot2::ggsave("plot.png",p)`,
  `p <- ${plot}+ggplot2::theme_void();q<-p;p$theme<-ggplot2::theme();ggplot2::ggsave("plot.png",q)`,
  `p <- ${plot}+ggplot2::theme_void();p<-${plot};ggplot2::ggsave("plot.png",p)`,
  `p <- ${plot}+ggplot2::theme_void();ggplot2::ggsave("plot.png")`,
  `p <- ${plot}+ggplot2::theme_void();q<-ggplot2::theme_get();ggplot2::ggsave("plot.png",p)`,
  `p <- ${plot}+ggplot2::theme_void()+ggplot2::ggplot(data.frame(x=1));ggplot2::ggsave("plot.png",p)`
])('retains unresolved global theme reads: %s', async (script) => {
  expect((await analyzeRNotebookSource(script)).facts.rThemeState?.reads).toBe(true)
})

it('keeps the failed theme provider when the later plot still inherits its theme', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-theme-required-'))
  const runs: NotebookRunRecord[] = [
    'ggplot2::theme_set(ggplot2::theme_minimal());stop("failed")',
    `p <- ${plot};ggplot2::ggsave("plot.png",p)`
  ].map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
    source: 'agent',
    status: index === 0 ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const result = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '1' })
    expect(result.stalenessByRunId['1']).toEqual({ state: 'unknown', reasons: ['incomplete-run'] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
