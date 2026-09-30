import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { NotebookKernelExecutor } from './kernel-executor'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { verifyReplayCapture } from './scientific-replay.test-support'
import sqliteHandoff from './fixtures/lineage/readonly-sqlite-handoff.json'
import atomicPaths from './fixtures/lineage/cwd-unpacked-atomic-paths.json'
import sourceCallbacks from './fixtures/lineage/r-source-callback-inputs.json'
import failedHandoff from './fixtures/lineage/failed-cell-language-handoff.json'

// Reduced problem examples, not original model transcripts or scientific-data archives.
const portable = (path: string): string => normalize(path).replaceAll('\\', '/')

it.each([
  ['readonly SQLite cursor handoff', 'python', sqliteHandoff],
  ['cwd, unpacking and atomic publication', 'python', atomicPaths],
  ['R script and unresolved callback inputs', 'r', sourceCallbacks]
] as const)('retains file lineage across %s cells', async (_, language, fixture) => {
  const root = await mkdtemp(join(tmpdir(), 'lineage-regression-'))
  const runs: NotebookRunRecord[] = fixture.cells.map((cell, index) => ({
    runId: String(index),
    cellId: String(index),
    script: cell.code,
    source: 'agent',
    kernelKind: language,
    kernelEpochId: 'epoch',
    environment: language,
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    cwdBefore: root,
    cwdAfter: root,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    for (const [index, cell] of fixture.cells.entries()) {
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'project',
        sessionId: 'session',
        currentRunId: runs[index].runId,
        language,
        environment: language,
        kernelEpochId: 'epoch'
      })
      const access = await analyzeNotebookSourceFileAccess(language, cell.code, context)
      expect(access.reads.map(portable).sort(), `cell ${index} reads`).toEqual(
        [...cell.reads].sort()
      )
      expect(access.writes.map(portable).sort(), `cell ${index} writes`).toEqual(
        [...cell.writes].sort()
      )
      if (language === 'r' && index === 1) {
        expect(access.readState).toBe('partial')
        expect(access.writeState).toBe('partial')
        expect(access.externalState).toBe('partial')
      }
    }
    if (language === 'python') {
      const projection = await analyzer.project({
        projectId: 'project',
        sessionId: 'session',
        completedRun: runs.at(-1)!
      })
      expect(projection.dependenciesByRunId?.['1']).toContain('0')
    } else {
      const { facts } = await analyzeRNotebookSource(fixture.cells[2].code)
      expect(facts.usedNames).toContain('FUN')
      expect(facts.state).toBe('unknown')
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON || !process.env.OPEN_SCIENCE_TEST_RSCRIPT)(
  'keeps a failed-cell checkpoint usable across Python/R and atomic publication',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'failed-cell-handoff-'))
    const dataRoot = join(root, 'data')
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R')
    })
    try {
      await mkdir(dataRoot)
      for (const [index, cell] of failedHandoff.cells.entries()) {
        const language = cell.language === 'python' ? 'python' : 'r'
        const result = await executor.execute({
          language,
          code: cell.code,
          cwd: dataRoot,
          notebookSessionRoot: dataRoot,
          dataRoot,
          inputRoot: join(dataRoot, 'inputs'),
          runtimeRoot: join(root, 'runtime'),
          fileEvidenceStorageRoot: root,
          runId: `handoff-${index}`,
          resolvedInterpreter:
            language === 'python'
              ? { command: process.env.OPEN_SCIENCE_TEST_PYTHON!, args: ['-X', 'utf8'] }
              : {
                  command: process.env.OPEN_SCIENCE_TEST_RSCRIPT!,
                  args: ['--vanilla'],
                  condaPrefix: process.env.OPEN_SCIENCE_TEST_R_PREFIX
                }
        })
        expect(result.status, result.traceback || result.stderr).toBe(cell.status)
        if (cell.status === 'failed')
          expect(result.traceback).toContain('after checkpoint publication')
        await verifyReplayCapture(root, result, cell.writes)
        if (cell.status === 'failed') {
          expect(result.fileEvidence?.state).toBe('partial')
          expect(result.fileEvidence?.reasonCodes).toContain('execution-incomplete')
        }
        if (index === failedHandoff.cells.length - 1) expect(result.stdout).toContain('HANDOFF_OK')
      }
      const final = await readFile(join(dataRoot, 'outputs/final.tsv'), 'utf8')
      expect(final).toBe(await readFile(join(dataRoot, 'outputs/transferred.tsv'), 'utf8'))
      expect(final.replaceAll('\r\n', '\n')).toBe('label\tvalue\na\t2\nb\t3\n')
    } finally {
      expect((await executor.shutdown()).reaped).toBe(true)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60000
)
