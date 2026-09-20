import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { projectNotebookDependencies } from './dependency-projection'
import type { NotebookRunRecord } from '../../shared/notebook'
import cells from './reported-heatmap.fixture.json'
it.each(['r', 'python'] as const)('captures the reported %s heatmap', async (language) => {
  const { facts } = await (language === 'r' ? analyzeRNotebookSource : analyzePythonNotebookSource)(
    cells[language]
  )
  const run: NotebookRunRecord = {
    runId: '0',
    cellId: '0',
    kernelKind: language,
    kernelEpochId: 'e',
    environment: language,
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: 0,
    endedAt: 1,
    script: cells[language],
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
  expect(
    projectNotebookDependencies([{ run, facts }]).stalenessByRunId['0'],
    JSON.stringify(facts)
  ).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess(language, cells[language])).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/heatmap-values-555555555555.csv'],
    writes: [language === 'r' ? 'heatmap_r.png' : 'heatmap_python.png']
  })
})

it.each([
  'other::pheatmap(matrix(1:4,2),filename="out.png")',
  'pheatmap<-custom;pheatmap(matrix(1:4,2),filename="out.png")',
  'pheatmap::pheatmap(unknown,filename="out.png")',
  'pheatmap::pheatmap(matrix(1:4,2),filename=unknown)',
  'pheatmap::pheatmap(matrix(1:4,2),filename="out.png",clustering_callback=custom)',
  'pheatmap::pheatmap(matrix(1:4,2),filename="out.png",kmeans_k=2)',
  'pheatmap::pheatmap(matrix(1:4,2),filename="out.png",kmeans=2)'
])('preserves uncertain R heatmap effects: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})
it('captures a named heatmap filename without confusing the palette for a path', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'out<-file.path("plots","heatmap.png");pheatmap::pheatmap(matrix(1:4,2),c("blue","red"),filename=out)'
    )
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: [],
    writes: ['plots/heatmap.png']
  })
})
it.each([
  'import seaborn as sns\ng=sns.clustermap([[1,2],[3,5]],metric=custom)',
  'from matplotlib.colors import LinearSegmentedColormap\nclass Custom:\n    def from_list(self,*args):\n        unknown()\nLinearSegmentedColormap=Custom()\ncmap=LinearSegmentedColormap.from_list("x",["blue","red"])'
])('preserves uncertain Python heatmap dispatch: %s', async (script) => {
  const { facts } = await analyzePythonNotebookSource(script)
  const run: NotebookRunRecord = {
    runId: '0',
    cellId: '0',
    kernelKind: 'python',
    kernelEpochId: 'e',
    environment: 'python',
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: 0,
    endedAt: 1,
    script,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
  expect(
    projectNotebookDependencies([{ run, facts }]).stalenessByRunId['0']?.state,
    JSON.stringify(facts)
  ).toBe('unknown')
})
it('captures ClusterGrid.savefig through an alias', async () => {
  const script =
    'import seaborn as sns\ng=sns.clustermap([[1,2],[3,5]])\nother=g\nother.ax_heatmap.set_title("Heatmap")\nother.savefig("out.png")'
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    writes: ['out.png']
  })
})

it.each([false, true])(
  'tracks cross-cell ClusterGrid axes (overwritten: %s)',
  async (overwritten) => {
    const scripts = [
      'import seaborn as sns\ng=sns.clustermap([[1,2],[3,5]])',
      `${overwritten ? 'class Custom:\n    def set_title(self, title):\n        unknown()\ng.ax_heatmap=Custom()\n' : ''}ax=g.ax_heatmap\nax.set_title("Updated heatmap")`,
      'g.savefig("out.png")'
    ]
    const entries = await Promise.all(
      scripts.map(async (script, index) => ({
        facts: (await analyzePythonNotebookSource(script)).facts,
        run: {
          runId: String(index),
          cellId: String(index),
          kernelKind: 'python' as const,
          kernelEpochId: 'e',
          environment: 'python',
          source: 'agent' as const,
          status: 'completed' as const,
          kernelDispatched: true,
          startedAt: index,
          endedAt: index + 1,
          script,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        }
      }))
    )
    const result = projectNotebookDependencies(entries)
    if (overwritten) {
      expect(
        result.stalenessByRunId['2']?.state,
        JSON.stringify({ result, facts: entries[1]?.facts })
      ).toBe('unknown')
      return
    }
    expect(result.stalenessByRunId['2']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['2']).toEqual(['1'])
    expect(result.dependenciesByRunId?.['1']).toEqual(['0'])
  }
)
