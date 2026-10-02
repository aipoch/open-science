import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
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
