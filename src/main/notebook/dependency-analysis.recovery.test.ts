import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './dependency-analysis'
import { analyzeRSources } from './dependency-analysis-r'

const cases = (['python', 'r'] as const).flatMap((language) =>
  (['failed', 'timeout', 'interrupted', 'cancelled'] as const).map((status) => ({
    language,
    status
  }))
)

it.each([
  'seq_len <- custom_sequence\nfor (i in seq_len(nrow(counts))) { pct <- i * 100; print(pct) }',
  'for (i in custom::seq_len(nrow(counts))) { pct <- i * 100; print(pct) }',
  'for (i in seq_len(nrow(counts))) { pct <- i * 100; print(pct) }\nprint(pct)',
  'for (i in seq_len(nrow(counts))) { pct <- unknown_transform(i); print(pct) }'
])('does not certify unknown or escaping R loop effects: %s', async (script) => {
  const run: NotebookRunRecord = {
    runId: 'loop',
    cellId: 'loop',
    source: 'agent',
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    script,
    status: 'completed',
    startedAt: 1,
    endedAt: 2,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: [],
    inputFiles: []
  }
  const [facts] = await analyzeRSources([script])
  expect(projectNotebookDependencies([{ run, facts }]).stalenessByRunId.loop).toMatchObject({
    state: 'unknown'
  })
})

it.each(cases)(
  'scopes $language $status evidence and recovers after reinitialization',
  async ({ language, status }) => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-recovery-'))
    const define = (name: string): string =>
      language === 'python' ? `${name} = [33, 33]` : `${name} <- c(33, 33)`
    const failed =
      language === 'python'
        ? 'raise RuntimeError("interrupted plotting")'
        : 'stop("interrupted plotting")'
    const sources = [
      define('values'),
      `${define('scratch')}\n${failed}`,
      'print(values)',
      `${define('values')}\n${failed}`,
      'print(values)',
      `${define('values')}\nprint(values)`
    ]
    const runs: NotebookRunRecord[] = sources.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      kernelKind: language,
      kernelEpochId: 'epoch',
      kernelDispatched: true,
      environment: `default-${language}`,
      script,
      status: index === 1 || index === 3 ? status : 'completed',
      startedAt: index,
      endedAt: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      inputFiles: [],
      workingFiles: []
    }))
    try {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs.slice(0, 3) }
      })
      const beforeMutation = await analyzer.project({
        projectId: 'project',
        sessionId: 'session',
        completedRun: runs[2]
      })
      expect(beforeMutation.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(beforeMutation.dependenciesByRunId?.['run-2']).toEqual(['run-0'])
      const incomplete = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs.slice(0, 5) }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: runs[4] })
      expect(incomplete.stalenessByRunId['run-4']).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['incomplete-run'])
      })
      const recovered = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: runs[5] })
      expect(recovered.stalenessByRunId['run-4'].state).not.toBe('clear')
      expect(recovered.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
      expect(recovered.dependenciesByRunId?.['run-5']).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(['seq_len(nrow(counts))', 'base::seq_len(nrow(counts))', 'seq_along(counts$n)'])(
  'keeps R loop assignments conditional for %s',
  async (sequence) => {
    const root = await mkdtemp(join(tmpdir(), 'r-empty-loop-'))
    const scripts = [
      `counts <- data.frame(n=numeric(0))\nfor (i in ${sequence}) { pct <- counts$n[i] * 100; print(pct) }`,
      'print(pct)'
    ]
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      inputFiles: [],
      workingFiles: []
    }))
    try {
      const result = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: runs[1] })
      expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
      expect(result.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
