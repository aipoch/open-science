import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { projectNotebookDependencies } from './dependency-projection'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import scenarios from './minimax-bioinformatics.fixture.json'

it.each(['DataFrame', 'Series'])(
  'preserves pandas %s through log-CPM and array conversion',
  async (kind) => {
    const source = `import numpy as np, pandas as pd
x = pd.${kind}([1,2,3])
y = np.log2(x.divide(2) + 1)
z = y.subtract(y.mean()).to_numpy()
np.save("bioqa_logcpm.npy", z)`
    const { facts } = await analyzePythonNotebookSource(source)
    expect(facts.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'y', typeName: `pandas.${kind}` }),
        expect.objectContaining({ target: 'z', typeName: 'numpy.ndarray' })
      ])
    )
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      writes: ['bioqa_logcpm.npy']
    })
  }
)

it('keeps array conversion sharing visible for later mutations', async () => {
  const scripts = [
    'import pandas as pd\ndf=pd.DataFrame([[1,2]])\nvalues=df.to_numpy()',
    'before=df.sum()',
    'values[0,0]=9'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: {
        runId: String(index),
        cellId: String(index),
        script,
        kernelKind: 'python' as const,
        kernelEpochId: 'epoch',
        environment: 'python',
        source: 'agent' as const,
        status: 'completed' as const,
        startedAt: index,
        endedAt: index + 1,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: []
      },
      facts: (await analyzePythonNotebookSource(script)).facts
    }))
  )
  expect(projectNotebookDependencies(entries.slice(0, 2)).stalenessByRunId['1']).toEqual({
    state: 'clear'
  })
  expect(projectNotebookDependencies(entries).stalenessByRunId['1']).toEqual({
    state: 'unknown',
    reasons: ['possible-alias']
  })
})

it('does not preserve pandas type through an explicit NumPy output buffer', async () => {
  const { facts } = await analyzePythonNotebookSource(
    'import numpy as np, pandas as pd\ndf=pd.DataFrame([[1,2]])\nbuf=np.zeros((1,2))\ny=np.log2(df,out=buf)'
  )
  expect(facts.typeBindings?.find((binding) => binding.target === 'y')?.typeName).not.toBe(
    'pandas.DataFrame'
  )
  expect(facts.mutatedNames).toContain('buf')
})

it('captures the generated Welch/BH stage and its downstream volcano across cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bioqa-de-'))
  // Input CSV generation has a separate sample.int limitation. Exercise the exact
  // generated analysis and plot with file inputs, without certifying that setup.
  const runs: NotebookRunRecord[] = scenarios[1]!.cells.slice(1).map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
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
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '1' })
    expect(projection.stalenessByRunId['1']).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.['1']).toContain('0')
    for (const run of runs) {
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: run.runId,
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      expect(await analyzeNotebookSourceFileAccess('r', run.script, context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: run.runId === '0' ? ['bioqa_logexpr.csv', 'bioqa_meta.csv'] : [],
        writes: run.runId === '0' ? [] : ['bioqa_de.csv', 'bioqa_volcano.png']
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'd<-data.frame(a=1:3,b=2:4);x<-t(apply(d,1,function(v)c(mean(v),sum(v))))',
  'd<-data.frame(a=1:3,b=2:4);x<-t(apply(FUN=function(v)c(mean(v),sum(v)),MARGIN=1,X=d,simplify=FALSE))'
])('retains ordinary apply results through transpose: %s', async (source) => {
  const { facts } = await analyzeRNotebookSource(source)
  expect(facts.state).toBe('available')
  expect(facts.copyOnModifyNames).toContain('x')
})

it.each([
  'd<-data.frame(a=1:3);x<-t(apply(d,1,function(v)new.env()))',
  'd<-readRDS("unknown.rds");x<-t(apply(d,1,function(v)v))',
  'd<-data.frame(a=1:3);apply<-custom;x<-t(apply(d,1,function(v)sum(v)))'
])('keeps unknown or reference-returning callbacks uncertain: %s', async (source) => {
  const { facts } = await analyzeRNotebookSource(source)
  expect(facts.state).toBe('unknown')
  expect(facts.copyOnModifyNames ?? []).not.toContain('x')
})
