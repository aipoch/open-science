import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type {
  AnalyzedNotebookRun,
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessAnalysis
} from './dependency-analysis-types'
import { projectNotebookFileDependencies } from './dependency-projection'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { NotebookKernelExecutor } from './kernel-executor'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { sha256, verifyReplayCapture } from './scientific-replay.test-support'
import sqliteHandoff from './fixtures/lineage/readonly-sqlite-handoff.json'
import atomicPaths from './fixtures/lineage/cwd-unpacked-atomic-paths.json'
import sourceCallbacks from './fixtures/lineage/r-source-callback-inputs.json'
import failedHandoff from './fixtures/lineage/failed-cell-language-handoff.json'
import nativeHandoff from './fixtures/lineage/native-array-report-handoff.json'
import emptyReportRecovery from './fixtures/lineage/failed-empty-model-report.json'
import missingGlobal from './fixtures/lineage/native-model-missing-global.json'
import callbackPromises from './fixtures/lineage/native-callback-helper-promises.json'

// Reduced problem examples, not original model transcripts or scientific-data archives.
const portable = (path: string): string => normalize(path).replaceAll('\\', '/')

const handoffRuns = (
  cwd: string,
  cells: Array<{
    language: string
    code: string
    status?: string
    kernel_epoch?: number
  }> = nativeHandoff.cells
): NotebookRunRecord[] =>
  cells.map((cell, index) => ({
    runId: `native-${index}`,
    cellId: `native-${index}`,
    script: cell.code,
    source: 'agent',
    kernelKind: cell.language === 'r' ? 'r' : 'python',
    kernelEpochId: `native-${cell.language}-${cell.kernel_epoch ?? 0}`,
    environment: `default-${cell.language}`,
    status: cell.status === 'failed' ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    cwdBefore: cwd,
    cwdAfter: cwd,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))

it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON || !process.env.OPEN_SCIENCE_TEST_RSCRIPT).each([
  {
    name: 'missing training constant',
    fixture: missingGlobal,
    missingNames: ['center'],
    failures: new Map([[1, 'center']]),
    modelVersions: 2,
    reports: ['warm-only\n', 'cold-pending\n', 'failure-observed\n', [5, 9], [9, 5]]
  },
  {
    name: 'transitive helper and lazy argument',
    fixture: callbackPromises,
    missingNames: ['scale_signal', 'scale'],
    failures: new Map([
      [1, 'scale_signal'],
      [4, 'non-numeric argument']
    ]),
    modelVersions: 3,
    reports: [
      'warm-only\n',
      'cold-pending\n',
      'failure-observed\n',
      'lazy-pending\n',
      'cold-pending\n',
      [5, 9],
      [9, 5]
    ]
  }
])(
  'captures cold recovery failure and repair: $name',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'native-missing-global-'))
    const dataRoot = join(root, 'data')
    const runs = handoffRuns(dataRoot, scenario.fixture.cells)
    const history: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => history }
    })
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R')
    })
    const generations: Array<{ path: string; key: string; checksum: string }> = []
    const previous = new Map<string, string>()
    const epochs = new Map<string, string>()
    try {
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await mkdir(join(dataRoot, 'outputs'))
      await writeFile(join(dataRoot, 'inputs/calibration.csv'), scenario.fixture.input)
      for (const [index, cell] of scenario.fixture.cells.entries()) {
        const run = runs[index]
        const language = cell.language === 'r' ? 'r' : 'python'
        // An epoch change is backed by a genuinely new process, not just a different label.
        const restarted = epochs.has(language) && epochs.get(language) !== run.kernelEpochId
        if (restarted) {
          let stopped = await executor.shutdown()
          // Reconcile late native teardown proof for the same owned process; never run cold
          // recovery until shutdown positively confirms that the previous tree was reaped.
          if (!stopped.reaped) stopped = await executor.shutdown()
          expect(stopped.reaped, JSON.stringify(stopped)).toBe(true)
        }
        epochs.set(language, run.kernelEpochId!)
        const context = await analyzer.sourceFileAccessContext({
          projectId: 'project',
          sessionId: 'session',
          currentRunId: run.runId,
          language,
          environment: run.environment!,
          kernelEpochId: run.kernelEpochId!
        })
        const access = await analyzeNotebookSourceFileAccess(language, cell.code, context)
        expect(access.reads.map(portable).sort()).toEqual(cell.reads)
        expect(access.writes.map(portable).sort()).toEqual(cell.writes)
        if (restarted) {
          for (const name of scenario.missingNames)
            expect(context?.resolvedKernelNames ?? []).not.toContain(name)
          expect((await analyzeRNotebookSource(cell.code, context)).facts.state).toBe('unknown')
        }
        const result = await executor.execute({
          language,
          environment: run.environment!,
          kernelEpochId: run.kernelEpochId!,
          code: cell.code,
          cwd: dataRoot,
          dataRoot,
          notebookSessionRoot: dataRoot,
          inputRoot: join(dataRoot, 'inputs'),
          runtimeRoot: join(root, 'runtime'),
          fileEvidenceStorageRoot: root,
          runId: run.runId,
          sourceFileAccessContext: context,
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
        const evidence = await verifyReplayCapture(root, result, cell.writes)
        if (scenario.failures.has(index)) {
          expect(result.traceback).toContain(scenario.failures.get(index))
          expect(result.fileEvidence?.reasonCodes).toContain('execution-incomplete')
          expect(result.fileEvidence?.state).toBe('partial')
          expect(
            (await readFile(join(dataRoot, 'outputs/report.txt'), 'utf8')).replaceAll('\r\n', '\n')
          ).toBe('cold-pending\n')
        }
        for (const relation of evidence.relations) {
          const path = portable(relation.relativePath)
          if (relation.relation === 'present-before' && previous.has(path)) {
            expect(relation.authority).toBe('advisory')
            expect(relation.generation?.checksum).toBe(previous.get(path))
          }
          if (['created', 'modified'].includes(relation.relation)) {
            previous.set(path, relation.generation!.checksum)
            generations.push({
              path,
              key: relation.generation!.contentStorageKey!,
              checksum: relation.generation!.checksum
            })
          }
        }
        history.push({
          ...run,
          status: result.status,
          outputs: result.outputs,
          text: {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            traceback: result.traceback ?? '',
            plain: []
          },
          workingFiles: result.workingFiles ?? [],
          fileEvidence: result.fileEvidence
        })
        const projection = await analyzer.project({
          projectId: 'project',
          sessionId: 'session',
          completedRun: history.at(-1)!
        })
        // Files can cross these boundaries; live memory dependencies cannot.
        const byId = new Map(history.map((entry) => [entry.runId, entry]))
        for (const [consumerId, producerIds] of Object.entries(
          projection.dependenciesByRunId ?? {}
        )) {
          const consumer = byId.get(consumerId)!
          for (const producerId of producerIds) {
            const producer = byId.get(producerId)!
            expect(producer.kernelKind).toBe(consumer.kernelKind)
            expect(producer.environment).toBe(consumer.environment)
            expect(producer.kernelEpochId).toBe(consumer.kernelEpochId)
          }
        }
      }
      expect((await executor.shutdown()).reaped).toBe(true)
      for (const version of generations)
        expect(sha256(await readFile(join(root, version.key)))).toBe(version.checksum)
      const models = generations.filter((v) => v.path === 'outputs/model.rds')
      expect(models).toHaveLength(scenario.modelVersions)
      expect(new Set(models.map((version) => version.checksum)).size).toBe(models.length)
      const reports = generations.filter((v) => v.path === 'outputs/report.txt')
      expect(reports).toHaveLength(scenario.reports.length)
      const texts = await Promise.all(
        reports.map(async (v) =>
          (await readFile(join(root, v.key), 'utf8')).replaceAll('\r\n', '\n')
        )
      )
      for (const [index, expected] of scenario.reports.entries()) {
        if (typeof expected === 'string') expect(texts[index]).toBe(expected)
        else {
          const values = texts[index].trim().split(/\s+/u).map(Number)
          expect(values).toHaveLength(expected.length)
          values.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 10))
        }
      }
      expect(await readFile(join(dataRoot, 'inputs/calibration.csv'), 'utf8')).toBe(
        scenario.fixture.input
      )
    } finally {
      await executor.shutdown()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60000
)

it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON || !process.env.OPEN_SCIENCE_TEST_RSCRIPT)(
  'preserves a failed empty report through repair and cold native-model recovery',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'empty-model-report-'))
    const dataRoot = join(root, 'data')
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R')
    })
    const history: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => history }
    })
    const versions: Array<{ key: string; checksum: string }> = []
    try {
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await mkdir(join(dataRoot, 'outputs'))
      await writeFile(join(dataRoot, 'inputs/counts.csv'), emptyReportRecovery.input)
      for (const [index, cell] of emptyReportRecovery.cells.entries()) {
        const language = cell.language === 'r' ? 'r' : 'python'
        const runId = `empty-${index}`
        const kernelEpochId = `${language}-${index}`
        const context = await analyzer.sourceFileAccessContext({
          projectId: 'project',
          sessionId: 'session',
          currentRunId: runId,
          language,
          environment: language,
          kernelEpochId
        })
        const access = await analyzeNotebookSourceFileAccess(language, cell.code, context)
        expect(access.reads.map(portable).sort()).toEqual(cell.reads)
        expect(access.writes.map(portable).sort()).toEqual(cell.writes)
        const result = await executor.execute({
          language,
          environment: language,
          kernelEpochId,
          code: cell.code,
          cwd: dataRoot,
          dataRoot,
          notebookSessionRoot: dataRoot,
          inputRoot: join(dataRoot, 'inputs'),
          runtimeRoot: join(root, 'runtime'),
          fileEvidenceStorageRoot: root,
          runId,
          sourceFileAccessContext: context,
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
        const capture = await verifyReplayCapture(root, result, cell.writes)
        if (index === 0) {
          expect(result.traceback).toContain('invalid connection')
          expect(result.fileEvidence?.reasonCodes).toContain('execution-incomplete')
          expect(result.fileEvidence?.state).toBe('partial')
          expect(await readFile(join(dataRoot, 'outputs/report.json'))).toEqual(Buffer.alloc(0))
        } else {
          const incoming = capture.relations.find(
            (r) =>
              r.relation === 'present-before' && portable(r.relativePath) === 'outputs/report.json'
          )
          expect(incoming?.authority).toBe('advisory')
          expect(incoming?.generation?.checksum).toBe(versions.at(-1)!.checksum)
        }
        const report = capture.relations.find(
          (r) =>
            ['created', 'modified'].includes(r.relation) &&
            portable(r.relativePath) === 'outputs/report.json'
        )!
        expect(report.generation?.sizeBytes === 0).toBe(index === 0)
        versions.push({
          key: report.generation!.contentStorageKey!,
          checksum: report.generation!.checksum
        })
        history.push({
          runId,
          cellId: runId,
          script: cell.code,
          source: 'agent',
          kernelKind: language,
          kernelEpochId,
          environment: language,
          status: result.status,
          kernelDispatched: result.kernelDispatched,
          startedAt: index,
          endedAt: index + 1,
          cwdBefore: dataRoot,
          cwdAfter: dataRoot,
          text: {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            traceback: result.traceback ?? '',
            plain: []
          },
          outputs: result.outputs,
          workingFiles: result.workingFiles ?? [],
          fileEvidence: result.fileEvidence
        })
        await analyzer.project({
          projectId: 'project',
          sessionId: 'session',
          completedRun: history.at(-1)!
        })
        // The fitted model must survive the failed training cell without its original R globals.
        if (index === 0) expect((await executor.shutdown()).reaped).toBe(true)
      }
      expect((await executor.shutdown()).reaped).toBe(true)
      const contents = await Promise.all(versions.map((v) => readFile(join(root, v.key))))
      expect(contents[0]).toEqual(Buffer.alloc(0))
      expect(JSON.parse(contents[1].toString())).toEqual({ stage: 'python-repaired' })
      const restored = JSON.parse(contents[2].toString())
      expect(restored.stage).toBe('r-restored')
      expect(restored.nobs).toBe(6)
      expect(restored.original).toBeCloseTo(2, 8)
      expect(restored.doubled).toBeCloseTo(4, 8)
      for (const [index, version] of versions.entries())
        expect(sha256(contents[index])).toBe(version.checksum)
      expect(await readFile(join(dataRoot, 'inputs/counts.csv'), 'utf8')).toBe(
        emptyReportRecovery.input
      )
    } finally {
      await executor.shutdown()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60000
)

it.each([
  ['gzip and native-array', nativeHandoff],
  ['missing native-model global and local recipe repair', missingGlobal],
  ['transitive native helper and lazy argument repair', callbackPromises],
  ['failed empty report and native-model', emptyReportRecovery]
])('retains %s file handoffs across separate Python/R epochs', async (_, fixture) => {
  const root = await mkdtemp(join(tmpdir(), 'native-handoff-source-'))
  const runs = handoffRuns(root, fixture.cells)
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot: root,
    repository: { readSessionRuns: async () => runs }
  })
  try {
    for (const [index, cell] of fixture.cells.entries()) {
      const language = cell.language === 'r' ? 'r' : 'python'
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'project',
        sessionId: 'session',
        currentRunId: runs[index].runId,
        language,
        environment: runs[index].environment!,
        kernelEpochId: runs[index].kernelEpochId!
      })
      const access = await analyzeNotebookSourceFileAccess(language, cell.code, context)
      expect(access.reads.map(portable).sort(), `cell ${index} reads`).toEqual(cell.reads)
      expect(access.writes.map(portable).sort(), `cell ${index} writes`).toEqual(cell.writes)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// Like real-notebook-lineage.integration.test.ts, this opt-in Python interpreter needs NumPy.
it.skipIf(
  !process.env.RUN_REAL_NOTEBOOK ||
    !process.env.OPEN_SCIENCE_TEST_PY_ENV ||
    !process.env.OPEN_SCIENCE_TEST_RSCRIPT
)(
  'preserves each incoming report generation through NPZ/RDS cross-language recovery',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-handoff-runtime-'))
    const dataRoot = join(root, 'data')
    const runs = handoffRuns(dataRoot)
    const history: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => history }
    })
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R')
    })
    const versions: Array<{ checksum: string; key: string }> = []
    try {
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await mkdir(join(dataRoot, 'outputs'))
      const input = gzipSync(nativeHandoff.input)
      await writeFile(join(dataRoot, 'inputs/signal.tsv.gz'), input)
      for (const [index, cell] of nativeHandoff.cells.entries()) {
        const language = cell.language === 'r' ? 'r' : 'python'
        const context = await analyzer.sourceFileAccessContext({
          projectId: 'project',
          sessionId: 'session',
          currentRunId: runs[index].runId,
          language,
          environment: runs[index].environment!,
          kernelEpochId: runs[index].kernelEpochId!
        })
        const result = await executor.execute({
          language,
          environment: runs[index].environment!,
          kernelEpochId: runs[index].kernelEpochId!,
          code: cell.code,
          cwd: dataRoot,
          dataRoot,
          notebookSessionRoot: dataRoot,
          inputRoot: join(dataRoot, 'inputs'),
          runtimeRoot: join(root, 'runtime'),
          fileEvidenceStorageRoot: root,
          runId: runs[index].runId,
          sourceFileAccessContext: context,
          resolvedInterpreter:
            language === 'python'
              ? { command: process.env.OPEN_SCIENCE_TEST_PY_ENV!, args: ['-X', 'utf8'] }
              : {
                  command: process.env.OPEN_SCIENCE_TEST_RSCRIPT!,
                  args: ['--vanilla'],
                  condaPrefix: process.env.OPEN_SCIENCE_TEST_R_PREFIX
                }
        })
        expect(result.status, result.traceback || result.stderr).toBe('completed')
        const captured = await verifyReplayCapture(root, result, cell.writes)
        if (index >= 3) {
          const incoming = captured.relations.find(
            (r) =>
              r.relation === 'present-before' && portable(r.relativePath) === 'outputs/report.txt'
          )
          expect(incoming?.authority).toBe('advisory')
          expect(incoming?.generation?.checksum).toBe(versions.at(-1)!.checksum)
        }
        const report = captured.relations.find(
          (r) =>
            ['created', 'modified'].includes(r.relation) &&
            portable(r.relativePath) === 'outputs/report.txt'
        )
        if (report)
          versions.push({
            checksum: report.generation!.checksum,
            key: report.generation!.contentStorageKey!
          })
        history.push({
          ...runs[index],
          outputs: result.outputs,
          workingFiles: result.workingFiles ?? [],
          fileEvidence: result.fileEvidence
        })
        await analyzer.project({
          projectId: 'project',
          sessionId: 'session',
          completedRun: history.at(-1)!
        })
      }
      const contents = await Promise.all(versions.map((v) => readFile(join(root, v.key), 'utf8')))
      expect(contents.map((text) => text.replaceAll('\r\n', '\n'))).toEqual([
        'python-pending\n',
        'python-reviewed\n',
        'r-verified\n'
      ])
      expect(await readFile(join(dataRoot, 'inputs/signal.tsv.gz'))).toEqual(input)
      expect(
        (await readFile(join(dataRoot, 'outputs/report.txt'), 'utf8')).replaceAll('\r\n', '\n')
      ).toBe('r-verified\n')
      expect((await executor.shutdown()).reaped).toBe(true)
      for (const version of versions)
        expect(sha256(await readFile(join(root, version.key)))).toBe(version.checksum)
    } finally {
      await executor.shutdown()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60000
)

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

type FixtureCell = {
  stage: number
  language: 'r' | 'python'
  code: string
  reads: string[]
  writes: string[]
  execution?: 'exhausted'
  failure?: string
}
type ScienceFixture = {
  scenario: string
  languages: Array<'r' | 'python'>
  status: string
  evidence: { realAgent: boolean; responses: number; physicalRuns: number; retries: number }
  observedHashes: Record<string, string>
  cells: FixtureCell[]
  lineage: { status: 'verified' | 'withheld'; edges?: string[][]; failure?: string }
}

const fixturePath = join(__dirname, 'fixtures/science/cross-language-lineage.fixture.jsonl')
const fixturePortable = (value: string): string => normalize(value).replaceAll('\\', '/')
const fixtures = readFileSync(fixturePath, 'utf8')
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line) as ScienceFixture)

describe('real-agent science lineage fixtures', () => {
  it('keeps only the complete Iris lineage and the Faithful2 contract boundary', () => {
    expect(fixtures.map(({ scenario }) => scenario)).toEqual([
      'iris-cross-language',
      'faithful2-cross-language-next'
    ])
    expect(fixtures.every(({ evidence }) => evidence.realAgent)).toBe(true)
    for (const fixture of fixtures)
      for (const hash of Object.values(fixture.observedHashes))
        expect(hash).toMatch(/^[a-f0-9]{64}$/u)
    expect(fixtures[0]?.lineage.status).toBe('verified')
    expect(fixtures[0]?.lineage.edges).toHaveLength(7)
    expect(fixtures[1]?.lineage.status).toBe('withheld')
    expect(fixtures[1]?.cells.at(-1)?.execution).toBe('exhausted')
    expect(fixtures[1]?.lineage.failure).toContain('semantic node IDs')
  })

  it.each(fixtures)('$scenario preserves multi-cell file dependencies', async (fixture) => {
    expect(fixture.cells).toHaveLength(4)
    expect(fixture.cells.map(({ language }) => language)).toEqual(fixture.languages)
    for (const cell of fixture.cells) {
      const access = await analyzeNotebookSourceFileAccess(cell.language, cell.code)
      expect(
        access.reads
          .map(fixturePortable)
          .every((path) => cell.reads.map(fixturePortable).includes(path)),
        `${fixture.scenario} stage ${cell.stage} reads remain within the agent declaration`
      ).toBe(true)
      expect(
        access.writes
          .map(fixturePortable)
          .every((path) => cell.writes.map(fixturePortable).includes(path)),
        `${fixture.scenario} stage ${cell.stage} writes remain within the agent declaration`
      ).toBe(true)
    }
  })

  it.each(fixtures)(
    '$scenario projects cross-language file lineage from observed generations',
    async (fixture) => {
      const root = await mkdtemp(join(tmpdir(), 'science-file-lineage-'))
      const dataRoot = join(root, 'data')
      const runs: NotebookRunRecord[] = fixture.cells.map((cell, index) => {
        const runId = `${fixture.scenario}-${index}`
        return {
          runId,
          cellId: runId,
          script: cell.code,
          source: 'agent',
          kernelKind: cell.language,
          kernelEpochId: `${cell.language}-epoch`,
          environment: cell.language,
          status: 'completed',
          kernelDispatched: true,
          startedAt: index,
          endedAt: index + 1,
          cwdBefore: dataRoot,
          cwdAfter: dataRoot,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: cell.writes.map((relativePath) => ({
            path: join(dataRoot, relativePath),
            relativePath: join('data', relativePath),
            kind: 'other' as const,
            createdByRunId: runId,
            change: 'created' as const,
            checksum: createHash('sha256').update(`${runId}:${relativePath}`).digest('hex')
          }))
        }
      })
      try {
        const facts: NotebookRunDependencyFacts = {
          state: 'available',
          definedNames: [],
          usedNames: [],
          mutatedNames: [],
          priorUsedNames: [],
          memberWrites: []
        }
        const fileAccess = (cell: FixtureCell): NotebookSourceFileAccessAnalysis => ({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete',
          reads: cell.reads,
          writes: cell.writes,
          reasonCodes: []
        })
        const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies(
          runs.map((run, index) => ({ run, facts, fileAccess: fileAccess(fixture.cells[index]!) }))
        )
        const dependencies = projection
        expect(dependencies[`${fixture.scenario}-1`]?.map(({ path }) => path).sort()).toEqual(
          [fixture.cells[0]!.writes[0]].sort()
        )
        expect(dependencies[`${fixture.scenario}-2`]?.map(({ path }) => path).sort()).toEqual(
          fixture.cells[2]!.reads.map((path) => normalize(path).replaceAll('\\', '/'))
            .filter((path) => fixture.cells.slice(0, 2).some((cell) => cell.writes.includes(path)))
            .sort()
        )
        expect(dependencies[`${fixture.scenario}-3`]?.length).toBeGreaterThanOrEqual(2)
        expect(
          dependencies[`${fixture.scenario}-3`]?.every(
            ({ confidence }) => confidence === 'verified'
          )
        ).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('links scoped companion generations across the data-root namespace', () => {
    const root = join(tmpdir(), 'science-scoped-lineage')
    const dataRoot = join(root, 'data')
    const facts: NotebookRunDependencyFacts = {
      state: 'available',
      definedNames: [],
      usedNames: [],
      mutatedNames: [],
      priorUsedNames: [],
      memberWrites: []
    }
    const producer: NotebookRunRecord = {
      runId: 'scoped-producer',
      cellId: 'scoped-producer',
      script: '',
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: 'r-epoch',
      environment: 'r',
      status: 'completed',
      kernelDispatched: true,
      startedAt: 0,
      endedAt: 1,
      cwdBefore: dataRoot,
      workingFiles: [
        {
          path: join(dataRoot, 'outputs/map.dbf'),
          relativePath: 'data/outputs/map.dbf',
          kind: 'other',
          createdByRunId: 'scoped-producer',
          change: 'created',
          checksum: 'a'.repeat(64)
        }
      ],
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: []
    }
    const consumer: NotebookRunRecord = {
      ...producer,
      runId: 'scoped-consumer',
      cellId: 'scoped-consumer',
      startedAt: 1,
      endedAt: 2,
      workingFiles: []
    }
    const fileAccess = {
      readState: 'complete' as const,
      writeState: 'complete' as const,
      externalState: 'complete' as const,
      reads: [],
      writes: [],
      writeScopes: [{ kind: 'shapefile' as const, path: './outputs/map.shp' }],
      reasonCodes: []
    }
    const consumerAccess = { ...fileAccess, writeScopes: undefined, reads: ['outputs/map.dbf'] }
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess },
      { run: consumer, facts, fileAccess: consumerAccess }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection['scoped-consumer']).toEqual([
      expect.objectContaining({
        producerRunId: 'scoped-producer',
        path: 'outputs/map.dbf',
        checksum: 'a'.repeat(64),
        confidence: 'verified'
      })
    ])
    const absoluteScopeProjection = projectNotebookFileDependencies([
      {
        run: producer,
        facts,
        fileAccess: {
          ...fileAccess,
          writeScopes: [{ kind: 'shapefile' as const, path: join(dataRoot, 'outputs/map.shp') }]
        }
      },
      { run: consumer, facts, fileAccess: consumerAccess }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(absoluteScopeProjection.fileDependenciesByRunId['scoped-consumer']).toEqual([
      expect.objectContaining({ producerRunId: 'scoped-producer', path: 'outputs/map.dbf' })
    ])
    const completeEvidence = {
      schemaVersion: 1 as const,
      state: 'available' as const,
      fileReads: 'complete' as const,
      relationCount: 1,
      activityKind: 'notebook-run' as const,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'complete' as const,
      scientificOutputAnalysis: 'complete' as const,
      externalPaths: 'complete' as const,
      writerAttribution: 'complete' as const,
      scientificOutputCount: 0,
      reasonCodes: []
    }
    const cwdlessScopedProducer: NotebookRunRecord = {
      ...producer,
      runId: 'cwdless-scoped-producer',
      cellId: 'cwdless-scoped-producer',
      cwdBefore: undefined,
      cwdAfter: undefined,
      fileEvidence: completeEvidence,
      workingFiles: [
        {
          ...producer.workingFiles[0]!,
          relativePath: 'outputs/map.dbf',
          createdByRunId: 'cwdless-scoped-producer'
        }
      ]
    }
    const cwdlessScopedConsumer: NotebookRunRecord = {
      ...consumer,
      runId: 'cwdless-scoped-consumer',
      cellId: 'cwdless-scoped-consumer',
      cwdBefore: undefined,
      cwdAfter: undefined,
      fileEvidence: completeEvidence
    }
    const cwdlessCaseVariantPath =
      process.platform === 'win32' ? 'outputs/RESULT.csv' : 'outputs/result.csv'
    const cwdlessCaseVariantProducer: NotebookRunRecord = {
      ...cwdlessScopedProducer,
      runId: 'cwdless-case-variant-producer',
      cellId: 'cwdless-case-variant-producer',
      workingFiles: [
        {
          ...cwdlessScopedProducer.workingFiles[0]!,
          path: join(dataRoot, 'Outputs/Result.csv'),
          relativePath: 'outputs/result.csv',
          createdByRunId: 'cwdless-case-variant-producer'
        }
      ]
    }
    const cwdlessCaseVariantConsumer: NotebookRunRecord = {
      ...cwdlessScopedConsumer,
      runId: 'cwdless-case-variant-consumer',
      cellId: 'cwdless-case-variant-consumer'
    }
    const cwdlessCaseVariantProjection = projectNotebookFileDependencies(
      [
        {
          run: cwdlessCaseVariantProducer,
          facts,
          fileAccess: {
            ...fileAccess,
            reads: [],
            writes: [cwdlessCaseVariantPath],
            writeScopes: undefined
          }
        },
        {
          run: cwdlessCaseVariantConsumer,
          facts,
          fileAccess: {
            ...consumerAccess,
            reads: [cwdlessCaseVariantPath]
          }
        }
      ].map(({ run, ...entry }) => ({
        run: { ...run, fileEvidence: completeEvidence },
        ...entry
      })) satisfies readonly AnalyzedNotebookRun[]
    )
    expect(
      cwdlessCaseVariantProjection.fileDependenciesByRunId['cwdless-case-variant-consumer']
    ).toEqual([
      expect.objectContaining({
        producerRunId: 'cwdless-case-variant-producer',
        path: cwdlessCaseVariantPath,
        confidence: 'verified'
      })
    ])
    expect(
      projectNotebookFileDependencies([
        {
          run: cwdlessScopedProducer,
          facts,
          fileAccess: { ...fileAccess, writes: [] }
        },
        {
          run: cwdlessScopedConsumer,
          facts,
          fileAccess: { ...consumerAccess, reads: ['outputs/map.dbf'] }
        }
      ]).fileDependenciesByRunId['cwdless-scoped-consumer']
    ).toEqual([
      expect.objectContaining({
        producerRunId: 'cwdless-scoped-producer',
        path: 'outputs/map.dbf',
        confidence: 'verified'
      })
    ])
    const exactCompanionOverwrite: NotebookRunRecord = {
      ...producer,
      runId: 'exact-companion-overwrite',
      cellId: 'exact-companion-overwrite',
      startedAt: 1,
      endedAt: 2,
      workingFiles: [
        {
          ...producer.workingFiles[0]!,
          createdByRunId: 'exact-companion-overwrite',
          change: 'modified',
          checksum: 'd'.repeat(64)
        }
      ]
    }
    const afterExactCompanionOverwrite = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess },
      {
        run: exactCompanionOverwrite,
        facts,
        fileAccess: { ...fileAccess, writes: ['outputs/map.dbf'], writeScopes: undefined }
      },
      {
        run: consumer,
        facts,
        fileAccess: { ...consumerAccess, reads: ['outputs/map.shp'] }
      }
    ])
    expect(afterExactCompanionOverwrite.fileDependenciesByRunId['scoped-consumer']).toBeUndefined()
    expect(afterExactCompanionOverwrite.unresolvedFileReadRunIds).toContain('scoped-consumer')
    const scopedReadWriteRun: NotebookRunRecord = {
      ...consumer,
      runId: 'scoped-read-write',
      cellId: 'scoped-read-write'
    }
    const scopedReadWrite = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess },
      {
        run: scopedReadWriteRun,
        facts,
        fileAccess: { ...consumerAccess, writeScopes: fileAccess.writeScopes }
      }
    ])
    expect(scopedReadWrite.unresolvedFileReadRunIds).toContain('scoped-read-write')
    expect(scopedReadWrite.fileDependenciesByRunId['scoped-read-write']).toBeUndefined()
    const partialWriter: NotebookRunRecord = {
      ...producer,
      runId: 'scoped-partial-writer',
      cellId: 'scoped-partial-writer',
      startedAt: 1,
      endedAt: 2,
      workingFiles: [
        {
          ...producer.workingFiles[0]!,
          createdByRunId: 'scoped-partial-writer',
          change: 'modified',
          checksum: 'b'.repeat(64)
        }
      ]
    }
    const { fileDependenciesByRunId: withheld } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess },
      {
        run: partialWriter,
        facts,
        fileAccess: {
          ...consumerAccess,
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial',
          writes: ['outputs/map.dbf'],
          reasonCodes: ['dynamic-path-unresolved']
        }
      },
      { run: consumer, facts, fileAccess: consumerAccess }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(withheld['scoped-consumer']).toBeUndefined()

    const unobservedScopedWriter: NotebookRunRecord = {
      ...producer,
      runId: 'scoped-unobserved-writer',
      cellId: 'scoped-unobserved-writer',
      startedAt: 1,
      endedAt: 2,
      workingFiles: []
    }
    const { fileDependenciesByRunId: scopeWithheld } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess },
      { run: unobservedScopedWriter, facts, fileAccess },
      { run: consumer, facts, fileAccess: consumerAccess }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(scopeWithheld['scoped-consumer']).toBeUndefined()

    const companionProducer: NotebookRunRecord = {
      ...producer,
      runId: 'scoped-companion-producer',
      cellId: 'scoped-companion-producer',
      workingFiles: [
        {
          ...producer.workingFiles[0]!,
          path: join(dataRoot, 'outputs/map.shx'),
          relativePath: 'data/outputs/map.shx',
          createdByRunId: 'scoped-companion-producer',
          checksum: 'c'.repeat(64)
        }
      ]
    }
    const partialScopeWriter: NotebookRunRecord = {
      ...producer,
      runId: 'scoped-partial-scope-writer',
      cellId: 'scoped-partial-scope-writer',
      workingFiles: [producer.workingFiles[0]!]
    }
    const partialScopeProjection = projectNotebookFileDependencies([
      { run: companionProducer, facts, fileAccess },
      { run: partialScopeWriter, facts, fileAccess },
      {
        run: {
          ...consumer,
          runId: 'scoped-companion-consumer',
          cellId: 'scoped-companion-consumer'
        },
        facts,
        fileAccess: { ...consumerAccess, reads: ['outputs/map.shx'] }
      }
    ])
    expect(
      partialScopeProjection.fileDependenciesByRunId['scoped-companion-consumer']
    ).toBeUndefined()
  })
})

describe('file lineage identity and completeness guards', () => {
  const facts: NotebookRunDependencyFacts = {
    state: 'available',
    definedNames: [],
    usedNames: [],
    mutatedNames: [],
    priorUsedNames: [],
    memberWrites: []
  }
  const run = (
    runId: string,
    cwd: string,
    workingFiles: NotebookRunRecord['workingFiles'] = []
  ): NotebookRunRecord => ({
    runId,
    cellId: runId,
    script: '',
    source: 'agent',
    kernelKind: 'python',
    kernelEpochId: 'epoch',
    environment: 'python',
    status: 'completed',
    kernelDispatched: true,
    startedAt: 0,
    endedAt: 1,
    cwdBefore: cwd,
    cwdAfter: cwd,
    workingFiles,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: []
  })
  const access = (reads: string[], writes: string[]): NotebookSourceFileAccessAnalysis => ({
    readState: 'complete' as const,
    writeState: 'complete' as const,
    externalState: 'complete' as const,
    reads,
    writes,
    reasonCodes: [] as []
  })

  it('registers observed outputs when runtime evidence completes a conservative writer', () => {
    const root = join(tmpdir(), 'lineage-partial-static-complete-runtime')
    const output = join(root, 'outputs', 'roads.gpkg')
    const evidence = {
      schemaVersion: 1 as const,
      state: 'available' as const,
      fileReads: 'complete' as const,
      relationCount: 1,
      activityKind: 'notebook-run' as const,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'complete' as const,
      scientificOutputAnalysis: 'complete' as const,
      externalPaths: 'complete' as const,
      writerAttribution: 'complete' as const,
      scientificOutputCount: 1,
      reasonCodes: []
    }
    const producer = {
      ...run('partial-writer', root, [
        {
          path: output,
          relativePath: 'outputs/roads.gpkg',
          kind: 'other' as const,
          createdByRunId: 'partial-writer',
          change: 'created' as const,
          checksum: 'r'.repeat(64)
        }
      ]),
      fileEvidence: evidence
    }
    const consumer = run('consumer-after-partial-writer', root)
    const projection = projectNotebookFileDependencies([
      {
        run: producer,
        facts,
        fileAccess: {
          ...access([], ['outputs/roads.gpkg']),
          writeState: 'partial',
          externalState: 'partial',
          reasonCodes: ['source-analysis-unsupported-call']
        }
      },
      { run: consumer, facts, fileAccess: access(['outputs/roads.gpkg'], []) }
    ])
    expect(projection.fileDependenciesByRunId['consumer-after-partial-writer']).toEqual([
      expect.objectContaining({
        producerRunId: 'partial-writer',
        path: 'outputs/roads.gpkg',
        confidence: 'verified'
      })
    ])
  })

  it('does not alias a data-prefixed read to a different root file', () => {
    const root = join(tmpdir(), 'lineage-path-identity')
    const producer = run('producer', root, [
      {
        path: join(root, 'foo.txt'),
        relativePath: 'foo.txt',
        kind: 'other',
        createdByRunId: 'producer',
        change: 'created',
        checksum: 'a'.repeat(64)
      }
    ])
    const consumer = run('consumer', root)
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['foo.txt']) },
      { run: consumer, facts, fileAccess: access(['data/foo.txt'], []) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.consumer).toBeUndefined()
  })

  it('withholds relative matching when runs have no shared cwd evidence', () => {
    const root = join(tmpdir(), 'lineage-unknown-cwd')
    const producer = { ...run('producer', root, []), cwdBefore: undefined, cwdAfter: undefined }
    const consumer = { ...run('consumer', root, []), cwdBefore: undefined, cwdAfter: undefined }
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      {
        run: {
          ...producer,
          workingFiles: [
            {
              path: join(root, 'result.json'),
              relativePath: 'result.json',
              kind: 'other',
              createdByRunId: 'producer',
              change: 'created',
              checksum: 'i'.repeat(64)
            }
          ]
        },
        facts,
        fileAccess: access([], ['result.json'])
      },
      { run: consumer, facts, fileAccess: access(['result.json'], []) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.consumer).toBeUndefined()
  })

  it('retains legacy relative matching when complete runtime evidence anchors the session', () => {
    const root = join(tmpdir(), 'lineage-legacy-evidence')
    const evidence = {
      schemaVersion: 1 as const,
      state: 'available' as const,
      fileReads: 'complete' as const,
      relationCount: 1,
      activityKind: 'notebook-run' as const,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'complete' as const,
      scientificOutputAnalysis: 'complete' as const,
      externalPaths: 'complete' as const,
      writerAttribution: 'complete' as const,
      scientificOutputCount: 0,
      reasonCodes: []
    }
    const producer = {
      ...run('producer', root, [
        {
          path: join(root, 'result.json'),
          relativePath: 'result.json',
          kind: 'other' as const,
          createdByRunId: 'producer',
          change: 'created' as const,
          checksum: 'k'.repeat(64)
        }
      ]),
      cwdBefore: undefined,
      cwdAfter: undefined,
      fileEvidence: evidence
    }
    const consumer = {
      ...run('consumer', root),
      cwdBefore: undefined,
      cwdAfter: undefined,
      fileEvidence: evidence
    }
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['result.json']) },
      { run: consumer, facts, fileAccess: access(['result.json'], []) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.consumer).toEqual([
      expect.objectContaining({ producerRunId: 'producer', confidence: 'verified' })
    ])
  })

  it('withholds unobserved writes when writer attribution is incomplete', () => {
    const root = join(tmpdir(), 'lineage-incomplete-writer-evidence')
    const evidence = {
      schemaVersion: 1 as const,
      state: 'available' as const,
      fileReads: 'complete' as const,
      relationCount: 1,
      activityKind: 'notebook-run' as const,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'complete' as const,
      scientificOutputAnalysis: 'complete' as const,
      externalPaths: 'complete' as const,
      writerAttribution: 'complete' as const,
      scientificOutputCount: 0,
      reasonCodes: []
    }
    const producer = {
      ...run('producer', root, [
        {
          path: join(root, 'result.json'),
          relativePath: 'result.json',
          kind: 'other' as const,
          createdByRunId: 'producer',
          change: 'created' as const,
          checksum: 'p'.repeat(64)
        }
      ]),
      fileEvidence: evidence
    }
    const unobservedWriter = {
      ...run('unobserved-writer', root),
      fileEvidence: { ...evidence, writerAttribution: 'partial' as const }
    }
    const consumer = { ...run('consumer', root), fileEvidence: evidence }
    const projection = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['result.json']) },
      { run: unobservedWriter, facts, fileAccess: access([], ['result.json']) },
      { run: consumer, facts, fileAccess: access(['result.json'], []) }
    ])
    expect(projection.fileDependenciesByRunId.consumer).toBeUndefined()
    expect(projection.unresolvedFileReadRunIds).toContain('consumer')
  })

  it('marks dynamic-only file reads unresolved even when no path is statically recovered', () => {
    const runWithDynamicRead = run('dynamic-read', join(tmpdir(), 'lineage-dynamic-read'))
    const { unresolvedFileReadRunIds } = projectNotebookFileDependencies([
      {
        run: runWithDynamicRead,
        facts,
        fileAccess: {
          readState: 'partial',
          writeState: 'complete',
          externalState: 'partial',
          reads: [],
          writes: [],
          reasonCodes: ['dynamic-path-unresolved']
        }
      }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(unresolvedFileReadRunIds).toEqual(['dynamic-read'])
  })

  it('does not use cwdAfter to resolve relative paths when cwdBefore is missing', () => {
    const rootBefore = join(tmpdir(), 'lineage-cwd-before-missing')
    const rootAfter = join(tmpdir(), 'lineage-cwd-after-only')
    const producer = {
      ...run('producer', rootBefore, [
        {
          path: join(rootBefore, 'result.json'),
          relativePath: 'result.json',
          kind: 'other',
          createdByRunId: 'producer',
          change: 'created',
          checksum: 'j'.repeat(64)
        }
      ]),
      cwdBefore: undefined,
      cwdAfter: rootAfter
    }
    const consumer = run('consumer', rootAfter)
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['result.json']) },
      { run: consumer, facts, fileAccess: access(['result.json'], []) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.consumer).toBeUndefined()
  })

  it('matches relative and absolute spellings of the same recorded path', () => {
    const root = join(tmpdir(), 'lineage-path-absolute')
    const output = join(root, 'data/result.json')
    const producer = run('producer', root, [
      {
        path: output,
        relativePath: 'data/result.json',
        kind: 'other',
        createdByRunId: 'producer',
        change: 'created',
        checksum: 'b'.repeat(64)
      }
    ])
    const consumer = run('consumer', root)
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['data/result.json']) },
      { run: consumer, facts, fileAccess: access([output], []) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.consumer).toEqual([
      expect.objectContaining({ producerRunId: 'producer', confidence: 'verified' })
    ])
  })

  it('quarantines a producer when a later directory scope is observed from another cwd', () => {
    const rootA = join(tmpdir(), 'lineage-scope-cwd-a')
    const rootB = join(tmpdir(), 'lineage-scope-cwd-b')
    const shared = join(tmpdir(), 'lineage-scope-shared')
    const output = join(shared, 'old.csv')
    const producer = {
      ...run('producer', rootA, [
        {
          path: output,
          relativePath: 'old.csv',
          kind: 'other' as const,
          createdByRunId: 'producer',
          change: 'created' as const,
          checksum: 's'.repeat(64)
        }
      ]),
      fileEvidence: {
        schemaVersion: 1 as const,
        state: 'available' as const,
        fileReads: 'complete' as const,
        relationCount: 1,
        activityKind: 'notebook-run' as const,
        initialViewState: 'complete' as const,
        managedRootsFinalState: 'complete' as const,
        scientificOutputAnalysis: 'complete' as const,
        externalPaths: 'complete' as const,
        writerAttribution: 'complete' as const,
        scientificOutputCount: 0,
        reasonCodes: []
      }
    }
    const scopedWriter = {
      ...run('scoped-writer', rootB),
      workingFiles: [],
      fileEvidence: producer.fileEvidence
    }
    const consumer = run('consumer', rootB)
    const projection = projectNotebookFileDependencies([
      {
        run: producer,
        facts,
        fileAccess: {
          ...access([], [output]),
          writeScopes: undefined
        }
      },
      {
        run: scopedWriter,
        facts,
        fileAccess: {
          ...access([], []),
          writeState: 'partial',
          externalState: 'partial',
          writeScopes: [{ kind: 'directory', path: shared }],
          reasonCodes: ['dynamic-path-unresolved']
        }
      },
      { run: consumer, facts, fileAccess: access([output], []) }
    ])
    expect(projection.fileDependenciesByRunId.consumer).toBeUndefined()
    expect(projection.unresolvedFileReadRunIds).toContain('consumer')
  })

  it('registers an observed sibling-directory generation from a changed cwd', () => {
    const root = join(tmpdir(), 'lineage-observed-sibling')
    const cwd = join(root, 'analysis')
    const output = join(root, 'shared', 'measurements.csv')
    const writer = run('writer', cwd, [
      {
        path: output,
        relativePath: 'shared/measurements.csv',
        kind: 'other',
        createdByRunId: 'writer',
        change: 'created',
        generationId: 'measurements-generation',
        checksum: 'a'.repeat(64)
      }
    ])
    const projection = projectNotebookFileDependencies([
      {
        run: writer,
        facts,
        fileAccess: {
          ...access([], []),
          writeScopes: [{ kind: 'directory', path: '../shared' }]
        }
      },
      {
        run: run('consumer', root),
        facts,
        fileAccess: access(['shared/measurements.csv'], [])
      }
    ])
    expect(projection.fileDependenciesByRunId.consumer).toEqual([
      expect.objectContaining({
        producerRunId: 'writer',
        generationId: 'measurements-generation',
        confidence: 'verified'
      })
    ])
    expect(projection.unresolvedFileReadRunIds).not.toContain('consumer')
  })

  it('does not reanchor an unrelated producer path to the scoped writer cwd', () => {
    const root = join(tmpdir(), 'lineage-unrelated-scope')
    const rootA = join(root, 'analysis-a')
    const rootB = join(root, 'analysis-b')
    const output = 'outputs/measurements.csv'
    const producer = run('producer', rootA, [
      {
        path: output,
        relativePath: output,
        kind: 'other',
        createdByRunId: 'producer',
        change: 'created',
        checksum: 'b'.repeat(64)
      }
    ])
    const projection = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], [output]) },
      {
        run: run('unrelated-writer', rootB),
        facts,
        fileAccess: {
          ...access([], []),
          writeScopes: [{ kind: 'directory', path: 'outputs' }]
        }
      },
      { run: run('consumer', rootA), facts, fileAccess: access([output], []) }
    ])
    expect(projection.fileDependenciesByRunId.consumer).toEqual([
      expect.objectContaining({ producerRunId: 'producer', confidence: 'verified' })
    ])
    expect(projection.unresolvedFileReadRunIds).not.toContain('consumer')
  })

  it('withholds a sibling-directory read when the same run writes that scope', () => {
    const root = join(tmpdir(), 'lineage-sibling-read-write')
    const output = join(root, 'shared', 'measurements.csv')
    const producer = run('producer', root, [
      {
        path: output,
        relativePath: 'shared/measurements.csv',
        kind: 'other',
        createdByRunId: 'producer',
        change: 'created',
        checksum: 'c'.repeat(64)
      }
    ])
    const projection = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], [output]) },
      {
        run: run('rewrite', join(root, 'analysis')),
        facts,
        fileAccess: {
          ...access([output], []),
          writeScopes: [{ kind: 'directory', path: '../shared' }]
        }
      }
    ])
    expect(projection.fileDependenciesByRunId.rewrite).toBeUndefined()
    expect(projection.unresolvedFileReadRunIds).toContain('rewrite')
  })

  it.skipIf(process.platform !== 'win32')(
    'matches case variants using Windows filesystem semantics',
    () => {
      const root = join(tmpdir(), 'lineage-path-case')
      const producer = run('producer', root, [
        {
          path: join(root, 'Outputs/result.json'),
          relativePath: 'Outputs/result.json',
          kind: 'other',
          createdByRunId: 'producer',
          change: 'created',
          checksum: 'd'.repeat(64)
        }
      ])
      const consumer = run('consumer', root)
      const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
        { run: producer, facts, fileAccess: access([], ['Outputs/result.json']) },
        { run: consumer, facts, fileAccess: access(['outputs/RESULT.JSON'], []) }
      ] satisfies readonly AnalyzedNotebookRun[])
      expect(projection.consumer).toEqual([
        expect.objectContaining({ producerRunId: 'producer', confidence: 'verified' })
      ])
    }
  )

  it('withholds a read-after-write edge when statement order is unavailable', () => {
    const root = join(tmpdir(), 'lineage-read-after-write')
    const output = join(root, 'result.json')
    const producer = run('producer', root, [
      {
        path: output,
        relativePath: 'result.json',
        kind: 'other',
        createdByRunId: 'producer',
        change: 'created',
        checksum: 'e'.repeat(64)
      }
    ])
    const rewrite = run('rewrite', root, [
      {
        path: output,
        relativePath: 'result.json',
        kind: 'other',
        createdByRunId: 'rewrite',
        change: 'modified',
        checksum: 'f'.repeat(64)
      }
    ])
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['result.json']) },
      { run: rewrite, facts, fileAccess: access(['result.json'], ['result.json']) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.rewrite).toBeUndefined()
  })

  it('withholds an older producer when a complete write has no observed generation', () => {
    const root = join(tmpdir(), 'lineage-missing-generation')
    const output = join(root, 'result.json')
    const producer = run('producer', root, [
      {
        path: output,
        relativePath: 'result.json',
        kind: 'other',
        createdByRunId: 'producer',
        change: 'created',
        checksum: 'c'.repeat(64)
      }
    ])
    const overwrite = run('overwrite', root)
    const consumer = run('consumer', root)
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['result.json']) },
      { run: overwrite, facts, fileAccess: access([], ['result.json']) },
      { run: consumer, facts, fileAccess: access(['result.json'], []) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.consumer).toBeUndefined()
  })

  it('withholds an older producer after an incomplete observed overwrite', () => {
    const root = join(tmpdir(), 'lineage-incomplete-overwrite')
    const output = join(root, 'result.json')
    const producer = run('producer', root, [
      {
        path: output,
        relativePath: 'result.json',
        kind: 'other',
        createdByRunId: 'producer',
        change: 'created',
        checksum: 'g'.repeat(64)
      }
    ])
    const interrupted: NotebookRunRecord = {
      ...run('interrupted', root, [
        {
          path: output,
          relativePath: 'result.json',
          kind: 'other',
          createdByRunId: 'interrupted',
          change: 'modified',
          checksum: 'h'.repeat(64)
        }
      ]),
      status: 'failed'
    }
    const { fileDependenciesByRunId: projection } = projectNotebookFileDependencies([
      { run: producer, facts, fileAccess: access([], ['result.json']) },
      {
        run: interrupted,
        facts,
        fileAccess: {
          ...access([], ['result.json']),
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial',
          reasonCodes: ['dynamic-path-unresolved']
        }
      },
      { run: run('consumer', root), facts, fileAccess: access(['result.json'], []) }
    ] satisfies readonly AnalyzedNotebookRun[])
    expect(projection.consumer).toBeUndefined()
  })
})
