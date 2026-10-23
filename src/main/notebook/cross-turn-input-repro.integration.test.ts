import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'
import { reproductionRecipes, reproductionWorkflowSlices } from '../artifacts/reproducibility-host'
import { captureArtifactWorkflow } from '../artifacts/provenance-execution-evidence'

import { createRootNotebookLane } from './lane-identity'
import { analyzePythonFileAccesses } from '@aipoch/notebook-analysis'
import { notebookPromptInputPath } from './prompt-input-materialization'
import { getNotebookFileEvidenceLocation, NotebookRunRepository } from './repository'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import { analyzeNotebookSourceFileAccess } from '@aipoch/notebook-analysis'
import { startWorkingFileObservation } from './working-file-observer'
import { reportedPythonPlots } from './reported-python-plots.fixture'

import { reportedSubplots, reportedSubplotsInput } from './reported-python-subplots.fixture'
import { rBasePlots } from './reported-r-base-plots.fixture'
import { frameRRequest, parseLoopResponse, type KernelLoopResponse } from './kernel-protocol'
import {
  parseNotebookEnvironmentLock,
  EnvironmentStateTracker,
  createExecutableVerifier,
  deriveCondaRuntimeSubsetPlan,
  verifyRestoredEnvironment
} from '@aipoch/environment'
import {
  validWorkflowCapture,
  validRStageCheckpointForRun,
  type ArtifactReproducibilityExecutionEvent,
  type WorkflowCapture,
  type WorkflowPlan
} from '@aipoch/reproducibility'
import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import { NotebookKernelExecutor } from './kernel-executor'
import type { NotebookProcessSandbox } from './process-sandbox'
import { runMicromamba } from './environment-process'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { prepareRStageCheckpoint } from './r-stage-checkpoint'
import { resolveLoopScriptPaths } from './runtime-service'
import {
  createNotebookReproductionRuntime,
  executeArtifactReproducibility,
  executeWorkflowReproducibility
} from './reproduction-runtime'

const python = process.env.OPEN_SCIENCE_TEST_PYTHON
const hash = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex')

// A fresh prefix is restored by the real installer/kernel/verifier. An existing archive cache
// can be supplied without claiming a cold-cache or OS sandbox certification.
it.skipIf(
  !process.env.RUN_KERNEL ||
    process.env.OPEN_SCIENCE_TEST_MINIMAL_R_RESTORE !== '1' ||
    !process.env.OPEN_SCIENCE_TEST_R_ENV ||
    !process.env.OPEN_SCIENCE_TEST_MICROMAMBA
)(
  'restores the original R environment and captured DE result CSV without checkpoint package proof',
  async ({ signal }) => {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'minimal-r-volcano-')))
    const sourcePrefix = process.env.OPEN_SCIENCE_TEST_R_ENV!
    const command = join(sourcePrefix, 'bin/Rscript')
    const micromamba = process.env.OPEN_SCIENCE_TEST_MICROMAMBA!
    const cache = process.env.OPEN_SCIENCE_TEST_CONDA_CACHE
    const execute = promisify(execFile)
    const session = {
      projectId: 'volcano-project',
      sessionId: 'volcano-session',
      lane: createRootNotebookLane('volcano-project', 'volcano-session', 'root')
    }
    // These known synthetic scripts exercise restoration, not OS sandbox enforcement.
    const sandbox: NotebookProcessSandbox = {
      createTemporaryScope: () => ({
        wrap: sandbox.wrap,
        dispose: async () => undefined
      }),
      wrap: async ({ executable, args, env }) => ({
        executable,
        args,
        env,
        annotateStderr: (stderr) => stderr,
        cleanup: async (_reason, outcome) => ({
          processesTerminated: outcome.processesTerminated,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
      })
    }
    const original = new NotebookKernelExecutor({
      rLoopPath: join(process.cwd(), 'resources/notebook/r_loop.R'),
      processSandbox: sandbox
    })
    const events: ArtifactReproducibilityExecutionEvent[] = []
    let attemptRoot: string | undefined
    let restoredPrefix: string | undefined
    try {
      // Fixture setup really runs DESeq2. Its upstream objects/packages do not enter the plot
      // kernel: the only registered input to this independent capture is the complete result CSV.
      await execute(
        command,
        [
          '--vanilla',
          '-e',
          `
set.seed(20261019)
mu <- exp(runif(1000, log(25), log(1500)))
dispersion <- 0.08 + 3 / mu
counts <- sapply(seq_len(8), function(sample) {
  effect <- if (sample > 4) c(rep(4, 100), rep(0.25, 100), rep(1, 800)) else rep(1, 1000)
  rnbinom(1000, mu = mu * effect, size = 1 / dispersion)
})
counts <- rbind(counts, rep(0L, 8))
rownames(counts) <- paste0("gene", seq_len(1001))
colnames(counts) <- paste0("sample", seq_len(8))
metadata <- data.frame(condition = factor(rep(c("control", "treated"), each = 4),
  levels = c("control", "treated")), row.names = colnames(counts))
stopifnot(identical(colnames(counts), rownames(metadata)))
dds <- DESeq2::DESeqDataSetFromMatrix(counts, metadata, design = ~ condition)
dds <- DESeq2::DESeq(dds, fitType = "mean", betaPrior = FALSE, parallel = FALSE, quiet = TRUE)
res <- as.data.frame(DESeq2::results(dds, contrast = c("condition", "treated", "control"),
  alpha = 0.05, independentFiltering = FALSE, cooksCutoff = FALSE))
stopifnot(nrow(res) == 1001, is.na(res["gene1001", "pvalue"]))
write.csv(res, "de-results.csv", row.names = TRUE, na = "NA")
`
        ],
        { cwd: storageRoot, timeout: 60_000, signal }
      )
      const bytes = await readFile(join(storageRoot, 'de-results.csv'))
      const input: NotebookRunInputFile = {
        sourceKind: 'upload-version',
        sourceFileId: 'de-results',
        inputFileVersionId: 'de-results-v1',
        sourceProjectId: session.projectId,
        sourceSessionId: session.sessionId,
        filename: 'de-results.csv',
        checksum: hash(bytes),
        sizeBytes: bytes.length,
        storageKey: 'uploads/de-results.csv',
        association: 'turn-attached'
      }
      const document = await new NotebookRunRepository(storageRoot).loadOrCreate({
        ...session,
        workspaceCwd: storageRoot
      })
      const inputPath = notebookPromptInputPath(input.filename, input.checksum)
      for (const destination of [
        join(document.dataRoot, inputPath),
        join(storageRoot, input.storageKey)
      ]) {
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, bytes)
      }
      const script = `plotData <- utils::read.csv("${inputPath}", row.names = 1, stringsAsFactors = FALSE)
grDevices::png("volcano.png", width = 640, height = 480)
graphics::plot.default(plotData$log2FoldChange,
  -base::log10(base::pmax(plotData$pvalue, 1e-300)), pch = 16,
  xlab = "log2 fold change: treated / control", ylab = "-log10 p-value", main = "Synthetic DESeq2")
graphics::abline(v = base::c(-1, 1), h = -base::log10(0.05), lty = 2)
grDevices::dev.off()`
      const target = {
        language: 'r' as const,
        environmentName: 'analysis-r-source',
        runtimeSource: 'managed' as const,
        command,
        condaPrefix: sourcePrefix,
        args: ['--vanilla']
      }
      // The tracker probes the real interpreter and combines its inventory with the actual
      // first-request overlay. No installed-package summary or clean-session claim is fabricated.
      const tracker = new EnvironmentStateTracker({
        dataRoot: storageRoot,
        resolveMicromamba: async () => micromamba
      })
      const prepared = await tracker.prepareRun(target)
      const running: NotebookRunRecord = {
        runId: 'plot-only',
        cellId: 'plot-only-cell',
        kernelKind: 'r',
        kernelEpochId: 'fresh-plot',
        kernelDispatched: true,
        environment: target.environmentName,
        source: 'agent',
        script,
        status: 'running',
        startedAt: Date.now(),
        cwdBefore: document.dataRoot,
        messageBranchId: 'branch',
        promptMessageId: 'plot-prompt',
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: [],
        inputFiles: [input]
      }
      const location = getNotebookFileEvidenceLocation(
        storageRoot,
        session.projectId,
        session.sessionId,
        session.lane
      )
      const { run } = await new NotebookRunTerminalizationOwner({
        repository: new NotebookRunRepository(storageRoot),
        notifyChanged: () => undefined
      }).run({
        session,
        runningRun: running,
        invoke: async () => {
          const result = await original.execute({
            code: script,
            runId: running.runId,
            kernelEpochId: running.kernelEpochId,
            language: 'r',
            environment: target.environmentName,
            resolvedInterpreter: { command, condaPrefix: sourcePrefix, args: ['--vanilla'] },
            cwd: document.dataRoot,
            dataRoot: document.dataRoot,
            notebookSessionRoot: document.notebookSessionRoot,
            runtimeRoot: join(storageRoot, 'runtime'),
            fileEvidenceStorageRoot: storageRoot,
            fileEvidenceRoot: location.root,
            fileEvidenceStoragePrefix: location.storageKeyPrefix,
            registeredInputFiles: [input],
            projectId: session.projectId,
            sessionId: session.sessionId,
            signal
          })
          expect(result.status, JSON.stringify(result)).toBe('completed')
          expect(result.environmentOverlay?.executionContext?.rPackages).toMatchObject({
            complete: true,
            cleanSession: true
          })
          const captured = await tracker.captureCompletedRun(
            target,
            result.environmentOverlay,
            prepared
          )
          return {
            ...result,
            environmentCapture: {
              state: captured.manifest.captureStatus === 'complete' ? 'available' : 'partial',
              manifestChecksum: captured.checksum
            },
            environmentManifest: captured.manifest,
            environmentManifestChecksum: captured.checksum,
            environmentLock: captured.environmentLock
          }
        }
      })
      expect(run.fileEvidence, JSON.stringify(run.fileEvidence)).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete',
        reasonCodes: []
      })
      expect(run.inputFiles).toEqual([
        expect.objectContaining({
          inputFileVersionId: input.inputFileVersionId,
          accessEvidence: 'file-evidence'
        })
      ])
      expect(run.environmentManifest?.captureStatus).toBe('complete')
      expect(run.environmentLock, JSON.stringify(run.environmentLock)).toMatchObject({
        state: 'available'
      })
      if (run.environmentLock?.state !== 'available')
        throw new Error('Expected source environment lock')
      const sourceChecksum = run.environmentLock.lockChecksum
      const sourceSerialized = await readFile(
        join(storageRoot, 'runtime/provenance/environment-locks', sourceChecksum + '.json'),
        'utf8'
      )
      expect(hash(sourceSerialized)).toBe(sourceChecksum)
      const sourceLock = parseNotebookEnvironmentLock(sourceSerialized)
      const sourceConda = sourceLock.components.find(
        (component) => component.ecosystem === 'conda'
      )!
      expect(sourceConda.dependencyGraph?.packages.length).toBe(sourceConda.packages.length)
      expect(sourceConda.packages).toContain('bioconductor-deseq2')
      const dependencies = await createNotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => [run] }
      }).project({ projectId: session.projectId, sessionId: session.sessionId, completedRun: run })
      const output = run.workingFiles.find((file) => file.relativePath === 'data/volcano.png')!
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'version-volcano',
          filename: 'volcano.png',
          checksum: output.checksum!,
          sizeBytes: output.size!,
          producerRunId: run.runId,
          sourceGenerationId: output.generationId
        },
        notebookActivities: [
          {
            run,
            runIndex: 0,
            evidenceJson: await readFile(join(storageRoot, run.fileEvidence!.storageKey!), 'utf8')
          }
        ],
        computeActivities: [],
        notebookDependencies: dependencies
      })
      expect(graph.completeness, JSON.stringify(graph)).toBe('complete')
      const sourceRun: PersistedArtifactExecutionSnapshot['runs'][number] = {
        runId: run.runId,
        runIndex: 0,
        agentFrameId: 'root',
        messageBranchId: 'branch',
        runtimeSegmentId: 'r-source',
        promptMessageId: 'plot-prompt',
        kernelEpochId: 'fresh-plot',
        kernelKind: 'r',
        environmentName: target.environmentName,
        environmentLock: run.environmentLock,
        executionContext: run.environmentManifest!.executionContext,
        script,
        status: 'completed',
        startedAt: new Date(run.startedAt!).toISOString(),
        completedAt: new Date(run.endedAt!).toISOString(),
        outputs: [],
        inputFileVersionKeys: [
          { sourceKind: input.sourceKind, inputFileVersionId: input.inputFileVersionId }
        ]
      }
      const recipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: run.inputFiles ?? [],
        runs: [sourceRun]
      })
      const plan = reproductionRecipes.resolveArtifactReproducibilityExecutionPlan(
        recipe,
        'original-inputs'
      )
      expect(
        plan?.steps.map((step) => step.activityId),
        JSON.stringify(recipe)
      ).toEqual(['plot-only'])
      expect(plan?.frontier.crossingFiles.map((file) => file.materializationPath)).toEqual([
        inputPath
      ])
      const execution: PersistedArtifactExecutionSnapshot = {
        schemaVersion: 2,
        rootFrameId: 'root',
        agentFrameId: 'root',
        messageBranchId: 'branch',
        terminalPromptMessageId: 'plot-prompt',
        producerRunId: run.runId,
        producerRunIndex: 0,
        createdAt: new Date().toISOString(),
        inputFiles: run.inputFiles ?? [],
        runs: [sourceRun],
        provenanceGraph: graph,
        reproducibilityRecipe: recipe
      }
      expect(await original.shutdown()).toEqual({ reaped: true })
      await rm(join(document.dataRoot, 'inputs'), { recursive: true })
      await rm(join(storageRoot, 'de-results.csv'))
      const result = await executeArtifactReproducibility(
        {
          execution,
          frontierId: 'original-inputs',
          storageRoot,
          processSandbox: sandbox,
          signal,
          onEvent: (event) => events.push(event)
        },
        {
          createRuntime: async (runtimeInput) => {
            attemptRoot = runtimeInput.attemptRoot
            const files = await readdir(join(attemptRoot, 'workspace', 'data'), { recursive: true })
            expect(files.sort()).toEqual(['inputs', inputPath].sort())
            return createNotebookReproductionRuntime(runtimeInput, {
              micromamba,
              runMicromamba: async (argv, env, ...rest) => {
                expect(argv).toContain('--offline')
                restoredPrefix = argv[argv.indexOf('-p') + 1]!
                expect(restoredPrefix).toContain(sourceChecksum)
                await expect(access(restoredPrefix)).rejects.toMatchObject({ code: 'ENOENT' })
                return runMicromamba(
                  argv,
                  { ...env, ...(cache ? { CONDA_PKGS_DIRS: cache } : {}) },
                  ...rest
                )
              }
            })
          }
        }
      )
      expect(result).toMatchObject({
        matched: true,
        completedStepIds: ['step:plot-only'],
        comparisons: [
          expect.objectContaining({
            relativePath: 'data/volcano.png',
            status: 'matched',
            actualChecksum: output.checksum
          })
        ]
      })
      expect(events).toContainEqual({ type: 'inputs-materialized', count: 1 })
      expect(result.environmentLocks).toEqual([
        expect.objectContaining({ lockChecksum: sourceChecksum })
      ])
      const restored = result.environmentLocks![0]!
      expect(restored).not.toHaveProperty('sourceLockChecksum')
      const restoredBytes = await readFile(
        join(storageRoot, 'runtime/provenance/environment-locks', restored.lockChecksum + '.json'),
        'utf8'
      )
      expect(hash(restoredBytes)).toBe(sourceChecksum)
      expect(restoredBytes).toBe(sourceSerialized)
      const restoredLock = JSON.parse(restoredBytes) as typeof sourceLock
      const restoredConda = restoredLock.components.find(
        (component) => component.ecosystem === 'conda'
      )!
      expect(restoredConda).toEqual(sourceConda)
      expect(
        await readFile(
          join(storageRoot, 'runtime/provenance/environment-locks', sourceChecksum + '.json'),
          'utf8'
        )
      ).toBe(sourceSerialized)
      expect(restoredPrefix).toContain(restored.lockChecksum)
      await expect(access(attemptRoot!)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await original.shutdown()
      await rm(storageRoot, { recursive: true, force: true })
    }
  },
  300_000
)

// Capture seven original cells once. Independent slices restore their actual pre-cell state;
// legacy slices below remove that evidence and must still replay their real memory ancestors.
// This certifies host capture/planning/restoration, not Electron or OS sandbox enforcement.
it.skipIf(
  !process.env.RUN_KERNEL ||
    process.env.OPEN_SCIENCE_TEST_WORKFLOW_R_RESTORE !== '1' ||
    process.env.OPEN_SCIENCE_TEST_DESEQ2 !== '1' ||
    !process.env.OPEN_SCIENCE_TEST_R_ENV ||
    !process.env.OPEN_SCIENCE_TEST_MICROMAMBA
)(
  'replays seven original DESeq2 stages independently and continuously with minimal restored environments',
  async ({ signal }) => {
    const evidenceRoot = process.env.OPEN_SCIENCE_TEST_WORKFLOW_EVIDENCE_ROOT
    if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true })
    // Retain this exact capture and its immutable blobs when evidence retention is requested.
    // A failing replay must leave the original input/source/lock proof available for diagnosis.
    const storageRoot = await realpath(
      await mkdtemp(join(evidenceRoot ?? tmpdir(), 'deseq2-workflow-'))
    )
    const sourcePrefix = process.env.OPEN_SCIENCE_TEST_R_ENV!
    const command = join(sourcePrefix, 'bin/Rscript')
    const micromamba = process.env.OPEN_SCIENCE_TEST_MICROMAMBA!
    const cache = process.env.OPEN_SCIENCE_TEST_CONDA_CACHE
    const session = {
      projectId: 'workflow-project',
      sessionId: 'workflow-session',
      lane: createRootNotebookLane('workflow-project', 'workflow-session', 'root')
    }
    const sandbox: NotebookProcessSandbox = {
      createTemporaryScope: () => ({
        wrap: sandbox.wrap,
        dispose: async () => undefined
      }),
      wrap: async ({ executable, args, env }) => ({
        executable,
        args,
        env,
        annotateStderr: (stderr) => stderr,
        cleanup: async (_reason, outcome) => ({
          processesTerminated: outcome.processesTerminated,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
      })
    }
    const original = new NotebookKernelExecutor({
      rLoopPath: join(process.cwd(), 'resources/notebook/r_loop.R'),
      processSandbox: sandbox
    })
    const repository = new NotebookRunRepository(storageRoot)
    const diagnostics: unknown[] = []
    const reportPath =
      process.env.OPEN_SCIENCE_TEST_WORKFLOW_REPORT ?? join(storageRoot, 'report.json')
    let report: Record<string, unknown> = {
      complete: false,
      storageRoot,
      fixture: 'deterministic-integer-counts-v1',
      diagnostics
    }
    const writeReport = async (): Promise<void> => {
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, JSON.stringify(report, null, 2))
    }
    try {
      const document = await repository.loadOrCreate({ ...session, workspaceCwd: storageRoot })
      // New frozen synthetic inputs, not the lost historical random fixture. Arithmetic alone
      // defines these integer bytes, independently of R's RNG or package implementation.
      const samples = Array.from({ length: 8 }, (_, index) => 'sample' + (index + 1))
      const countRows = Array.from({ length: 1000 }, (_, index) => {
        const gene = index + 1
        const mean = 25 + ((gene * 97) % 1476)
        const values = samples.map((_, sample) => {
          const effect = sample < 4 ? 1 : gene <= 100 ? 4 : gene <= 200 ? 0.25 : 1
          const variation = 0.6 + ((gene * 193 + sample * 379 + gene * sample * 53) % 801) / 1000
          return Math.round(mean * effect * variation)
        })
        return ['gene' + gene, ...values].join(',')
      })
      const fixture = {
        'counts.csv':
          [
            'gene,' + samples.join(','),
            ...countRows,
            'gene1001,' + Array(8).fill(0).join(',')
          ].join('\n') + '\n',
        'metadata.csv':
          [
            'sample,condition',
            ...samples.map((sample, index) => sample + ',' + (index < 4 ? 'control' : 'treated'))
          ].join('\n') + '\n'
      }
      const inputs: NotebookRunInputFile[] = []
      for (const [filename, content] of Object.entries(fixture)) {
        const bytes = Buffer.from(content)
        const input: NotebookRunInputFile = {
          sourceKind: 'upload-version',
          sourceFileId: filename,
          inputFileVersionId: filename + '-v1',
          sourceProjectId: session.projectId,
          sourceSessionId: session.sessionId,
          filename,
          checksum: hash(bytes),
          sizeBytes: bytes.length,
          storageKey: 'uploads/' + filename,
          association: 'turn-attached'
        }
        for (const destination of [
          join(storageRoot, input.storageKey),
          join(document.dataRoot, notebookPromptInputPath(filename, input.checksum))
        ]) {
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, bytes)
        }
        inputs.push(input)
      }
      const stages = [
        {
          id: 'read',
          script: `countData <- base::as.matrix(utils::read.csv("${notebookPromptInputPath(inputs[0]!.filename, inputs[0]!.checksum)}", row.names = 1, check.names = FALSE, stringsAsFactors = FALSE))
sampleInfo <- utils::read.csv("${notebookPromptInputPath(inputs[1]!.filename, inputs[1]!.checksum)}", row.names = 1, stringsAsFactors = FALSE)
stopifnot(identical(colnames(countData), rownames(sampleInfo)))
NULL`
        },
        {
          id: 'clean',
          script: `cleanCounts <- countData[rowSums(countData) > 0, , drop = FALSE]
cleanMetadata <- sampleInfo
cleanMetadata$condition <- factor(cleanMetadata$condition, levels = c("control", "treated"))
stopifnot(identical(colnames(cleanCounts), rownames(cleanMetadata)))
utils::write.csv(cleanCounts, "clean-counts.csv", row.names = TRUE, na = "NA")
utils::write.csv(cleanMetadata, "clean-metadata.csv", row.names = TRUE, na = "NA")`
        },
        {
          id: 'model',
          script: `library(DESeq2)
counts <- as.matrix(utils::read.csv("clean-counts.csv", row.names = 1, check.names = FALSE, stringsAsFactors = FALSE))
metadata <- utils::read.csv("clean-metadata.csv", row.names = 1, stringsAsFactors = FALSE)
metadata$condition <- factor(metadata$condition, levels = c("control", "treated"))
stopifnot(identical(colnames(counts), rownames(metadata)))
dds <- DESeq2::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition)
NULL`
        },
        {
          id: 'fit',
          script: `dds <- DESeq2::DESeq(dds, fitType = "mean", betaPrior = FALSE, parallel = FALSE, quiet = TRUE)
NULL`
        },
        {
          id: 'results',
          script: `resultTable <- as.data.frame(DESeq2::results(dds, contrast = c("condition", "treated", "control"), alpha = 0.05, independentFiltering = FALSE, cooksCutoff = FALSE))
utils::write.csv(resultTable, "de-results.csv", row.names = TRUE, na = "NA")`
        },
        {
          id: 'volcano',
          script: `plotData <- utils::read.csv("de-results.csv", row.names = 1, stringsAsFactors = FALSE)
grDevices::png("volcano.png", width = 640, height = 480)
graphics::plot.default(plotData$log2FoldChange, -base::log10(base::pmax(plotData$pvalue, 1e-300)), pch = 16, xlab = "log2 fold change", ylab = "-log10 p-value", main = "Original workflow")
graphics::abline(v = base::c(-1, 1), h = -base::log10(0.05), lty = 2)
grDevices::dev.off()`
        },
        {
          id: 'heatmap',
          script: `heatmapData <- as.matrix(utils::read.csv("clean-counts.csv", row.names = 1, check.names = FALSE, stringsAsFactors = FALSE))
grDevices::png("heatmap.png", width = 640, height = 480)
stats::heatmap(log2(heatmapData + 1), scale = "row", Colv = NA)
grDevices::dev.off()`
        }
      ]
      report = {
        ...report,
        inputs,
        sources: stages.map((stage) => ({ ...stage, sourceChecksum: hash(stage.script) })),
        productionRLoopChecksum: hash(
          await readFile(join(process.cwd(), 'resources/notebook/r_loop.R'))
        )
      }
      await writeReport()
      const target = {
        language: 'r' as const,
        environmentName: 'workflow-r-source',
        runtimeSource: 'managed' as const,
        command,
        condaPrefix: sourcePrefix,
        args: ['--vanilla']
      }
      const tracker = new EnvironmentStateTracker({
        dataRoot: storageRoot,
        resolveMicromamba: async () => micromamba
      })
      const terminalizer = new NotebookRunTerminalizationOwner({
        repository,
        notifyChanged: () => undefined
      })
      const location = getNotebookFileEvidenceLocation(
        storageRoot,
        session.projectId,
        session.sessionId,
        session.lane
      )
      const runs: NotebookRunRecord[] = []
      const analyzer = createNotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => runs },
        resolveInterpreter: async () => ({ command })
      })
      for (const stage of stages) {
        const prepared = await tracker.prepareRun(target)
        const running: NotebookRunRecord = {
          runId: stage.id,
          cellId: stage.id + '-cell',
          source: 'agent',
          agentFrameId: 'root',
          messageBranchId: 'branch',
          runtimeSegmentId: 'workflow-runtime',
          promptMessageId: 'workflow-prompt',
          kernelKind: 'r',
          kernelEpochId: 'original-workflow-epoch',
          kernelDispatched: true,
          environment: target.environmentName,
          script: stage.script,
          status: 'running',
          startedAt: Date.now(),
          cwdBefore: document.dataRoot,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [],
          inputFiles: stage.id === 'read' ? inputs : []
        }
        const { run } = await terminalizer.run({
          session,
          runningRun: running,
          invoke: async () => {
            const sourceFileAccessContext = await analyzer.sourceFileAccessContext({
              projectId: session.projectId,
              sessionId: session.sessionId,
              currentRunId: stage.id,
              language: 'r',
              environment: target.environmentName,
              kernelEpochId: running.kernelEpochId!
            })
            const sourceAccess = await analyzeNotebookSourceFileAccess(
              'r',
              stage.script,
              sourceFileAccessContext
            )
            diagnostics.push({
              phase: 'source-analysis',
              stage: stage.id,
              sourceFileAccessContext,
              sourceAccess
            })
            await writeReport()
            expect(sourceAccess, `${stage.id}: ${JSON.stringify(sourceAccess)}`).toMatchObject({
              readState: 'complete',
              writeState: 'complete',
              externalState: 'complete',
              reasonCodes: []
            })
            // Match execution-owner's real order: prepare state paths, execute, capture the
            // actual environment overlay/lock, seal the state to that lock, terminalize the Run.
            const checkpoint = await prepareRStageCheckpoint(
              document.notebookSessionRoot,
              storageRoot
            )
            try {
              const result = await original.execute({
                code: stage.script,
                runId: stage.id,
                kernelEpochId: running.kernelEpochId,
                language: 'r',
                environment: target.environmentName,
                resolvedInterpreter: { command, condaPrefix: sourcePrefix, args: ['--vanilla'] },
                stageCheckpoint: checkpoint.paths,
                cwd: document.dataRoot,
                dataRoot: document.dataRoot,
                notebookSessionRoot: document.notebookSessionRoot,
                runtimeRoot: join(storageRoot, 'runtime'),
                fileEvidenceStorageRoot: storageRoot,
                fileEvidenceRoot: location.root,
                fileEvidenceStoragePrefix: location.storageKeyPrefix,
                registeredInputFiles: running.inputFiles,
                sourceFileAccessContext,
                projectId: session.projectId,
                sessionId: session.sessionId,
                signal
              })
              diagnostics.push({ phase: 'capture', stage: stage.id, result })
              await writeReport()
              expect(result.status, `${stage.id}: ${JSON.stringify(result)}`).toBe('completed')
              expect(
                result.stageCheckpointCapture,
                `${stage.id}: ${JSON.stringify(result.stageCheckpointCapture)}`
              ).toMatchObject({ state: 'available' })
              const captured = await tracker.captureCompletedRun(
                target,
                result.environmentOverlay,
                prepared
              )
              const capturedResult = {
                ...result,
                environmentCapture: {
                  state:
                    captured.manifest.captureStatus === 'complete'
                      ? ('available' as const)
                      : ('partial' as const),
                  manifestChecksum: captured.checksum
                },
                environmentManifest: captured.manifest,
                environmentManifestChecksum: captured.checksum,
                environmentLock: captured.environmentLock
              }
              return {
                ...capturedResult,
                stageCheckpoint: await checkpoint.seal(running, capturedResult)
              }
            } finally {
              await checkpoint.dispose()
            }
          }
        })
        expect(run.fileEvidence, `${stage.id}: ${JSON.stringify(run.fileEvidence)}`).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(
          run.environmentLock,
          `${stage.id}: ${JSON.stringify(run.environmentLock)}`
        ).toMatchObject({ state: 'available' })
        expect(
          run.stageCheckpoint,
          `${stage.id}: ${JSON.stringify(run.stageCheckpoint)}`
        ).toMatchObject({
          state: 'available',
          runId: stage.id,
          sourceChecksum: hash(stage.script),
          kernelEpochId: running.kernelEpochId,
          environmentProof: { schemaVersion: 1, packages: expect.any(Array) }
        })
        expect(run.environmentManifest?.executionContext?.rPackages?.cleanSession).toBe(
          stage.id === 'read'
        )
        runs.push(run)
        report.runs = runs
        await writeReport()
      }
      const dependencies = await analyzer.project({
        projectId: session.projectId,
        sessionId: session.sessionId,
        throughRunId: 'heatmap'
      })
      expect(dependencies.dependenciesByRunId?.fit, JSON.stringify(dependencies)).toContain('model')
      expect(dependencies.dependenciesByRunId?.results, JSON.stringify(dependencies)).toContain(
        'fit'
      )
      const heatmap = runs
        .at(-1)!
        .workingFiles.find((file) => file.relativePath === 'data/heatmap.png')!
      const graphInput = {
        target: {
          versionId: 'workflow-version',
          filename: 'heatmap.png',
          checksum: heatmap.checksum!,
          sizeBytes: heatmap.size!,
          producerRunId: 'heatmap',
          sourceGenerationId: heatmap.generationId
        },
        notebookActivities: await Promise.all(
          runs.map(async (run, runIndex) => ({
            run,
            runIndex,
            evidenceJson: await readFile(join(storageRoot, run.fileEvidence!.storageKey!), 'utf8')
          }))
        ),
        computeActivities: [],
        notebookDependencies: dependencies
      }
      const artifactGraph = sealArtifactProvenanceGraph(graphInput)
      const captured = captureArtifactWorkflow(
        graphInput,
        runs.map((run, runIndex) => ({ run, runIndex }))
      )
      report = { ...report, dependencies, captured }
      await writeReport()
      if (captured.state !== 'available') throw new Error('Expected original workflow capture')
      const capture = captured.capture
      const stageGeneration = (
        activityId: string,
        kind: 'used' | 'generated',
        path: string
      ): string => {
        const matches = capture.graph.edges.flatMap((edge) => {
          if (
            edge.kind !== kind ||
            edge.activityId !== activityId ||
            (kind === 'used' && edge.authority !== 'authoritative')
          )
            return []
          const entity = capture.graph.entities.find((item) => item.entityId === edge.entityId)
          return entity?.kind === 'file-generation' && entity.relativePath === 'data/' + path
            ? [entity.entityId]
            : []
        })
        if (matches.length !== 1)
          throw new Error(`${activityId} ${kind} ${path}: ${JSON.stringify(capture.graph.edges)}`)
        return matches[0]!
      }
      const cleanBoundaries = [
        stageGeneration('model', 'used', 'clean-counts.csv'),
        stageGeneration('model', 'used', 'clean-metadata.csv')
      ]
      const volcanoBoundary = stageGeneration('volcano', 'used', 'de-results.csv')
      const legacyRuns = runs.map(({ stageCheckpoint: _checkpoint, ...run }) => {
        void _checkpoint
        return run
      })
      // Dependency projection consumes source facts, file evidence and observed package context,
      // not stageCheckpoint. Removing only the checkpoint leaves those dependencies unchanged.
      // Rebuild the graph itself: its completeness may have relied on that state boundary.
      const legacyCaptured = captureArtifactWorkflow(
        {
          ...graphInput,
          notebookActivities: graphInput.notebookActivities.map((activity, index) => ({
            ...activity,
            run: legacyRuns[index]!
          }))
        },
        legacyRuns.map((run, runIndex) => ({ run, runIndex }))
      )
      report = { ...report, capture, legacyCaptured }
      await writeReport()
      if (legacyCaptured.state !== 'available') throw new Error('Expected legacy workflow capture')
      const legacy = legacyCaptured.capture
      // Static planner ablation, not a real R execution: the same source, files, package
      // evidence and graph cannot certify a single fit stage without its state boundary.
      const noState = reproductionWorkflowSlices.planWorkflowSlice(legacy, {
        independent: true,
        captureId: legacy.captureId,
        targetRunIds: ['fit'],
        boundaryEntityIds: cleanBoundaries
      })
      const misleadingCsv = reproductionWorkflowSlices.planWorkflowSlice(legacy, {
        captureId: legacy.captureId,
        targetRunIds: ['fit'],
        boundaryEntityIds: [stageGeneration('results', 'generated', 'de-results.csv')]
      })
      const cases = [
        ...stages.map(({ id }) => ({
          id: 'independent-' + id,
          capture,
          targets: [id],
          boundaries: [] as string[],
          steps: [id],
          independent: true
        })),
        {
          id: 'continuous-model-results',
          capture,
          targets: ['model', 'fit', 'results'],
          boundaries: [],
          steps: ['model', 'fit', 'results'],
          independent: true
        },
        {
          id: 'continuous-results-plots',
          capture,
          targets: ['results', 'volcano', 'heatmap'],
          boundaries: [],
          steps: ['results', 'volcano', 'heatmap'],
          independent: true
        },
        {
          id: 'continuous-clean-results',
          capture,
          targets: ['clean', 'model', 'fit', 'results'],
          boundaries: [],
          steps: ['clean', 'model', 'fit', 'results'],
          independent: true
        },
        {
          id: 'whole-lineage',
          capture,
          targets: stages.map((stage) => stage.id),
          boundaries: [],
          steps: stages.map((stage) => stage.id),
          independent: true
        },
        {
          id: 'legacy-clean',
          capture: legacy,
          targets: ['clean'],
          boundaries: [],
          steps: ['read', 'clean'],
          independent: false
        },
        {
          id: 'legacy-fit-memory',
          capture: legacy,
          targets: ['fit'],
          boundaries: cleanBoundaries,
          // The model cell has an unisolated kernel-context dependency on clean; clean
          // consumes read's objects. File boundaries do not replace either memory context.
          steps: ['read', 'clean', 'model', 'fit'],
          independent: false
        },
        {
          id: 'legacy-results-memory',
          capture: legacy,
          targets: ['results'],
          boundaries: cleanBoundaries,
          steps: ['read', 'clean', 'model', 'fit', 'results'],
          independent: false
        },
        {
          id: 'legacy-volcano',
          capture: legacy,
          targets: ['volcano'],
          boundaries: [volcanoBoundary],
          steps: ['volcano'],
          independent: false
        }
      ]
      // The historical heatmap has no certified execution dependency projection. Live
      // freshness's model dependency is insufficient to assert a restorable kernel closure.
      const legacyHeatmap = reproductionWorkflowSlices.planWorkflowSlice(legacy, {
        captureId: legacy.captureId,
        targetRunIds: ['heatmap'],
        boundaryEntityIds: [stageGeneration('heatmap', 'used', 'clean-counts.csv')]
      })
      const plans = cases.map((scenario) =>
        reproductionWorkflowSlices.planWorkflowSlice(scenario.capture, {
          ...(scenario.independent ? { independent: true as const } : {}),
          captureId: scenario.capture.captureId,
          targetRunIds: scenario.targets,
          boundaryEntityIds: scenario.boundaries
        })
      )
      report = {
        ...report,
        capture,
        legacyCapture: legacy,
        noState,
        noStateEvidenceKind: 'static-planner-only',
        legacyHeatmap,
        legacyHeatmapEvidenceKind: 'static-planner-only',
        misleadingCsv,
        plans,
        caseMatrix: cases.map(({ id, targets, boundaries, steps, independent }) => ({
          id,
          targets,
          boundaries,
          expectedSteps: steps,
          independent
        })),
        staticDiagnosis: {
          evidenceKind: 'static-planner-only',
          rootSha: report.productionRLoopChecksum,
          sourcePaths: {
            capturedRuns: reportPath,
            dependencyFacts: join(
              storageRoot,
              'notebooks/workflow-project/workflow-session/cache/dependency-analysis.json'
            ),
            dependencyProjection: 'packages/notebook-analysis/src/dependency-projection.ts',
            workflowGraph: 'src/main/artifacts/artifact-provenance-graph.ts',
            workflowPlanner: 'packages/reproducibility/src/workflow-slice.ts'
          },
          legacyProjectionReusedBecause: 'dependency projection does not consume stageCheckpoint'
        },
        totalScenarioCount: cases.length,
        positiveReplayScenarioCount: cases.length,
        fullExactControlCount: 2,
        missingPackageControlCount: 1,
        staticBlockedScenarioCount: 2,
        completedScenarioCount: 0
      }
      await writeReport()
      expect(artifactGraph.activities.some((activity) => activity.activityId === 'volcano')).toBe(
        false
      )
      expect(capture.runs.map((run) => ({ id: run.runId, script: run.script }))).toEqual(stages)
      expect(capture.graph.completeness, JSON.stringify(capture)).toBe('complete')
      expect(capture.activityReasonCodes).toEqual(
        Object.fromEntries(stages.map((stage) => [stage.id, []]))
      )
      expect(stageGeneration('heatmap', 'used', 'clean-counts.csv')).toBe(cleanBoundaries[0])
      expect(noState.status).toBe('blocked')
      expect(noState.reasonCodes).toContain('stage-checkpoint-unavailable')
      expect(noState.steps.map((step) => step.runId)).toEqual(['read', 'clean', 'model', 'fit'])
      expect(legacyHeatmap.status).toBe('blocked')
      expect(legacyHeatmap.reasonCodes).toEqual(['kernel-dependencies-unavailable'])
      expect(misleadingCsv.status).toBe('blocked')
      expect(misleadingCsv.reasonCodes).toContain('unused-boundary-selection')
      for (const [index, scenario] of cases.entries()) {
        const plan = plans[index]!
        expect(plan.status, `${scenario.id}: ${JSON.stringify(plan)}`).toBe('ready')
        expect(
          plan.steps.map((step) => step.runId),
          scenario.id
        ).toEqual(scenario.steps)
        expect(plan.stateComparisonRunIds ?? [], scenario.id).toEqual(
          scenario.independent ? scenario.steps : []
        )
        for (const step of plan.steps)
          expect(step.sourceChecksum).toBe(
            hash(stages.find((stage) => stage.id === step.runId)!.script)
          )
      }
      if (process.env.OPEN_SCIENCE_TEST_WORKFLOW_CAPTURE_ONLY === '1') return
      expect(await original.shutdown()).toEqual({ reaped: true })
      // Freeze exact generated bytes in the evidence store, then remove the source workspace.
      // Only the captured immutable inputs/checkpoints/locks may satisfy later executions.
      if (evidenceRoot)
        await cp(document.dataRoot, join(storageRoot, 'original-workspace'), { recursive: true })
      await rm(document.dataRoot, { recursive: true })
      const executeScenario = async (
        index: number,
        mode: 'selected' | 'full-exact' | 'missing-package' = 'selected'
      ): Promise<Awaited<ReturnType<typeof executeWorkflowReproducibility>>> => {
        const scenario = cases[index]!
        const plan = plans[index]!
        const events: ArtifactReproducibilityExecutionEvent[] = []
        const prefixes: string[] = []
        const executedSources: Array<{ runId: string; sourceChecksum: string }> = []
        let installerCalls = 0
        let omittedRequiredPackage = false
        let retainedCondaRecord:
          { path: string; checksumBefore: string; checksumAfter: string } | undefined
        try {
          const result = await executeWorkflowReproducibility(
            {
              capture: scenario.capture,
              plan,
              storageRoot,
              processSandbox: sandbox,
              signal,
              onEvent: (event) => events.push(event)
            },
            {
              ...(mode !== 'selected' ? { runtimeSubsetConformance: false as const } : {}),
              createRuntime: async (runtimeInput) => {
                const materialized = await readdir(
                  join(runtimeInput.attemptRoot, 'workspace/data'),
                  { recursive: true }
                )
                const files = materialized.filter(
                  (path) =>
                    !plan.crossingFiles.some((file) =>
                      file.materializationPath.startsWith(path + '/')
                    )
                )
                expect(files.sort()).toEqual(
                  plan.crossingFiles
                    .map((file) => file.materializationPath.replace(/^data\//u, ''))
                    .sort()
                )
                const runtime = await createNotebookReproductionRuntime(
                  {
                    ...runtimeInput,
                    ...(mode === 'full-exact'
                      ? {
                          // Remove only package-use proof; state, source and the exact lock
                          // remain unchanged, so the production runtime must use its fallback.
                          selectedRuns: runtimeInput.selectedRuns?.map((run) => {
                            if (run.stageCheckpoint?.state !== 'available') return run
                            const { environmentProof: _proof, ...stageCheckpoint } =
                              run.stageCheckpoint
                            void _proof
                            return { ...run, stageCheckpoint }
                          })
                        }
                      : {})
                  },
                  {
                    micromamba,
                    runMicromamba: async (argv, env, ...rest) => {
                      expect(argv).toContain('--offline')
                      const prefix = argv[argv.indexOf('-p') + 1]!
                      expect(prefix).not.toBe(sourcePrefix)
                      await expect(access(prefix)).rejects.toMatchObject({ code: 'ENOENT' })
                      prefixes.push(prefix)
                      installerCalls += 1
                      const restored = await runMicromamba(
                        argv,
                        { ...env, ...(cache ? { CONDA_PKGS_DIRS: cache } : {}) },
                        ...rest
                      )
                      if (mode === 'missing-package' && !omittedRequiredPackage) {
                        // Remove only the package directory in this disposable prefix. Preserve
                        // the Conda record so metadata-only verification cannot detect the fault.
                        const records = (await readdir(join(prefix, 'conda-meta'))).filter((file) =>
                          file.startsWith('bioconductor-deseq2-')
                        )
                        expect(records).toHaveLength(1)
                        const recordPath = join(prefix, 'conda-meta', records[0]!)
                        const checksumBefore = hash(await readFile(recordPath))
                        const packagePath = join(prefix, 'lib/R/library/DESeq2')
                        await rm(packagePath, { recursive: true })
                        await expect(access(packagePath)).rejects.toMatchObject({ code: 'ENOENT' })
                        await expect(access(recordPath)).resolves.toBeUndefined()
                        const checksumAfter = hash(await readFile(recordPath))
                        expect(checksumAfter).toBe(checksumBefore)
                        retainedCondaRecord = { path: recordPath, checksumBefore, checksumAfter }
                        omittedRequiredPackage = true
                      }
                      return restored
                    }
                  }
                )
                return {
                  ...runtime,
                  execute: async (request) => {
                    const sourceChecksum = hash(request.source)
                    expect(sourceChecksum).toBe(
                      hash(stages.find((stage) => stage.id === request.step.runId)!.script)
                    )
                    executedSources.push({ runId: request.step.runId, sourceChecksum })
                    return runtime.execute(request)
                  }
                }
              }
            }
          )
          if (mode === 'missing-package')
            throw new Error('Missing required DESeq2 package was accepted')
          expect(result, `${scenario.id}/${mode}: ${JSON.stringify(result)}`).toMatchObject({
            captureId: scenario.capture.captureId,
            planId: plan.planId,
            verification: plan.verification,
            ...(plan.verification === 'execution-only' ? {} : { matched: true }),
            completedStepIds: scenario.steps.map((id) => 'step:' + id)
          })
          if (plan.verification === 'execution-only') expect(result).not.toHaveProperty('matched')
          const usedRuntimeSubset = result.environmentLocks?.some(
            (environment) => environment.runtimeSubset
          )
          expect(executedSources.map((source) => source.runId)).toEqual(
            usedRuntimeSubset ? [...scenario.steps, ...scenario.steps] : scenario.steps
          )
          expect(installerCalls).toBeGreaterThan(0)
          expect(events).toContainEqual({
            type: 'inputs-materialized',
            count: plan.crossingFiles.length
          })
          const stateComparisons = result.comparisons.filter(
            (comparison) => comparison.stateComparison
          )
          expect(stateComparisons.map((comparison) => comparison.stepId)).toEqual(
            scenario.independent ? scenario.steps.map((id) => 'step:' + id) : []
          )
          expect(
            stateComparisons.every((comparison) => comparison.stateComparison?.outcome === 'equal')
          ).toBe(true)
          const fileComparisons = result.comparisons.filter(
            (comparison) => !comparison.stateComparison
          )
          if (plan.targetOutputEntityIds.length) expect(fileComparisons.length).toBeGreaterThan(0)
          expect(fileComparisons.every((comparison) => comparison.status === 'matched')).toBe(true)
          const actualEnvironments = await Promise.all(
            (result.environmentLocks ?? []).map(async (environment) => {
              const requirement = plan.environmentRequirements.find(
                (item) => item.requirementId === environment.requirementId
              )!
              const sourceChecksum = environment.sourceLockChecksum ?? environment.lockChecksum
              expect(sourceChecksum).toBe(requirement.lockChecksum)
              const sourceBytes = await readFile(
                join(storageRoot, 'runtime/provenance/environment-locks', sourceChecksum + '.json'),
                'utf8'
              )
              const actualBytes = await readFile(
                join(
                  storageRoot,
                  'runtime/provenance/environment-locks',
                  environment.lockChecksum + '.json'
                ),
                'utf8'
              )
              expect(hash(sourceBytes)).toBe(sourceChecksum)
              expect(hash(actualBytes)).toBe(environment.lockChecksum)
              const sourceLock = parseNotebookEnvironmentLock(sourceBytes)
              const actualLock = parseNotebookEnvironmentLock(actualBytes)
              const sourceConda = sourceLock.components.find(
                (component) => component.ecosystem === 'conda'
              )!
              const actualConda = actualLock.components.find(
                (component) => component.ecosystem === 'conda'
              )!
              const runtimeSubset = environment.runtimeSubset
                ? deriveCondaRuntimeSubsetPlan(
                    sourceLock,
                    sourceChecksum,
                    environment.runtimeSubset.scopeChecksum,
                    environment.runtimeSubset.archiveNames
                  )
                : undefined
              if (environment.runtimeSubset) {
                expect(runtimeSubset).toBeDefined()
                expect(hash(JSON.stringify(runtimeSubset))).toBe(
                  environment.runtimeSubset.planChecksum
                )
                expect(runtimeSubset!.missingDependencies).toEqual(
                  environment.runtimeSubset.missingDependencies
                )
              }
              const actualPackages = runtimeSubset
                ? runtimeSubset.packages.map(({ name }) => name.replace(/[-_.]+/gu, '-')).sort()
                : actualConda.packages
              const derived = sourceChecksum !== environment.lockChecksum || !!runtimeSubset
              expect(sourceConda.packages).toContain('bioconductor-deseq2')
              expect(actualConda.dependencyGraph?.packages.length).toBe(actualConda.packages.length)
              if (mode === 'selected' && scenario.independent && !runtimeSubset) {
                const graph = sourceConda.dependencyGraph!
                expect(graph.rPackageOwnership?.packages.length).toBeGreaterThan(0)
                const roots = new Set(['r-base', 'r-jsonlite'])
                for (const step of plan.steps.filter(
                  (step) => step.environmentRequirementId === environment.requirementId
                )) {
                  const run = scenario.capture.runs.find((run) => run.runId === step.runId)!
                  const checkpoint = run.stageCheckpoint
                  if (checkpoint?.state !== 'available' || !checkpoint.environmentProof)
                    throw new Error('Expected captured per-stage package-use proof')
                  for (const pkg of checkpoint.environmentProof.packages) {
                    const owners = graph.rPackageOwnership!.packages.filter(
                      (owner) => owner.name === pkg.name && owner.version === pkg.version
                    )
                    expect(owners, JSON.stringify(pkg)).toHaveLength(1)
                    roots.add(owners[0]!.condaPackage)
                  }
                }
                // Independently check archive reachability, including every transitive
                // nonvirtual dependency and excluding packages outside the proven closure.
                const reachable = new Set<string>()
                const pending = [...roots]
                while (pending.length) {
                  const name = pending.pop()!
                  if (reachable.has(name) || name.startsWith('__')) continue
                  const pkg = graph.packages.find((pkg) => pkg.name === name)
                  if (!pkg) throw new Error('Missing captured archive dependency: ' + name)
                  reachable.add(name)
                  pending.push(...pkg.depends.map((spec) => spec.split(' ')[0]!))
                }
                expect([...actualConda.packages].sort()).toEqual(
                  [...reachable].map((name) => name.replace(/[-_.]+/gu, '-')).sort()
                )
              }
              if (mode === 'full-exact') expect(derived).toBe(false)
              if (
                mode === 'selected' &&
                ['independent-read', 'independent-clean'].includes(scenario.id)
              ) {
                expect(derived).toBe(true)
                expect(actualPackages.length).toBeLessThan(sourceConda.packages.length)
                expect(actualPackages).toEqual(expect.arrayContaining(['r-base', 'r-jsonlite']))
                // Installed-only DESeq2 and ggplot2 never entered these original early cells.
                expect(actualPackages).not.toContain('bioconductor-deseq2')
                expect(actualPackages).not.toContain('r-ggplot2')
              }
              if (scenario.steps.some((id) => ['model', 'fit', 'results'].includes(id)))
                expect(actualPackages).toContain('bioconductor-deseq2')
              return {
                ...environment,
                sourceChecksum,
                selection: runtimeSubset ? 'runtime-subset' : derived ? 'derived' : 'full-exact',
                sourcePackageCount: sourceConda.packages.length,
                actualPackageCount: actualPackages.length,
                actualPackages
              }
            })
          )
          diagnostics.push({
            phase: 'replay',
            scenario: scenario.id,
            mode,
            planId: plan.planId,
            originalRunIds: scenario.steps,
            materializedFiles: plan.crossingFiles.map((file) => file.materializationPath),
            environmentLocks: actualEnvironments,
            comparisons: result.comparisons,
            installerCalls,
            prefixes,
            executedSources,
            events
          })
          await writeReport()
          return result
        } catch (error) {
          diagnostics.push({
            phase: 'replay',
            scenario: scenario.id,
            mode,
            omittedRequiredPackage,
            retainedCondaRecord,
            expectedFailure: mode === 'missing-package',
            installerCalls,
            prefixes,
            executedSources,
            events,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error)
          })
          await writeReport()
          if (mode === 'missing-package') {
            expect(omittedRequiredPackage).toBe(true)
            expect(retainedCondaRecord).toBeDefined()
            expect(executedSources).toEqual([])
            expect(events.some((event) => event.type === 'step-started')).toBe(false)
          }
          throw error
        }
      }
      for (const [index] of cases.entries()) {
        await executeScenario(index)
        report.completedScenarioCount = index + 1
        await writeReport()
      }
      // Same immutable read/clean sources and state/files under the full captured lock must
      // match too: reduction removes installed-only packages without changing the result.
      for (const id of ['independent-read', 'independent-clean']) {
        await executeScenario(
          cases.findIndex((scenario) => scenario.id === id),
          'full-exact'
        )
      }
      await expect(
        executeScenario(
          cases.findIndex((scenario) => scenario.id === 'independent-model'),
          'missing-package'
        )
      ).rejects.toThrow(/bioconductor-deseq2|DESeq2|package metadata/iu)
      report.complete = true
      await writeReport()
    } catch (error) {
      report.error =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error)
      await writeReport()
      throw error
    } finally {
      await original.shutdown()
      if (!evidenceRoot) await rm(storageRoot, { recursive: true, force: true })
    }
  },
  900_000
)

// Reuse the immutable reference instead of rerunning the original analysis while diagnosing
// runtime selection. A required report digest and explicit targets prevent accidental widening.
it.skipIf(!process.env.OPEN_SCIENCE_TEST_FROZEN_RUNTIME_SUBSET_REPORT)(
  'conforms explicit frozen DESeq2 stage runtime subsets through the production entry',
  async ({ signal }) => {
    const required = (name: string): string => {
      const value = process.env[name]
      if (!value?.trim()) throw new Error('Missing frozen runtime subset parameter: ' + name)
      return value
    }
    const reportBytes = await readFile(required('OPEN_SCIENCE_TEST_FROZEN_RUNTIME_SUBSET_REPORT'))
    expect(hash(reportBytes)).toBe(required('OPEN_SCIENCE_TEST_FROZEN_RUNTIME_SUBSET_SHA256'))
    const frozen = JSON.parse(reportBytes.toString('utf8')) as {
      complete: boolean
      productionRLoopChecksum: string
      storageRoot: string
      capture: WorkflowCapture
      plans: WorkflowPlan[]
    }
    expect(frozen.complete).toBe(true)
    expect(validWorkflowCapture(frozen.capture)).toBe(true)
    expect(hash(await readFile(resolveLoopScriptPaths().rLoopPath))).toBe(
      frozen.productionRLoopChecksum
    )
    const targets = required('OPEN_SCIENCE_TEST_FROZEN_RUNTIME_SUBSET_TARGETS').split(',')
    expect(targets.length).toBeGreaterThan(0)
    expect(new Set(targets).size).toBe(targets.length)
    for (const target of targets)
      expect(['read', 'clean', 'model', 'fit', 'results', 'volcano', 'heatmap']).toContain(target)
    const diagnostics: unknown[] = []
    const output = required('OPEN_SCIENCE_TEST_FROZEN_RUNTIME_SUBSET_OUTPUT')
    const save = async (): Promise<void> =>
      writeFile(output, JSON.stringify({ targets, diagnostics }, null, 2))
    const sandbox: NotebookProcessSandbox = {
      createTemporaryScope: () => ({ ...sandbox, dispose: async () => undefined }),
      wrap: async ({ executable, args, env }) => ({
        executable,
        args,
        env,
        annotateStderr: (stderr) => stderr,
        cleanup: async (_reason, outcome) => ({
          processesTerminated: outcome.processesTerminated,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
      })
    }
    for (const target of targets) {
      const plan = frozen.plans.find(
        (plan) =>
          plan.selection.independent &&
          plan.selection.targetRunIds.length === 1 &&
          plan.selection.targetRunIds[0] === target
      )
      if (!plan) throw new Error('Missing exact frozen stage plan: ' + target)
      const result = await executeWorkflowReproducibility(
        {
          capture: frozen.capture,
          plan,
          storageRoot: frozen.storageRoot,
          processSandbox: sandbox,
          signal
        },
        {
          createRuntime: async (request) => {
            const candidate = !!request.runtimeSubset?.plan
            const runtime = await createNotebookReproductionRuntime(request, {
              micromamba: required('OPEN_SCIENCE_TEST_MICROMAMBA'),
              runMicromamba: (argv, env, ...rest) =>
                runMicromamba(
                  argv,
                  {
                    ...env,
                    CONDA_PKGS_DIRS: required('OPEN_SCIENCE_TEST_CONDA_CACHE')
                  },
                  ...rest
                ),
              createExecutor: (options) => {
                const executor = new NotebookKernelExecutor(options)
                return {
                  execute: async (request) => {
                    const response = await executor.execute(request)
                    diagnostics.push({
                      target,
                      phase: 'kernel',
                      candidate,
                      requestedObservation: request.stageRestore?.observeRuntimeFootprint,
                      prefix: request.resolvedInterpreter?.condaPrefix,
                      comparison: response.stageComparison
                    })
                    await save()
                    return response
                  },
                  shutdown: () => executor.shutdown()
                }
              }
            })
            return {
              ...runtime,
              proposeRuntimeSubset: async () => {
                const proposed = await runtime.proposeRuntimeSubset?.()
                diagnostics.push({
                  target,
                  phase: 'proposal',
                  candidate: !!request.runtimeSubset?.plan,
                  proposed
                })
                await save()
                return proposed
              }
            }
          }
        }
      )
      diagnostics.push({ target, phase: 'result', result })
      await save()
      expect(result.matched).toBe(true)
      expect(result.environmentLocks).toHaveLength(1)
      expect(
        result.environmentLocks![0]!.runtimeSubset,
        'Expected an actually verified runtime subset, not the closure fallback'
      ).toBeDefined()
      expect(result.comparisons.every(({ status }) => status === 'matched')).toBe(true)
      for (const run of frozen.capture.runs) {
        if (run.stageCheckpoint?.state !== 'available')
          throw new Error('Missing original checkpoint')
        for (const blob of [run.stageCheckpoint.input, run.stageCheckpoint.output]) {
          const bytes = await readFile(resolveStorageKey(frozen.storageRoot, blob.storageKey))
          expect(hash(bytes)).toBe(blob.checksum)
          expect(bytes.length).toBe(blob.sizeBytes)
        }
      }
    }
  },
  900_000
)

// Deliberately separate from the seven-stage acceptance: an explicit control never recaptures
// original cells or reruns previously completed selections. No value means skip; bad values fail.
it.skipIf(process.env.OPEN_SCIENCE_TEST_FROZEN_DESEQ2_CONTROL === undefined)(
  'continues one explicitly selected frozen DESeq2 control through the production runtime',
  async ({ signal }) => {
    const control = process.env.OPEN_SCIENCE_TEST_FROZEN_DESEQ2_CONTROL
    if (control !== 'clean-full' && control !== 'missing-model')
      throw new Error('Frozen DESeq2 control must be clean-full or missing-model.')
    const required = (name: string): string => {
      const value = process.env[name]
      if (!value?.trim()) throw new Error('Missing required frozen-control parameter: ' + name)
      return value
    }
    const frozenPath = await realpath(required('OPEN_SCIENCE_TEST_FROZEN_DESEQ2_REPORT'))
    const expectedCurrentLoopHash = required('OPEN_SCIENCE_TEST_FROZEN_DESEQ2_CURRENT_LOOP_SHA256')
    if (!/^[a-f0-9]{64}$/u.test(expectedCurrentLoopHash))
      throw new Error(
        'Expected current R loop SHA256 must contain exactly 64 lowercase hex digits.'
      )
    const micromamba = await realpath(required('OPEN_SCIENCE_TEST_MICROMAMBA'))
    const cache = await realpath(required('OPEN_SCIENCE_TEST_CONDA_CACHE'))
    expect((await lstat(cache)).isDirectory()).toBe(true)
    const frozenBytes = await readFile(frozenPath)
    const expectedFrozenHash = 'c20220e8e3cba7f325e644c38b7c89b1ed87f8e311e2ce33acac669834638af9'
    expect(hash(frozenBytes), 'Only the reviewed third frozen report may be resumed').toBe(
      expectedFrozenHash
    )
    const frozen = JSON.parse(frozenBytes.toString('utf8')) as {
      storageRoot: string
      productionRLoopChecksum: string
      capture: WorkflowCapture
      sources: Array<{ id: string; script: string; sourceChecksum: string }>
      runs: NotebookRunRecord[]
      inputs: NotebookRunInputFile[]
      plans: WorkflowPlan[]
    }
    expect(frozen.productionRLoopChecksum).toBe(
      '0d915de6d4e77915a64e0a584652f52d56b3df9d989a5091ede978cc0a46f778'
    )
    const currentRLoopPath = await realpath(resolveLoopScriptPaths().rLoopPath)
    expect(currentRLoopPath).toBe(
      await realpath(join(process.cwd(), 'resources/notebook/r_loop.R'))
    )
    const currentLoopHash = hash(await readFile(currentRLoopPath))
    // The explicitly reviewed current implementation may contain a capture-only metadata fix.
    // Keep both guards: neither assume equality nor silently accept an unreviewed current loop.
    expect(
      currentLoopHash,
      'Current R loop differs from the explicitly approved implementation'
    ).toBe(expectedCurrentLoopHash)
    expect(validWorkflowCapture(frozen.capture)).toBe(true)
    const storageRoot = await realpath(frozen.storageRoot)
    const verifyBlob = async (blob: {
      storageKey: string
      checksum: string
      sizeBytes: number
    }): Promise<void> => {
      const path = resolveStorageKey(storageRoot, blob.storageKey)
      const info = await lstat(path)
      expect(info.isFile() && !info.isSymbolicLink(), path).toBe(true)
      expect(info.size, path).toBe(blob.sizeBytes)
      expect(hash(await readFile(path)), path).toBe(blob.checksum)
    }
    const lockChecksums = new Set<string>()
    expect(frozen.capture.runs.map((run) => run.runId)).toEqual([
      'read',
      'clean',
      'model',
      'fit',
      'results',
      'volcano',
      'heatmap'
    ])
    for (const run of frozen.capture.runs) {
      expect(validRStageCheckpointForRun(run), run.runId).toBe(true)
      const checkpoint = run.stageCheckpoint
      if (checkpoint?.state !== 'available')
        throw new Error('Frozen checkpoint missing: ' + run.runId)
      const source = frozen.sources.find((source) => source.id === run.runId)
      const original = frozen.runs.find((original) => original.runId === run.runId)
      if (!source || !original) throw new Error('Frozen original source missing: ' + run.runId)
      expect(run.script).toBe(source.script)
      expect(original.script).toBe(run.script)
      expect(original.stageCheckpoint).toEqual(checkpoint)
      expect(original.environmentLock).toEqual(run.environmentLock)
      expect(hash(run.script)).toBe(source.sourceChecksum)
      expect(checkpoint.sourceChecksum).toBe(source.sourceChecksum)
      await verifyBlob(checkpoint.input)
      await verifyBlob(checkpoint.output)
      lockChecksums.add(checkpoint.environmentLockChecksum)
    }
    for (const checksum of lockChecksums) {
      const bytes = await readFile(
        resolveStorageKey(storageRoot, 'runtime/provenance/environment-locks/' + checksum + '.json')
      )
      expect(hash(bytes)).toBe(checksum)
      const lock = parseNotebookEnvironmentLock(bytes.toString('utf8'))
      expect(lock.kernelKind).toBe('r')
    }
    for (const input of frozen.inputs) await verifyBlob(input)
    for (const input of frozen.capture.inputFiles) await verifyBlob(input)
    const runId = control === 'clean-full' ? 'clean' : 'model'
    const expectedPlanId =
      control === 'clean-full'
        ? 'e5b3ea82e8127651f08bfe307634e9dbb06b5e949f884963a81549e7b0cf2104'
        : 'd006b83b053ee70e8c1b73bf702fa443fb47c7ab74d0ba1deca75cf14e4901f0'
    const plan = frozen.plans.find((plan) => plan.planId === expectedPlanId)
    if (!plan) throw new Error('Reviewed frozen control plan missing: ' + expectedPlanId)
    expect(reproductionWorkflowSlices.workflowPlanMatchesCapture(frozen.capture, plan)).toBe(true)
    expect(reproductionWorkflowSlices.planWorkflowSlice(frozen.capture, plan.selection)).toEqual(
      plan
    )
    expect(plan.status).toBe('ready')
    expect(plan.selection).toEqual({
      independent: true,
      captureId: frozen.capture.captureId,
      targetRunIds: [runId]
    })
    expect(plan.selectedStepIds).toEqual(['step:' + runId])
    for (const file of plan.crossingFiles)
      await verifyBlob({
        storageKey: file.contentStorageKey,
        checksum: file.checksum,
        sizeBytes: file.sizeBytes
      })

    const outputRoot = await mkdtemp(join(dirname(frozenPath), 'frozen-control-' + control + '-'))
    const outputPath = join(outputRoot, 'report.json')
    const startedAt = Date.now()
    const timeline: Array<Record<string, unknown>> = []
    const events: Array<{
      at: string
      elapsedMs: number
      event: ArtifactReproducibilityExecutionEvent
    }> = []
    const executedSources: Array<{ runId: string; sourceChecksum: string }> = []
    const prefixes: string[] = []
    let retainedCondaRecord:
      { path: string; checksumBefore: string; checksumAfter: string } | undefined
    let omittedRequiredPackage = false
    const report: Record<string, unknown> = {
      complete: false,
      control,
      frozenPath,
      frozenReportSha256: expectedFrozenHash,
      frozenRLoopSha256: frozen.productionRLoopChecksum,
      approvedCurrentRLoopSha256: expectedCurrentLoopHash,
      actualCurrentRLoopSha256: currentLoopHash,
      actualCurrentRLoopPath: currentRLoopPath,
      currentTestSha256: hash(
        await readFile(
          join(process.cwd(), 'src/main/notebook/cross-turn-input-repro.integration.test.ts')
        )
      ),
      storageRoot,
      planId: plan.planId,
      captureId: frozen.capture.captureId,
      sourceChecksum: plan.steps[0]!.sourceChecksum,
      verifiedOriginalInputChecksums: frozen.inputs.map(({ filename, checksum }) => ({
        filename,
        checksum
      })),
      timeline,
      events,
      executedSources,
      prefixes
    }
    let reportWrites = Promise.resolve()
    const writeReport = (): Promise<void> => {
      reportWrites = reportWrites.then(() => writeFile(outputPath, JSON.stringify(report, null, 2)))
      return reportWrites
    }
    const describeError = (error: unknown): unknown =>
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(error.cause instanceof Error
              ? { cause: { name: error.cause.name, message: error.cause.message } }
              : {})
          }
        : String(error)
    const observe = (entry: Record<string, unknown>): void => {
      timeline.push({ at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, ...entry })
      // Child hooks are synchronous; serialize observational writes without delaying their owner.
      // A later awaited write still surfaces an earlier publication failure.
      void writeReport().catch(() => undefined)
    }
    const timed = async <T>(
      phase: string,
      details: Record<string, unknown>,
      invoke: () => Promise<T>
    ): Promise<T> => {
      const begin = Date.now()
      timeline.push({
        phase,
        status: 'started',
        at: new Date(begin).toISOString(),
        elapsedMs: begin - startedAt,
        ...details
      })
      await writeReport()
      try {
        const result = await invoke()
        timeline.push({
          phase,
          status: 'completed',
          at: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          durationMs: Date.now() - begin,
          ...details
        })
        await writeReport()
        return result
      } catch (error) {
        timeline.push({
          phase,
          status: 'failed',
          at: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          durationMs: Date.now() - begin,
          ...details,
          error: describeError(error)
        })
        await writeReport()
        throw error
      }
    }
    const observedMicromamba: typeof runMicromamba = (
      argv,
      env,
      childSignal,
      onChild,
      onBeforeSpawn,
      timeoutMs,
      onOutput
    ) =>
      timed('process-spawn', { command: argv[0], args: argv.slice(1), timeoutMs }, () =>
        runMicromamba(
          argv,
          env,
          childSignal,
          (pid) => {
            observe({ phase: 'child-spawned', command: argv[0], pid })
            onChild?.(pid)
          },
          () => {
            observe({ phase: 'spawn-intent', command: argv[0] })
            onBeforeSpawn?.()
          },
          timeoutMs,
          (output) => {
            observe({
              phase: 'process-output',
              command: argv[0],
              stream: output.stream,
              text: output.text.slice(-8192)
            })
            onOutput?.(output)
          }
        )
      )
    // The same production verifier factory used by environment-process, with the real runner
    // observed at its existing child hooks. No result, timeout or teardown outcome is replaced.
    const observedExecutableVerifier = createExecutableVerifier(observedMicromamba)
    const onAbort = (): void => observe({ phase: 'abort', reason: describeError(signal.reason) })
    signal.addEventListener('abort', onAbort, { once: true })
    const sandbox: NotebookProcessSandbox = {
      createTemporaryScope: () => ({
        wrap: sandbox.wrap,
        dispose: async () => undefined
      }),
      wrap: async ({ executable, args, env }) => ({
        executable,
        args,
        env,
        annotateStderr: (stderr) => stderr,
        cleanup: (reason, outcome) =>
          timed('sandbox-cleanup', { reason, outcome }, async () => ({
            processesTerminated: outcome.processesTerminated,
            networkClosed: true,
            temporaryResourcesRemoved: true
          }))
      })
    }
    await writeReport()
    try {
      let result: Awaited<ReturnType<typeof executeWorkflowReproducibility>> | undefined
      let executionError: unknown
      try {
        result = await timed('workflow', {}, () =>
          executeWorkflowReproducibility(
            {
              capture: frozen.capture,
              plan,
              storageRoot,
              processSandbox: sandbox,
              signal,
              onEvent: (event) =>
                events.push({
                  at: new Date().toISOString(),
                  elapsedMs: Date.now() - startedAt,
                  event
                })
            },
            {
              createRuntime: async (runtimeInput) => {
                const runtime = await timed(
                  'create-runtime',
                  { attemptRoot: runtimeInput.attemptRoot },
                  () =>
                    createNotebookReproductionRuntime(
                      {
                        ...runtimeInput,
                        ...(control === 'clean-full'
                          ? {
                              selectedRuns: runtimeInput.selectedRuns?.map((run) => {
                                if (run.stageCheckpoint?.state !== 'available') return run
                                const { environmentProof: _proof, ...stageCheckpoint } =
                                  run.stageCheckpoint
                                void _proof
                                return { ...run, stageCheckpoint }
                              })
                            }
                          : {})
                      },
                      {
                        micromamba,
                        runMicromamba: async (argv, env, ...rest) => {
                          expect(argv).toContain('--offline')
                          const prefix = argv[argv.indexOf('-p') + 1]!
                          await expect(access(prefix)).rejects.toMatchObject({ code: 'ENOENT' })
                          prefixes.push(prefix)
                          const installed = await timed('restore-packages', { prefix }, () =>
                            observedMicromamba(argv, { ...env, CONDA_PKGS_DIRS: cache }, ...rest)
                          )
                          if (control === 'missing-model') {
                            await timed('omit-DESeq2-directory', { prefix }, async () => {
                              const records = (await readdir(join(prefix, 'conda-meta'))).filter(
                                (file) => file.startsWith('bioconductor-deseq2-')
                              )
                              expect(records).toHaveLength(1)
                              const path = join(prefix, 'conda-meta', records[0]!)
                              const checksumBefore = hash(await readFile(path))
                              const packagePath = join(prefix, 'lib/R/library/DESeq2')
                              await rm(packagePath, { recursive: true })
                              await expect(access(packagePath)).rejects.toMatchObject({
                                code: 'ENOENT'
                              })
                              await expect(access(path)).resolves.toBeUndefined()
                              const checksumAfter = hash(await readFile(path))
                              expect(checksumAfter).toBe(checksumBefore)
                              retainedCondaRecord = { path, checksumBefore, checksumAfter }
                              omittedRequiredPackage = true
                              report.retainedCondaRecord = retainedCondaRecord
                            })
                          }
                          return installed
                        },
                        verifyExecutable: (bin, options) =>
                          timed('verify-executable', { bin, prefix: options?.prefix }, () =>
                            observedExecutableVerifier(bin, options)
                          ),
                        verifyEnvironment: (input) =>
                          timed('verify-environment', { prefix: input.prefix }, () =>
                            verifyRestoredEnvironment({
                              ...input,
                              spawn: (
                                bin,
                                args,
                                env,
                                onChild,
                                onBeforeSpawn,
                                structured,
                                cwd,
                                options
                              ) =>
                                timed(
                                  'package-probe-spawn',
                                  { bin, args, cwd, timeoutMs: options?.timeoutMs },
                                  () =>
                                    input.spawn(
                                      bin,
                                      args,
                                      env,
                                      (pid) => {
                                        observe({ phase: 'child-spawned', command: bin, pid })
                                        onChild?.(pid)
                                      },
                                      () => {
                                        observe({ phase: 'spawn-intent', command: bin })
                                        onBeforeSpawn?.()
                                      },
                                      structured,
                                      cwd,
                                      {
                                        ...options,
                                        onOutput: (output) => {
                                          observe({
                                            phase: 'process-output',
                                            command: bin,
                                            stream: output.stream,
                                            text: output.text.slice(-8192)
                                          })
                                          options?.onOutput?.(output)
                                        }
                                      }
                                    )
                                )
                            })
                          )
                      }
                    )
                )
                return {
                  ...runtime,
                  execute: async (request) => {
                    expect(request.step.runId).toBe(runId)
                    expect(hash(request.source)).toBe(plan.steps[0]!.sourceChecksum)
                    executedSources.push({
                      runId: request.step.runId,
                      sourceChecksum: hash(request.source)
                    })
                    return timed('execute-source', { runId: request.step.runId }, () =>
                      runtime.execute(request)
                    )
                  },
                  shutdown: () => timed('shutdown', {}, () => runtime.shutdown())
                }
              }
            }
          )
        )
      } catch (error) {
        executionError = error
        report.executionError = describeError(error)
      }
      report.result = result
      if (control === 'clean-full') {
        if (executionError !== undefined) throw executionError
        expect(result).toMatchObject({
          matched: true,
          verification: 'state-comparison',
          completedStepIds: ['step:clean'],
          captureId: frozen.capture.captureId,
          planId: expectedPlanId
        })
        expect(executedSources).toEqual([
          { runId: 'clean', sourceChecksum: plan.steps[0]!.sourceChecksum }
        ])
        expect(result!.comparisons.filter((comparison) => comparison.stateComparison)).toEqual([
          expect.objectContaining({
            stepId: 'step:clean',
            stateComparison: { outcome: 'equal' },
            status: 'matched'
          })
        ])
        const files = result!.comparisons.filter((comparison) => !comparison.stateComparison)
        expect(files.map((file) => file.relativePath).sort()).toEqual([
          'data/clean-counts.csv',
          'data/clean-metadata.csv'
        ])
        for (const file of files) {
          expect(file.status).toBe('matched')
          expect(file.actualChecksum).toBe(file.expectedChecksum)
        }
        expect(result!.environmentLocks).toHaveLength(1)
        expect(result!.environmentLocks![0]!.lockChecksum).toBe(
          plan.environmentRequirements[0]!.lockChecksum
        )
        report.outcome = 'matched'
      } else {
        expect(omittedRequiredPackage).toBe(true)
        expect(retainedCondaRecord).toBeDefined()
        expect(executionError).toBeInstanceOf(Error)
        expect((executionError as Error).message).toMatch(
          /Restored package metadata probe failed/iu
        )
        expect(
          timeline.some(
            (entry) => entry.phase === 'verify-environment' && entry.status === 'failed'
          )
        ).toBe(true)
        expect(executedSources).toEqual([])
        expect(events.some(({ event }) => event.type === 'step-started')).toBe(false)
        report.outcome = 'expected-package-rejection'
      }
      expect(prefixes).toHaveLength(1)
      report.complete = true
      await writeReport()
    } catch (error) {
      report.error = describeError(error)
      await writeReport()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      await reportWrites
    }
  },
  180_000
)

it.skipIf(!process.env.RUN_KERNEL || !python)(
  'matches input path evaluation by the Python interpreter',
  async () => {
    const expressions = [
      'Path("inputs", "groups.csv")',
      'Path("inputs") / "/data/groups.csv"',
      'Path("inputs").joinpath("/data", "groups.csv")',
      'Path("inputs/groups.csv.bak").with_suffix("")',
      'Path("inputs/.groups").with_suffix(".csv")',
      'Path("inputs/link") / "../groups.csv"',
      'os.path.join("inputs", "/data", "groups.csv")',
      'posixpath.join("inputs", "../groups.csv")',
      String.raw`ntpath.join("C:\\inputs", "\\data", "groups.csv")`,
      String.raw`ntpath.join("C:\\inputs", "D:groups.csv")`,
      String.raw`ntpath.join("C:\\inputs", "c:groups.csv")`,
      String.raw`ntpath.join("\\\\server\\share", "groups.csv")`
    ]
    const imports = 'from pathlib import Path\nimport os, posixpath, ntpath, json'
    const { stdout } = await promisify(execFile)(python!, [
      '-I',
      '-c',
      `${imports}\nprint(json.dumps([str(value) for value in [${expressions.join(',')}]]))`
    ])
    const expected: string[] = JSON.parse(stdout)
    for (const [index, expression] of expressions.entries()) {
      const [result] = await analyzePythonFileAccesses([`${imports}\nopen(${expression})`])
      expect(result?.reads, expression).toEqual([expected[index]])
    }
  }
)

for (const [language, reportedPlots] of [
  ['python', false],
  ['r', false],
  ['r', 'base-plots'],
  ['python', true],
  ['python', 'nested-subplots']
] as const) {
  const command =
    language === 'python'
      ? python
      : process.env.OPEN_SCIENCE_TEST_R_ENV
        ? join(process.env.OPEN_SCIENCE_TEST_R_ENV, 'bin/Rscript')
        : undefined
  const args = (script: string): string[] =>
    language === 'r' ? ['--vanilla', '-e', script] : ['-I', '-c', script]
  it.skipIf(!process.env.RUN_KERNEL || !command)(
    `replays the third ${language} plot${reportedPlots === 'base-plots' ? ' with base graphics annotations' : reportedPlots === 'nested-subplots' ? ' with nested subplots' : reportedPlots ? ' with reported sorting and labels' : ''} using an earlier upload without reattaching it, including after reopening the repository`,
    async () => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'cross-turn-plot-'))
      const execute = promisify(execFile)
      const session = {
        projectId: 'project',
        sessionId: 'session',
        lane: createRootNotebookLane('project', 'session', 'root')
      }
      const repository = new NotebookRunRepository(storageRoot)
      try {
        const document = await repository.loadOrCreate({ ...session, workspaceCwd: storageRoot })
        const content = 'group\n' + 'Ctrl\n'.repeat(33) + 'IRI\n'.repeat(33)
        const input: NotebookRunInputFile = {
          sourceKind: 'upload-version',
          sourceFileId: 'groups',
          inputFileVersionId: 'groups-v1',
          sourceProjectId: 'project',
          sourceSessionId: 'session',
          filename: 'groups.csv',
          checksum: hash(content),
          sizeBytes: Buffer.byteLength(content),
          storageKey: 'uploads/groups.csv',
          association: 'turn-attached'
        }
        const inputPath = notebookPromptInputPath(input.filename, input.checksum)
        const scripts =
          reportedPlots === 'nested-subplots'
            ? [
                'print("ready")',
                reportedSubplotsInput.replace('inputs/sample-groups-666666666666.csv', inputPath),
                reportedSubplots
                  .replace('inputs/sample-groups-666666666666.csv', inputPath)
                  .replaceAll('synthetic_groups_group_plots.png', 'group_bar.png')
              ]
            : reportedPlots === 'base-plots'
              ? [
                  'print("ready")',
                  `df <- read.csv("${inputPath}"); print(table(df$group))`,
                  rBasePlots
                    .replace('inputs/sample-groups-666666666666.csv', inputPath)
                    .replaceAll('synthetic_groups_group1_bar_r.png', 'group_bar.png')
                ]
              : reportedPlots
                ? reportedPythonPlots(inputPath)
                : language === 'r'
                  ? [
                      'library(ggplot2)\nx <- seq(0, 2*pi, length.out=400)\np <- ggplot(data.frame(x=x, y=sin(x)), aes(x=x, y=y)) + geom_line()\nggsave("sin_wave.png", p, width=7, height=4.5, dpi=150)',
                      `library(ggplot2)
df <- read.csv("${inputPath}")
counts <- as.data.frame(table(df$group))
names(counts) <- c("group", "n")
p <- ggplot(counts, aes(x="", y=n, fill=group)) +
  geom_col(width=1) + coord_polar(theta="y") + theme_void()
ggsave("group_pie.png", p, width=5.5, height=5.5, dpi=150)`,
                      `library(ggplot2)
files <- list(groups = "${inputPath}", unused = "inputs/unrelated.csv")
path <- files[["groups"]]
df <- read.csv(path)
counts <- as.data.frame(table(df$group))
names(counts) <- c("group", "n")
p <- ggplot(counts, aes(x=group, y=n, fill=group)) +
  geom_col(width=0.6, color="white") +
  geom_text(aes(label=n), vjust=-0.5) +
  scale_fill_manual(values=c(Ctrl="#4C72B0", IRI="#DD8452")) +
  labs(title="Sample count per group (SYNTHETIC_GROUPS)", x="Group", y="Number of samples") +
  ylim(0, max(counts$n) * 1.2) + theme_minimal()
ggsave("group_bar.png", p, width=6, height=4.5, dpi=150)
cat("saved group_bar.png\\n")`
                    ]
                  : [
                      'import numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(0, 2*np.pi, 400)\nfig, ax = plt.subplots()\nax.plot(x, np.sin(x))\nfig.savefig("sin_wave.png")',
                      `import pandas as pd\nimport matplotlib.pyplot as plt\ndf = pd.read_csv("${inputPath}")\ncounts = df["group"].value_counts()\nfig, ax = plt.subplots()\nax.pie(counts.values, labels=counts.index)\nfig.savefig("group_pie.png")`,
                      `import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path
df = pd.read_csv(Path("inputs", "${inputPath.slice('inputs/'.length)}"))
counts = df["group"].value_counts()
fig, ax = plt.subplots(figsize=(6, 4.5))
colors = ["#4C72B0", "#DD8452"]
bars = ax.bar(counts.index, counts.values, color=colors, edgecolor="white", linewidth=1.5)
for bar, value in zip(bars, counts.values):
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
            str(int(value)), ha="center", va="bottom", fontsize=12)
ax.set_title("Sample count per group (SYNTHETIC_GROUPS)")
ax.set_xlabel("Group")
ax.set_ylabel("Number of samples")
ax.set_ylim(0, max(counts.values) * 1.2)
ax.grid(axis="y", alpha=0.3)
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig("group_bar.png", dpi=150)
print("saved group_bar.png")`
                    ]
        const activities: Array<{
          run: NotebookRunRecord
          runIndex: number
          evidenceJson: string
        }> = []
        for (const [index, script] of scripts.entries()) {
          expect(await analyzeNotebookSourceFileAccess(language, script)).toMatchObject({
            readState: 'complete',
            writeState: 'complete',
            externalState: 'complete',
            reads: index === 0 ? [] : [inputPath],
            reasonCodes: []
          })
          if (index === 1) {
            for (const path of [
              join(document.dataRoot, inputPath),
              join(storageRoot, input.storageKey)
            ]) {
              await mkdir(dirname(path), { recursive: true })
              await writeFile(path, content)
            }
            await writeFile(join(document.dataRoot, 'inputs/unrelated.csv'), 'unused\n')
          }
          const running: NotebookRunRecord = {
            runId: 'run-' + index,
            cellId: 'cell-' + index,
            kernelKind: language,
            kernelEpochId: 'epoch',
            kernelDispatched: true,
            source: 'agent',
            script,
            status: 'running',
            startedAt: index,
            cwdBefore: document.dataRoot,
            messageBranchId: 'branch',
            promptMessageId: 'prompt-' + index,
            text: { stdout: '', stderr: '', traceback: '', plain: [] },
            outputs: [],
            workingFiles: [],
            inputFiles: index === 1 ? [input] : []
          }
          const owner = new NotebookRunTerminalizationOwner({
            // A new repository instance on every turn exercises durable history, not registry memory.
            repository: new NotebookRunRepository(storageRoot),
            notifyChanged: () => undefined
          })
          const { run } = await owner.run({
            session,
            runningRun: running,
            invoke: async () => {
              const observer = await startWorkingFileObservation({
                dataRoot: document.dataRoot,
                notebookSessionRoot: document.notebookSessionRoot,
                cwd: document.dataRoot,
                code: script,
                language,
                runId: running.runId,
                registeredInputFiles: running.inputFiles
              })
              const execution = await execute(command!, args(script), {
                cwd: document.dataRoot,
                timeout: 30_000,
                env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(storageRoot, 'mpl') }
              })
              return {
                status: 'completed',
                stdout: execution.stdout,
                stderr: execution.stderr,
                traceback: '',
                cwdAfter: document.dataRoot,
                outputs: [],
                ...(await observer.finish())
              }
            }
          })
          activities.push({
            run,
            runIndex: index,
            evidenceJson: await readFile(
              join(dirname(document.notebookSessionRoot), run.fileEvidence!.storageKey!),
              'utf8'
            )
          })
        }
        const producer = activities[2]!.run
        if (reportedPlots) {
          const projection = await createNotebookDependencyAnalyzer({
            storageRoot,
            repository: { readSessionRuns: async () => activities.map(({ run }) => run) }
          }).project({
            projectId: session.projectId,
            sessionId: session.sessionId,
            completedRun: producer,
            interpreter: { command: command! }
          })
          expect(projection.stalenessByRunId).toEqual({
            'run-0': { state: 'clear' },
            'run-1': { state: 'clear' },
            'run-2': { state: 'clear' }
          })
          expect(projection.dependenciesByRunId).toEqual({ 'run-0': [], 'run-1': [], 'run-2': [] })
        }
        expect(producer.inputFiles).toEqual([
          expect.objectContaining({
            inputFileVersionId: input.inputFileVersionId,
            accessEvidence: 'file-evidence'
          })
        ])
        const output = producer.workingFiles.find(
          (file) => file.relativePath === 'data/group_bar.png'
        )!
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: 'version-bar',
            filename: 'group_bar.png',
            checksum: output.checksum!,
            sizeBytes: output.size!,
            producerRunId: producer.runId,
            sourceGenerationId: output.generationId
          },
          notebookActivities: activities,
          computeActivities: []
        })
        expect(graph.completeness).toBe('complete')
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            kind: 'used',
            activityId: producer.runId,
            authority: 'authoritative'
          })
        )
        const recipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: producer.inputFiles ?? [],
          runs: activities.map(({ run, runIndex }) => ({
            runId: run.runId,
            runIndex,
            agentFrameId: 'agent',
            messageBranchId: 'branch',
            runtimeSegmentId: 'runtime',
            promptMessageId: 'prompt-' + runIndex,
            kernelEpochId: 'epoch',
            kernelKind: language,
            environmentName: `default-${language}`,
            // This regression isolates file lineage; native lock capture/restoration has separate tests.
            environmentLock: {
              state: 'available',
              format: 'environment-lock-bundle',
              lockChecksum: 'a'.repeat(64)
            },
            script: run.script,
            status: 'completed',
            startedAt: '2026-09-05T00:00:00.000Z',
            completedAt: '2026-09-05T00:00:01.000Z',
            outputs: [],
            inputFileVersionKeys: []
          }))
        })
        const plan = reproductionRecipes.resolveArtifactReproducibilityExecutionPlan(
          recipe,
          'original-inputs'
        )
        expect(recipe.capture).toEqual({ state: 'sealed', reasonCodes: [] })
        expect(plan?.steps.map((step) => step.activityId)).toEqual([producer.runId])
        expect(plan?.frontier.crossingFiles).toHaveLength(1)
        const replay = join(storageRoot, 'replay')
        for (const file of plan!.frontier.crossingFiles) {
          const destination = join(replay, file.materializationPath)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, await readFile(join(storageRoot, file.contentStorageKey)))
        }
        await execute(command!, args(scripts[2]!), {
          cwd: replay,
          timeout: 30_000,
          env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(storageRoot, 'mpl') }
        })
        expect(hash(await readFile(join(replay, 'group_bar.png')))).toBe(output.checksum)
        // A historical registration must not certify bytes changed in the working input copy.
        await writeFile(join(document.dataRoot, inputPath), content + 'Ctrl\n')
        const changed: NotebookRunRecord = {
          ...producer,
          runId: 'run-changed',
          startedAt: 3,
          status: 'running',
          inputFiles: [],
          fileEvidence: undefined,
          workingFiles: []
        }
        const checked = await new NotebookRunTerminalizationOwner({
          repository: new NotebookRunRepository(storageRoot),
          notifyChanged: () => undefined
        }).run({
          session,
          runningRun: changed,
          invoke: async () => {
            const observer = await startWorkingFileObservation({
              dataRoot: document.dataRoot,
              notebookSessionRoot: document.notebookSessionRoot,
              cwd: document.dataRoot,
              code: changed.script,
              language,
              runId: changed.runId,
              registeredInputFiles: changed.inputFiles
            })
            const execution = await execute(command!, args(changed.script), {
              cwd: document.dataRoot,
              timeout: 30_000,
              env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(storageRoot, 'mpl') }
            })
            return {
              status: 'completed',
              stdout: execution.stdout,
              stderr: execution.stderr,
              traceback: '',
              outputs: [],
              ...(await observer.finish())
            }
          }
        })
        expect(checked.run.inputFiles).toEqual([])
        expect(checked.run.fileEvidence?.state).not.toBe('available')
      } finally {
        await rm(storageRoot, { recursive: true, force: true })
      }
    },
    60_000
  )
}

// Opt in separately: ordinary native R lanes need not install Bioconductor packages.
// RUN_KERNEL=1 OPEN_SCIENCE_TEST_DESEQ2=1 OPEN_SCIENCE_TEST_R_ENV=/path/to/prefix
it.skipIf(
  !process.env.RUN_KERNEL ||
    process.env.OPEN_SCIENCE_TEST_DESEQ2 !== '1' ||
    !process.env.OPEN_SCIENCE_TEST_R_ENV
)(
  'captures real DESeq2 file checkpoints and rejects a residual in-memory result dependency',
  async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'deseq2-checkpoints-'))
    const command = join(process.env.OPEN_SCIENCE_TEST_R_ENV!, 'bin/Rscript')
    const execute = promisify(execFile)
    const session = {
      projectId: 'project',
      sessionId: 'session',
      lane: createRootNotebookLane('project', 'session', 'root')
    }
    const repository = new NotebookRunRepository(storageRoot)
    const document = await repository.loadOrCreate({ ...session, workspaceCwd: storageRoot })
    const evidenceLocation = getNotebookFileEvidenceLocation(
      storageRoot,
      session.projectId,
      session.sessionId,
      session.lane
    )
    // Use the production loop to preserve real R objects between captured cells. Replays below
    // deliberately use fresh --vanilla processes, so no warm-kernel state can rescue a checkpoint.
    const child = spawn(
      command,
      ['--vanilla', join(__dirname, '../../../resources/notebook/r_loop.R')],
      {
        cwd: document.dataRoot,
        env: { ...process.env, OPEN_SCIENCE_KERNEL_FIGURES_DIR: join(storageRoot, 'figures') }
      }
    )
    const lines = createInterface({ input: child.stdout })
    const waiters = new Map<
      string,
      { resolve: (response: KernelLoopResponse) => void; reject: (error: Error) => void }
    >()
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const rejectPending = (error: Error): void => {
      for (const waiter of waiters.values()) waiter.reject(error)
      waiters.clear()
    }
    child.on('error', rejectPending)
    child.on('exit', (code, signal) =>
      rejectPending(new Error(`DESeq2 R loop exited: ${code} ${signal} ${stderr}`))
    )
    lines.on('line', (line) => {
      const response = parseLoopResponse(line)
      if (!response) return
      const waiter = waiters.get(response.reqId)
      if (!waiter) return
      waiters.delete(response.reqId)
      waiter.resolve(response)
    })
    const send = (script: string): Promise<KernelLoopResponse> => {
      const reqId = randomUUID()
      const pending = new Promise<KernelLoopResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(reqId)
          reject(new Error(`DESeq2 R request timed out: ${stderr}`))
        }, 60_000)
        waiters.set(reqId, {
          resolve: (response) => {
            clearTimeout(timeout)
            resolve(response)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          }
        })
      })
      child.stdin.write(frameRRequest(reqId, script))
      return pending
    }
    try {
      // Synthetic, unnormalised integer counts: eight biological replicates and a fixed NB seed.
      // Keep an all-zero gene to verify that full result export retains DESeq2's NA rows.
      await execute(
        command,
        [
          '--vanilla',
          '-e',
          `
set.seed(20261019)
mu <- exp(runif(1000, log(25), log(1500)))
dispersion <- 0.08 + 3 / mu
counts <- sapply(seq_len(8), function(sample) {
  effect <- if (sample > 4) c(rep(4, 100), rep(0.25, 100), rep(1, 800)) else rep(1, 1000)
  rnbinom(1000, mu = mu * effect, size = 1 / dispersion)
})
counts <- rbind(counts, rep(0L, 8))
rownames(counts) <- paste0("gene", seq_len(1001))
colnames(counts) <- paste0("sample", seq_len(8))
metadata <- data.frame(condition = rep(c("control", "treated"), each = 4), row.names = colnames(counts))
write.csv(counts, "raw-counts.csv")
write.csv(metadata, "raw-metadata.csv")
`
        ],
        { cwd: storageRoot, timeout: 30_000 }
      )
      const inputs: NotebookRunInputFile[] = []
      for (const filename of ['raw-counts.csv', 'raw-metadata.csv']) {
        const bytes = await readFile(join(storageRoot, filename))
        const input: NotebookRunInputFile = {
          sourceKind: 'upload-version',
          sourceFileId: filename,
          inputFileVersionId: filename + '-v1',
          sourceProjectId: session.projectId,
          sourceSessionId: session.sessionId,
          filename,
          checksum: hash(bytes),
          sizeBytes: bytes.length,
          storageKey: 'uploads/' + filename,
          association: 'turn-attached'
        }
        for (const destination of [
          join(document.dataRoot, notebookPromptInputPath(filename, input.checksum)),
          join(storageRoot, input.storageKey)
        ]) {
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, bytes)
        }
        inputs.push(input)
      }
      const cleanScript = `
cleanCounts <- read.csv("${notebookPromptInputPath(inputs[0]!.filename, inputs[0]!.checksum)}", row.names = 1, check.names = FALSE)
cleanMetadata <- read.csv("${notebookPromptInputPath(inputs[1]!.filename, inputs[1]!.checksum)}", row.names = 1)
write.csv(cleanCounts, "clean-counts.csv")
write.csv(cleanMetadata, "clean-metadata.csv")`
      // The DE cell reloads both tables and records the reference level, design, contrast and
      // non-default statistical options explicitly; no normalized abundance is substituted.
      const deScript = `
library(DESeq2)
counts <- as.matrix(read.csv("clean-counts.csv", row.names = 1, check.names = FALSE))
metadata <- read.csv("clean-metadata.csv", row.names = 1)
stopifnot(identical(colnames(counts), rownames(metadata)))
metadata$condition <- factor(metadata$condition, levels = c("control", "treated"))
# DESeq defaults to a Wald test; the supported explicit options below are sealed with the script.
dds <- DESeq2::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition)
dds <- DESeq2::DESeq(dds, fitType = "mean", betaPrior = FALSE, parallel = FALSE, quiet = TRUE)
res <- as.data.frame(DESeq2::results(dds, contrast = c("condition", "treated", "control"), alpha = 0.05, independentFiltering = FALSE, cooksCutoff = FALSE))
write.csv(res, "de-results.csv", row.names = TRUE, na = "NA")`
      const plotBody = (data: string, filename: string): string => `
png("${filename}", width = 640, height = 480)
plot(${data}$log2FoldChange, -log10(pmax(${data}$pvalue, 1e-300)), pch = 16,
     xlab = "log2 fold change: treated / control", ylab = "-log10 p-value", main = "Synthetic DESeq2")
abline(v = c(-1, 1), h = -log10(0.05), lty = 2)
dev.off()`
      const plotScript =
        'plotData <- read.csv("de-results.csv", row.names = 1)\n' +
        plotBody('plotData', 'volcano.png')
      const memoryScript = plotBody('res', 'memory-volcano.png')
      const activities: Array<{ run: NotebookRunRecord; runIndex: number; evidenceJson: string }> =
        []
      const analyzer = createNotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => activities.map(({ run }) => run) },
        resolveInterpreter: async () => ({ command })
      })
      for (const [runIndex, script] of [
        cleanScript,
        deScript,
        plotScript,
        memoryScript
      ].entries()) {
        const running: NotebookRunRecord = {
          runId: ['clean', 'de', 'plot', 'memory-plot'][runIndex]!,
          cellId: 'cell-' + runIndex,
          kernelKind: 'r',
          kernelEpochId: 'epoch',
          kernelDispatched: true,
          source: 'agent',
          script,
          status: 'running',
          startedAt: runIndex,
          cwdBefore: document.dataRoot,
          messageBranchId: 'branch',
          promptMessageId: 'prompt-' + runIndex,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: [],
          inputFiles: runIndex === 0 ? inputs : []
        }
        const { run } = await new NotebookRunTerminalizationOwner({
          repository: new NotebookRunRepository(storageRoot),
          notifyChanged: () => undefined
        }).run({
          session,
          runningRun: running,
          invoke: async () => {
            const sourceFileAccessContext = await analyzer.sourceFileAccessContext({
              projectId: session.projectId,
              sessionId: session.sessionId,
              currentRunId: running.runId,
              language: 'r',
              kernelEpochId: 'epoch'
            })
            if (runIndex < 3) {
              const access = await analyzeNotebookSourceFileAccess(
                'r',
                script,
                sourceFileAccessContext
              )
              expect(access, JSON.stringify({ runId: running.runId, access })).toMatchObject({
                readState: 'complete',
                writeState: 'complete',
                externalState: 'complete',
                reasonCodes: []
              })
            }
            const observer = await startWorkingFileObservation({
              dataRoot: document.dataRoot,
              notebookSessionRoot: document.notebookSessionRoot,
              cwd: document.dataRoot,
              code: script,
              language: 'r',
              runId: running.runId,
              registeredInputFiles: running.inputFiles,
              fileEvidenceStorageRoot: storageRoot,
              fileEvidenceRoot: evidenceLocation.root,
              fileEvidenceStoragePrefix: evidenceLocation.storageKeyPrefix,
              sourceFileAccessContext
            })
            let response: KernelLoopResponse
            let evidence: Awaited<ReturnType<typeof observer.finish>>
            try {
              response = await send(script)
            } finally {
              evidence = await observer.finish()
            }
            expect(response.error, running.runId).toBeNull()
            if (runIndex < 3) {
              expect(
                evidence.fileEvidence,
                JSON.stringify({ runId: running.runId, evidence })
              ).toMatchObject({
                state: 'available',
                fileReads: 'complete',
                writerAttribution: 'complete',
                reasonCodes: []
              })
            }
            return {
              status: 'completed',
              stdout: response.stdout,
              stderr: response.stderr,
              traceback: '',
              cwdAfter: document.dataRoot,
              outputs: [],
              ...evidence
            }
          }
        })
        activities.push({
          run,
          runIndex,
          evidenceJson: await readFile(join(storageRoot, run.fileEvidence!.storageKey!), 'utf8')
        })
      }
      expect(activities[0]!.run.inputFiles).toEqual(
        inputs.map((input) =>
          expect.objectContaining({
            inputFileVersionId: input.inputFileVersionId,
            accessEvidence: 'file-evidence'
          })
        )
      )
      // Derive dependency edges through the production dependency analyzer, including
      // the negative case's real res object. No authoritative graph edges are supplied by hand.
      const projection = await createNotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => activities.map(({ run }) => run) }
      }).project({ ...session, completedRun: activities.at(-1)!.run, interpreter: { command } })
      expect(projection.dependenciesByRunId?.['plot'], JSON.stringify(projection)).toEqual([])
      expect(projection.dependenciesByRunId?.['memory-plot'], JSON.stringify(projection)).toContain(
        'de'
      )
      const recipeFor = (
        producerIndex: number,
        filename: string
      ): {
        output: NotebookRunRecord['workingFiles'][number]
        graph: ReturnType<typeof sealArtifactProvenanceGraph>
        recipe: ReturnType<typeof reproductionRecipes.sealArtifactReproducibilityRecipe>
      } => {
        const producer = activities[producerIndex]!.run
        const output = producer.workingFiles.find(
          (file) => file.relativePath === 'data/' + filename
        )!
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: 'version-' + producer.runId,
            filename,
            checksum: output.checksum!,
            sizeBytes: output.size!,
            producerRunId: producer.runId,
            sourceGenerationId: output.generationId
          },
          notebookActivities: activities.slice(0, producerIndex + 1),
          computeActivities: [],
          notebookDependencies: projection
        })
        return {
          output,
          graph,
          recipe: reproductionRecipes.sealArtifactReproducibilityRecipe({
            provenanceGraph: graph,
            inputFiles: inputs,
            runs: activities.map(({ run, runIndex }) => ({
              runId: run.runId,
              runIndex,
              agentFrameId: 'agent',
              messageBranchId: 'branch',
              runtimeSegmentId: 'runtime',
              promptMessageId: 'prompt-' + runIndex,
              kernelEpochId: 'epoch',
              kernelKind: 'r',
              environmentName: 'deseq2-test',
              // Injected runtime requirement, not a captured/restored native environment lock.
              // This case proves capture, safe frontier selection and actual statistical replay.
              environmentLock: {
                state: 'available',
                format: 'environment-lock-bundle',
                lockChecksum: 'a'.repeat(64)
              },
              script: run.script,
              status: 'completed',
              startedAt: '2026-10-19T00:00:00.000Z',
              completedAt: '2026-10-19T00:00:01.000Z',
              outputs: [],
              inputFileVersionKeys: []
            }))
          })
        }
      }
      const { output, graph, recipe } = recipeFor(2, 'volcano.png')
      const diagnostic = JSON.stringify({ projection, graph, recipe }, null, 2)
      if (process.env.OPEN_SCIENCE_TEST_DESEQ2_DIAGNOSTICS) {
        await writeFile(process.env.OPEN_SCIENCE_TEST_DESEQ2_DIAGNOSTICS, diagnostic)
      }
      expect(graph.completeness).toBe('complete')
      expect(recipe.capture).toEqual({ state: 'sealed', reasonCodes: [] })
      expect(reproductionRecipes.artifactReproducibilityRecipeValue(recipe), diagnostic).toBe(true)
      const originalResults = await readFile(join(document.dataRoot, 'de-results.csv'))
      const verification = await execute(
        command,
        [
          '--vanilla',
          '-e',
          `
res <- read.csv("de-results.csv", row.names = 1)
stopifnot(nrow(res) == 1001, all(c("baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj") %in% names(res)), is.na(res["gene1001", "pvalue"]))
`
        ],
        { cwd: document.dataRoot, timeout: 30_000 }
      )
      expect(verification.stderr).toBe('')
      // Remove every live original and cleaned input before either replay. Only immutable
      // crossing generations from the selected plan may be materialized into a fresh directory.
      await rm(join(document.dataRoot, 'inputs'), { recursive: true })
      for (const filename of ['clean-counts.csv', 'clean-metadata.csv']) {
        await rm(join(document.dataRoot, filename))
      }
      for (const [frontierId, expectedSteps, expectedFiles] of [
        ['checkpoint:clean', ['de', 'plot'], ['data/clean-counts.csv', 'data/clean-metadata.csv']],
        ['checkpoint:de', ['plot'], ['data/de-results.csv']]
      ] as const) {
        const plan = reproductionRecipes.resolveArtifactReproducibilityExecutionPlan(
          recipe,
          frontierId
        )
        expect(
          plan?.steps.map((step) => step.activityId),
          diagnostic
        ).toEqual(expectedSteps)
        expect(plan?.frontier.claimScope).toBe('downstream-only')
        expect(plan?.frontier.crossingFiles.map((file) => file.materializationPath).sort()).toEqual(
          [...expectedFiles].sort()
        )
        const replay = join(storageRoot, frontierId.replace(':', '-'))
        for (const file of plan!.frontier.crossingFiles) {
          const bytes = await readFile(join(storageRoot, file.contentStorageKey))
          expect(hash(bytes)).toBe(file.checksum)
          const destination = join(replay, file.materializationPath)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, bytes)
        }
        const replayDataRoot = join(replay, 'data')
        for (const step of plan!.steps) {
          if (step.kind !== 'notebook-run') throw new Error('Expected a Notebook replay step')
          const script = activities.find(({ run }) => run.runId === step.activityId)!.run.script
          expect(hash(script)).toBe(step.sourceChecksum)
          await execute(command, ['--vanilla', '-e', script], {
            cwd: replayDataRoot,
            timeout: 60_000
          })
        }
        expect(await readFile(join(replayDataRoot, 'de-results.csv'))).toEqual(originalResults)
        expect(hash(await readFile(join(replayDataRoot, 'volcano.png')))).toBe(output.checksum)
      }
      const memory = recipeFor(3, 'memory-volcano.png')
      expect(memory.graph.edges).toContainEqual(
        expect.objectContaining({
          kind: 'depends-on',
          activityId: 'memory-plot',
          dependencyActivityId: 'de',
          authority: 'authoritative',
          evidenceSource: 'dependency-analysis'
        })
      )
      expect(memory.recipe.frontiers).toContainEqual(
        expect.objectContaining({
          frontierId: 'checkpoint:de',
          reasonCodes: expect.arrayContaining(['advisory-dependency'])
        })
      )
      expect(
        reproductionRecipes.resolveArtifactReproducibilityExecutionPlan(
          memory.recipe,
          'checkpoint:de'
        )
      ).toBeUndefined()
      // The very same memory-only plot fails in a cold process; saved CSV bytes cannot supply res.
      await expect(
        execute(command, ['--vanilla', '-e', memoryScript], {
          cwd: join(storageRoot, 'checkpoint-de', 'data'),
          timeout: 30_000,
          env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
        })
      ).rejects.toMatchObject({ stderr: expect.stringContaining("object 'res' not found") })
    } finally {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
      lines.close()
      await rm(storageRoot, { recursive: true, force: true })
    }
  },
  180_000
)
