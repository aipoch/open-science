import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
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
import { reproductionRecipes } from '../artifacts/reproducibility-host'

import { createRootNotebookLane } from './lane-identity'
import { notebookPromptInputPath } from './prompt-input-materialization'
import { getNotebookFileEvidenceLocation, NotebookRunRepository } from './repository'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import {
  analyzeNotebookSourceFileAccess,
  analyzePythonFileAccesses
} from '@aipoch/notebook-analysis'
import { startWorkingFileObservation } from './working-file-observer'
import { reportedPythonPlots } from './reported-python-plots.fixture'

import { reportedSubplots, reportedSubplotsInput } from './reported-python-subplots.fixture'
import { rBasePlots } from './reported-r-base-plots.fixture'
import { frameRRequest, parseLoopResponse, type KernelLoopResponse } from './kernel-protocol'
import { EnvironmentStateTracker, parseNotebookEnvironmentLock } from '@aipoch/environment'
import { type ArtifactReproducibilityExecutionEvent } from '@aipoch/reproducibility'
import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import { NotebookKernelExecutor } from './kernel-executor'
import type { NotebookProcessSandbox } from './process-sandbox'
import { runMicromamba } from './environment-process'
import {
  createNotebookReproductionRuntime,
  executeArtifactReproducibility
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
