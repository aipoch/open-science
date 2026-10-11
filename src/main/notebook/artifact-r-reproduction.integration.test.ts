import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'

import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

import { spawnSync } from 'node:child_process'

import { createHash } from 'node:crypto'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { dirname, join } from 'node:path'

import { expect, it } from 'vitest'

import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'

import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'

import { reproductionRecipes } from '../artifacts/reproducibility-host'

import { EnvironmentStateTracker } from '@aipoch/environment'

import { frameRRequest, parseLoopResponse } from './kernel-protocol'

import { resolveMicromamba } from '@aipoch/environment'

import { notebookPromptInputPath } from './prompt-input-materialization'

import { startWorkingFileObservation } from './working-file-observer'

import { rCallbackPlot } from './reported-r-callback.fixture'

import { combinedPlot } from './reported-r-composition.fixture'

const source = [
  'library(ggplot2)',
  'df <- read.csv("inputs/sample-groups-666666666666.csv")',
  'counts <- as.data.frame(table(df$group))',
  'colnames(counts) <- c("group", "n")',
  'print(counts)',
  'p <- ggplot(counts, aes(x = "", y = n, fill = group)) +',
  '  geom_bar(stat = "identity", width = 1, color = "white") +',
  '  coord_polar(theta = "y") +',
  '  scale_fill_manual(values = c(Ctrl = "#4C72B0", IRI = "#DD8452")) +',
  '  geom_text(aes(label = sprintf("%s\\n%d (%.1f%%)", group, n, 100 * n / sum(n))),',
  '            position = position_stack(vjust = 0.5),',
  '            color = "white", fontface = "bold", size = 5) +',
  '  labs(title = sprintf("Sample composition by group (n=%d)", sum(counts$n))) +',
  '  theme_void(base_size = 14) +',
  '  theme(plot.title = element_text(hjust = 0.5), legend.position = "none")',
  'ggsave("group_pie_r.png", p, width = 6, height = 6, dpi = 150)',
  'cat("saved: data/group_pie_r.png\\n")'
].join('\n')

const sineSource = String.raw`library(ggplot2)
x <- seq(0, 2 * pi, length.out = 1000)
y <- sin(x)
df <- data.frame(x = x, y = y)
p <- ggplot(df, aes(x = x, y = y)) +
  geom_line(color = "#1f77b4", linewidth = 1) +
  geom_hline(yintercept = 0, color = "#888888", linewidth = 0.4) +
  geom_vline(xintercept = pi, color = "#888888", linewidth = 0.3, linetype = "dashed", alpha = 0.6) +
  scale_x_continuous(
    breaks = c(0, pi/2, pi, 3*pi/2, 2*pi),
    labels = c("0", expression(pi/2), expression(pi), expression(3*pi/2), expression(2*pi))
  ) +
  coord_cartesian(ylim = c(-1.2, 1.2)) +
  labs(title = "Sine Wave", x = "x (radians)", y = "sin(x)") +
  theme_minimal(base_size = 12) +
  theme(panel.grid.minor = element_blank(), panel.grid.major = element_line(alpha = 0.3))
out_path <- "sin_wave_r.png"
ggsave(out_path, p, width = 8, height = 4.5, dpi = 150)
cat("saved:", out_path, "\n")
`

const barSource = `suppressPackageStartupMessages({
  library(ggplot2)
})
df <- read.csv("inputs/sample-groups-666666666666.csv", stringsAsFactors = FALSE)
counts <- as.data.frame(table(df$group), stringsAsFactors = FALSE)
colnames(counts) <- c("group", "n")
print(counts)
p <- ggplot(counts, aes(x = group, y = n, fill = group)) +
  geom_col(width = 0.6, color = "white") +
  geom_text(aes(label = n), vjust = -0.6, size = 4, fontface = "bold") +
  scale_fill_manual(values = c(Ctrl = "#4C78A8", IRI = "#F58518")) +
  scale_y_continuous(limits = c(0, max(counts$n) * 1.15),
                     expand = expansion(mult = c(0, 0))) +
  labs(x = "Group", y = "Number of samples",
       title = sprintf("SYNTHETIC_GROUPS sample counts per group (n=%d)", sum(counts$n))) +
  theme_minimal(base_size = 12) +
  theme(legend.position = "none",
        panel.grid.major.x = element_blank(),
        plot.title = element_text(face = "bold"))
ggsave("group_bar_r.png", p, width = 6, height = 4.5, dpi = 150)
cat("saved group_bar_r.png\\n")`

const rPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV

it.skipIf(!process.env.RUN_KERNEL || !rPrefix).each([
  {
    name: 'row-indexed percentage labels after a failed cell',
    source: barSource.replace(
      'ggsave(',
      'for (i in seq_len(nrow(counts))) { pct <- counts$n[i] / sum(counts$n) * 100; print(sprintf("%.1f%%", pct)) }\nggsave('
    ),
    outputName: 'group_bar_r.png',
    failedScript: 'stop("expected failure")',
    expectedError: 'expected failure'
  },
  {
    name: 'patchwork composition with optional namespace probes',
    source: combinedPlot,
    outputName: 'synthetic_groups_group_combined.png',
    failedScript: 'stop("expected failure")',
    expectedError: 'expected failure'
  },
  {
    name: 'reported sine with mathematical labels',
    source: sineSource,
    outputName: 'sin_wave_r.png',
    failedScript: 'stop("expected failure")',
    expectedError: 'expected failure',
    readsInput: false
  },
  {
    name: 'shared callback analysis after a failed cell',
    source: rCallbackPlot,
    outputName: 'r_callback.png',
    failedScript: 'stop("expected failure")',
    expectedError: 'expected failure'
  },
  {
    name: 'pie after blocked install',
    source,
    outputName: 'group_pie_r.png',
    failedScript: 'install.packages("ggplot2")',
    expectedError: 'use manage_packages'
  },
  {
    name: 'reported bar after missing readr',
    source: barSource,
    outputName: 'group_bar_r.png',
    failedScript: barSource
      .replace('library(ggplot2)', 'library(ggplot2)\n  library(readr)')
      .replace(
        'read.csv("inputs/sample-groups-666666666666.csv", stringsAsFactors = FALSE)',
        'read_csv("inputs/sample-groups-666666666666.csv", show_col_types = FALSE)'
      ),
    expectedError: 'readr'
  }
])(
  'captures the real R $name, files, and usable lock',
  async ({ source: plotSource, outputName, failedScript, expectedError, readsInput = true }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'r-pie-capture-'))
    const sessionRoot = join(storageRoot, 'notebook')
    const dataRoot = join(sessionRoot, 'data')
    const content = 'group\n' + 'Ctrl\n'.repeat(33) + 'IRI\n'.repeat(33)
    const checksum = createHash('sha256').update(content).digest('hex')
    const inputPath = notebookPromptInputPath('sample-groups.csv', checksum)
    const script = plotSource.replace('inputs/sample-groups-666666666666.csv', inputPath)
    const failedCode = failedScript.replace('inputs/sample-groups-666666666666.csv', inputPath)
    const inputFiles: NotebookRunInputFile[] = [
      {
        inputFileVersionId: 'input-version',
        sourceKind: 'upload-version',
        sourceFileId: 'input-file',
        sourceProjectId: 'project',
        sourceSessionId: 'session',
        filename: 'sample-groups.csv',
        sizeBytes: Buffer.byteLength(content),
        checksum,
        storageKey: `notebook/data/${inputPath}`,
        association: 'turn-attached'
      }
    ]
    try {
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await writeFile(join(dataRoot, inputPath), content)
      await writeFile(join(dataRoot, 'inputs/unrelated.csv'), 'unused\n')
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        code: script,
        registeredInputFiles: inputFiles,
        language: 'r',
        runId: 'plot-run'
      })
      const execution = spawnSync(
        join(rPrefix!, 'bin/Rscript'),
        [join(__dirname, '../../../resources/notebook/r_loop.R')],
        {
          cwd: dataRoot,
          env: { ...process.env, OPEN_SCIENCE_RUNTIME_DIR: dirname(dirname(rPrefix!)) },
          input: Buffer.concat([
            frameRRequest('blocked-run', failedCode),
            frameRRequest('plot-run', script)
          ]),
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024
        }
      )
      const files = await observation.finish()
      expect(execution.error).toBeUndefined()
      expect(execution.status, execution.stderr).toBe(0)
      const responses = execution.stdout
        .split('\n')
        .map(parseLoopResponse)
        .filter((response) => response !== null)
      expect(responses[0]?.error).toContain(expectedError)
      const response = responses.find((item) => item?.reqId === 'plot-run')
      expect(response?.error).toBeNull()
      expect(response?.stdout).toContain(outputName)
      expect(files.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        externalPaths: 'complete',
        writerAttribution: 'complete',
        generationCount: outputName === 'r_callback.png' ? 3 : readsInput ? 2 : 1,
        reasonCodes: []
      })
      expect(files.confirmedReadPaths ?? []).toEqual(readsInput ? [`data/${inputPath}`] : [])
      const captured = await new EnvironmentStateTracker({
        dataRoot: storageRoot,
        resolveMicromamba: async () => resolveMicromamba()
      }).captureCompletedRun(
        {
          language: 'r',
          environmentName: 'default-r',
          runtimeSource: 'managed',
          command: join(rPrefix!, 'bin/Rscript'),
          condaPrefix: rPrefix
        },
        response?.environmentOverlay
      )
      expect(captured.environmentLock).toMatchObject({ state: 'available' })
      const output = files.workingFiles.find((file) => file.relativePath === `data/${outputName}`)!
      expect(output.checksum).toBeDefined()
      const run: NotebookRunRecord = {
        runId: 'plot-run',
        cellId: 'plot-cell',
        source: 'agent',
        kernelKind: 'r',
        kernelEpochId: 'epoch',
        environment: 'default-r',
        kernelDispatched: true,
        script,
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: files.workingFiles,
        inputFiles,
        fileEvidence: files.fileEvidence
      }
      const failedRun: NotebookRunRecord = {
        ...run,
        runId: 'blocked-run',
        cellId: 'failed-cell',
        status: 'failed',
        script: failedCode,
        startedAt: 0,
        endedAt: 0,
        fileEvidence: undefined,
        workingFiles: [],
        inputFiles: []
      }
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'version-plot',
          filename: outputName,
          checksum: output.checksum!,
          sizeBytes: output.size!,
          producerRunId: run.runId,
          sourceGenerationId: output.generationId
        },
        notebookActivities: [
          { run: failedRun, runIndex: 0 },
          {
            run,
            runIndex: 1,
            evidenceJson: await readFile(join(storageRoot, files.fileEvidence.storageKey!), 'utf8')
          }
        ],
        computeActivities: []
      })
      expect(graph.completeness).toBe('complete')
      const projection = await createNotebookDependencyAnalyzer({
        storageRoot,
        repository: {
          readSessionRuns: async () => [failedRun, run]
        }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
      expect(projection.stalenessByRunId['plot-run']).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.['plot-run']).toEqual([])
      const recipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles,
        runs: [failedRun, run].map((entry, runIndex) => ({
          runId: entry.runId,
          runIndex,
          agentFrameId: 'agent',
          messageBranchId: 'branch',
          runtimeSegmentId: 'runtime',
          promptMessageId: 'prompt',
          kernelEpochId: 'epoch',
          kernelKind: 'r' as const,
          environmentName: 'default-r',
          environmentLock: entry === run ? captured.environmentLock : undefined,
          script: entry.script,
          status: entry.status,
          startedAt: '2026-09-05T00:00:00.000Z',
          completedAt: '2026-09-05T00:00:01.000Z',
          outputs: [],
          inputFileVersionKeys: []
        }))
      })
      expect(recipe.frontiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ frontierId: 'original-inputs', reasonCodes: [] })
        ])
      )
      const plan = reproductionRecipes.resolveArtifactReproducibilityExecutionPlan(
        recipe,
        'original-inputs'
      )
      expect(plan).toMatchObject({
        steps: [{ activityId: run.runId }]
      })
      // Replay in a fresh process and workspace using only the plan's captured inputs.
      // The interpreter is the same read-only fixture; native restoration has its own suite.
      const replayRoot = join(storageRoot, 'replay')
      await mkdir(join(replayRoot, 'data'), { recursive: true })
      for (const file of plan!.frontier.crossingFiles) {
        const destination = join(replayRoot, 'data', file.materializationPath)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, await readFile(join(storageRoot, file.contentStorageKey)))
      }
      const replay = spawnSync(
        join(rPrefix!, 'bin/Rscript'),
        [join(__dirname, '../../../resources/notebook/r_loop.R')],
        {
          cwd: join(replayRoot, 'data'),
          input: frameRRequest('replay-run', script),
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024
        }
      )
      expect(replay.error).toBeUndefined()
      expect(replay.status, replay.stderr).toBe(0)
      expect(
        replay.stdout
          .split('\n')
          .map(parseLoopResponse)
          .find((item) => item?.reqId === 'replay-run')?.error
      ).toBeNull()
      expect(
        createHash('sha256')
          .update(await readFile(join(replayRoot, 'data', outputName)))
          .digest('hex')
      ).toBe(output.checksum)
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  },
  60_000
)

configureTestRuntimeMetadata()
