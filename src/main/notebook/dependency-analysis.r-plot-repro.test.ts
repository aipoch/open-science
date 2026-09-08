import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'
import {
  resolveArtifactReproducibilityExecutionPlan,
  sealArtifactReproducibilityRecipe
} from '../artifacts/artifact-reproducibility-recipe'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { EnvironmentStateTracker } from './environment-state-tracker'
import { frameRRequest, parseLoopResponse } from './kernel-protocol'
import { resolveMicromamba } from './micromamba'
import { notebookPromptInputPath } from './prompt-input-materialization'
import { analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { startWorkingFileObservation } from './working-file-observer'
import { rCallbackPlot } from './reported-r-callback.fixture'
import { combinedPlot } from './reported-r-composition.fixture'
import { rBasePlots } from './reported-r-base-plots.fixture'
import { rThemePlots } from './reported-r-theme-plots.fixture'

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

describe('reported R CSV pie chart capture', () => {
  it.each(['margin', 'margin_auto', 'margin_part', 'rel'])(
    'analyzes the theme dimension constructor %s and its argument dependencies',
    async (name) => {
      for (const source of [
        `library(ggplot2); result <- ${name}(10)`,
        `result <- ggplot2::${name}(10)`
      ]) {
        expect((await analyzeRSources([source]))[0]).toMatchObject({ state: 'available' })
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete'
        })
      }
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `ggplot2::${name}(as.numeric(readLines("inputs/dimensions.txt")))`
        )
      ).toMatchObject({
        reads: ['inputs/dimensions.txt']
      })
      for (const source of [
        `library(ggplot2); ${name} <- custom; ${name}(10)`,
        `other::${name}(10)`,
        `ggplot2::${name}(custom())`
      ]) {
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          externalState: 'partial'
        })
      }
    }
  )
  it('captures the reported themed pie and bar plots', async () => {
    // The only external state is the CSV read, resolved by the captured input.
    expect((await analyzeRSources([rThemePlots]))[0]).toMatchObject({
      state: 'unknown',
      reasons: ['external-state']
    })
    expect(await analyzeNotebookSourceFileAccess('r', rThemePlots)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/sample-groups-666666666666.csv'],
      writes: ['synthetic_groups_bar_ggplot.png', 'synthetic_groups_pie_ggplot.png']
    })
  })
  it.each([
    'library(ggplot2); theme(plot.margin = margin(10,10,10,10))',
    'suppressPackageStartupMessages({library(ggplot2)}); theme(plot.margin = margin(10,10,10,10))',
    'pretty(c(0,33*1.2),6)',
    'print(list.files(pattern="ggplot"))'
  ])('isolates the reported theme analysis: %s', async (source) => {
    expect((await analyzeRSources([source]))[0]).toMatchObject({ state: 'available' })
  })
  it.each([
    'graphics::text(1, 1, labels="a")',
    'mtext("caption")',
    'graphics::mtext("caption")',
    'graphics::barplot(c(1, 2))'
  ])('recognizes the base graphics namespace: %s', async (script) => {
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete'
    })
  })
  it.each([
    'other::text(1,1)',
    'grDevices::text(1,1)',
    'text(1,1,labels=custom())',
    'text <- function(...) custom(); text(1,1)'
  ])('keeps unknown graphics calls conservative: %s', async (script) => {
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'partial'
    })
  })
  it('retains file dependencies inside annotation arguments', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'graphics::text(1,1,labels=readLines("inputs/labels.txt"))'
      )
    ).toMatchObject({ reads: ['inputs/labels.txt'] })
  })
  it.each([
    'text(1, 1, labels="a")',
    'positions <- barplot(c(1, 2))',
    'values <- as.integer(c(1, 2))'
  ])('isolates base graphics analysis: %s', async (script) => {
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete'
    })
  })
  it('captures the reported base R pie and bar charts with numeric annotations', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', rBasePlots)).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/sample-groups-666666666666.csv'],
      writes: ['synthetic_groups_group1_bar_r.png', 'synthetic_groups_group1_pie_r.png'],
      reasonCodes: []
    })
  })
  it('captures the reported sine plot with mathematical axis labels', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', sineSource)).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['sin_wave_r.png'],
      reasonCodes: []
    })
    expect((await analyzeRSources([sineSource]))[0]).toMatchObject({
      state: 'available'
    })
  })
  it.each([
    'expression(pi / 2)',
    'seq(0, 2 * pi, length.out = 1000)',
    'sin(c(0, 1))',
    'ggplot2::element_line(alpha = 0.3)',
    'ggplot2::scale_x_continuous(labels = c("0", expression(pi)))'
  ])('captures mathematical plotting expression: %s', async (code) => {
    expect(await analyzeNotebookSourceFileAccess('r', `value <- ${code}`)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reasonCodes: []
    })
  })

  it.each(['expression', 'quote', 'base::expression', 'base::quote'])(
    'does not execute symbols, assignments or file calls inside %s',
    async (constructor) => {
      const script = `label <- ${constructor}({hidden <- read.csv("inputs/not-read.csv"); write.csv(hidden, "not-written.csv"); alpha + beta})`
      const [facts] = await analyzeRSources([script])
      expect(facts).toMatchObject({ state: 'available', definedNames: ['label'], mutatedNames: [] })
      expect(facts?.usedNames).toEqual([constructor])
      expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [],
        writes: [],
        reasonCodes: []
      })
    }
  )
  it.each([
    'axis_labels <- expression(alpha, beta); ggplot2::scale_x_continuous(labels = axis_labels)',
    'axis_labels <- c("0", expression(alpha)); ggplot2::scale_x_continuous(labels = axis_labels)',
    'axis_labels <- quote(alpha); ggplot2::labs(title = axis_labels)',
    'ggplot2::scale_x_continuous(labels = function(x) expression(alpha, beta))',
    'ggplot2::geom_hline(yintercept=0)',
    'ggplot2::geom_vline(xintercept=pi)',
    'ggplot2::geom_abline(slope=1, intercept=0)'
  ])('captures literal scientific labels and reference lines: %s', async (script) => {
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reasonCodes: []
    })
  })
  it.each([
    'eval(expression(read.csv("inputs/hidden.csv")))',
    'eval(quote(read.csv("inputs/hidden.csv")))',
    'expression <- function(x) custom_reader(); expression(alpha)',
    'quote <- custom_reader; quote(alpha)',
    'custom::expression(alpha)',
    'ggplot2::scale_x_continuous(labels = function(expression) expression(alpha))',
    'axis_labels <- expression(alpha); axis_labels <- unknown_formatter; ggplot2::scale_x_continuous(labels = axis_labels)',
    'ggplot2::geom_hline(data=function(x) read.csv("inputs/hidden.csv"))',
    'ggplot2::geom_vline(xintercept=custom_intercept())',
    'geom_abline <- function(...) custom_reader(); geom_abline(slope=1)'
  ])('keeps actual evaluation and replaced constructors conservative: %s', async (script) => {
    expect((await analyzeNotebookSourceFileAccess('r', script)).readState).toBe('partial')
  })

  it('keeps the reported sine output and dependency path complete after an unrelated failure', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'r-sine-evidence-'))
    const sessionRoot = join(storageRoot, 'notebook')
    const dataRoot = join(sessionRoot, 'data')
    try {
      await mkdir(dataRoot, { recursive: true })
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        code: sineSource,
        registeredInputFiles: [],
        language: 'r',
        runId: 'sine-run'
      })
      // Simulate the worker's output; the production observer captures its bytes and source contract.
      await writeFile(join(dataRoot, 'sin_wave_r.png'), 'rendered-image-fixture')
      const files = await observation.finish()
      expect(files.fileEvidence.state).toBe('available')
      const output = files.workingFiles.find((file) => file.relativePath === 'data/sin_wave_r.png')!
      expect(output.checksum).toBeDefined()
      const run: NotebookRunRecord = {
        runId: 'sine-run',
        cellId: 'sine-cell',
        source: 'agent',
        kernelKind: 'r',
        kernelEpochId: 'epoch',
        environment: 'default-r',
        kernelDispatched: true,
        script: sineSource,
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: files.workingFiles,
        inputFiles: [],
        fileEvidence: files.fileEvidence
      }
      const failedRun: NotebookRunRecord = {
        ...run,
        runId: 'failed-run',
        cellId: 'failed-cell',
        script: 'stop("failure")',
        status: 'failed',
        startedAt: 0,
        endedAt: 0,
        workingFiles: [],
        fileEvidence: undefined
      }
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'sine-version',
          filename: 'sin_wave_r.png',
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
      const projection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => [failedRun, run] }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
      expect(projection.stalenessByRunId[run.runId]).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.[run.runId]).toEqual([])
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('captures the reported wrapped-library bar chart', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', barSource)).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/sample-groups-666666666666.csv'],
      writes: ['group_bar_r.png'],
      reasonCodes: []
    })
    expect((await analyzeRSources([barSource]))[0]).toMatchObject({
      state: 'unknown',
      reasons: ['external-state']
    })
  })
  it.each([
    'suppressPackageStartupMessages({ library(ggplot2) })',
    'library(ggplot2); p <- scale_y_continuous(expand = expansion(mult = c(0, 0)))',
    'library(ggplot2); p <- theme(panel.grid.major.x = element_blank())'
  ])('isolates the reported R expression: %s', async (script) => {
    const [facts] = await analyzeRSources([script])
    expect(facts?.state === 'unknown' ? facts.reasons : []).toEqual([])
  })
  it.each([
    'suppressPackageStartupMessages',
    'suppressMessages',
    'suppressWarnings',
    'base::suppressMessages'
  ])('traces files and assignments inside %s', async (wrapper) => {
    const script = `${wrapper}({\n  df <- read.csv("inputs/groups.csv")\n  write.csv(df, "groups-copy.csv")\n})`
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/groups.csv'],
      writes: ['groups-copy.csv'],
      reasonCodes: []
    })
    expect((await analyzeRSources([script]))[0]?.definedNames).toContain('df')
    expect(
      await analyzeNotebookSourceFileAccess('r', `${wrapper}({ custom_reader() })`)
    ).toMatchObject({ readState: 'partial' })
  })
  it.each([
    'suppressMessages <- function(expr) custom_reader(); suppressMessages(read.csv("inputs/groups.csv"))',
    'custom::suppressMessages(read.csv("inputs/groups.csv"))',
    'library(ggplot2); p <- expansion(mult = custom_range())',
    'library(ggplot2); expansion <- function(...) custom_range(); p <- expansion(mult=c(0, 0))'
  ])('retains unknown effects inside or replacing wrappers: %s', async (script) => {
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'partial'
    })
  })
  it('does not certify a named deferred formatter defined in the same run', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'library(ggplot2); formatter <- function(x) custom_reader(); p <- scale_y_continuous(labels=formatter)'
      )
    ).toMatchObject({ readState: 'partial' })
  })
  it.each([
    'labels = function(x) custom_reader()',
    'breaks = custom_breaks',
    'limits = ~ custom_limits(.x)'
  ])('does not certify unknown deferred scale callbacks: %s', async (argument) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `library(ggplot2); p <- scale_y_continuous(${argument})`
      )
    ).toMatchObject({ readState: 'partial' })
  })
  it.each([
    'counts <- as.data.frame(table(c("Ctrl", "IRI")))',
    'counts <- data.frame(group = "Ctrl", n = 1); colnames(counts) <- c("group", "n")',
    'library(ggplot2); p <- scale_fill_manual(values = c(Ctrl = "red"))',
    'library(ggplot2); p <- geom_text(aes(label = sprintf("%s", group)), position = position_stack(vjust = 0.5))'
  ])('models the effects of %s', async (script) => {
    const [facts] = await analyzeRSources([script])
    expect(facts?.state === 'unknown' ? facts.reasons : []).toEqual([])
  })
  it('captures the input and output of the complete plotting cell', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/sample-groups-666666666666.csv'],
      writes: ['group_pie_r.png'],
      reasonCodes: []
    })
  })

  it('requires file evidence without adding unknown variable relationships', async () => {
    const [facts] = await analyzeRSources([source])
    expect(facts).toMatchObject({ state: 'unknown', reasons: ['external-state'] })
  })

  it.each(['names', 'colnames', 'rownames', 'dimnames', 'dim'])(
    'records %s replacement as a change to the target binding',
    async (name) => {
      const [facts] = await analyzeRSources([`${name}(counts) <- labels`])
      expect(facts).toMatchObject({ state: 'available', mutatedNames: ['counts'] })
      expect(facts?.usedNames).toEqual(expect.arrayContaining(['counts', 'labels', `${name}<-`]))
    }
  )

  it.each([
    '`colnames<-` <- function(x, value) custom(x); colnames(counts) <- labels',
    'custom::colnames(counts) <- labels',
    'custom(counts) <- labels',
    'library(ggplot2); p <- scale_fill_manual(values = custom_palette())'
  ])('keeps unmodeled effects conservative: %s', async (script) => {
    expect((await analyzeRSources([script]))[0]?.state).toBe('unknown')
  })

  it('invalidates consumers of renamed columns while preserving the copied data frame', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'r-column-replacement-'))
    try {
      const scripts = [
        'counts <- as.data.frame(table(c("Ctrl", "IRI")))',
        'copy <- counts',
        'before <- colnames(counts)',
        'copy_names <- colnames(copy)',
        'colnames(counts) <- c("group", "n")'
      ]
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const projection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: {
          readSessionRuns: async () => runs
        }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: runs.at(-1) })
      expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
      expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
      expect(projection.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
})

const dataMaskPipelineSource = `
library(dplyr)
library(ggplot2)
df <- read.csv("inputs/counts.csv")
counts <- count(df, group)
factor <- 2
counts <- mutate(counts, across(where(is.numeric), ~ .x / factor))
p <- ggplot(counts, aes(group, n)) + geom_col(data = ~ .x) +
  geom_errorbar(aes(ymin = n - 0.1, ymax = n + 0.1), width = 0.2)
write.csv(counts, "counts.csv", row.names = FALSE)
ggsave("counts.png", p, width = 6, height = 4, dpi = 100)
`

it('captures the complete data-mask and delayed-layer pipeline', async () => {
  expect(await analyzeNotebookSourceFileAccess('r', dataMaskPipelineSource)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/counts.csv'],
    writes: ['counts.csv', 'counts.png'],
    reasonCodes: []
  })
})

it.skipIf(!process.env.RUN_KERNEL || !process.env.OPEN_SCIENCE_TEST_R_COMMAND).each([
  {
    name: 'dplyr and ggplot2 pipeline',
    code: dataMaskPipelineSource,
    inputName: 'counts.csv',
    outputNames: ['counts.csv', 'counts.png']
  },
  {
    name: 'reported theme dimensions and two plots',
    code: rThemePlots,
    inputName: 'sample-groups-666666666666.csv',
    outputNames: ['synthetic_groups_bar_ggplot.png', 'synthetic_groups_pie_ggplot.png']
  },
  {
    name: 'theme variants, grid units, legends and transparent colours',
    code: rThemePlots
      .replace('p_pie <-', 'cols <- scales::alpha(cols, 0.8)\np_pie <-')
      .replaceAll('theme_minimal', 'theme_dark')
      .replaceAll('margin(10, 10, 10, 10)', 'margin_auto(10)')
      .replaceAll(
        'legend.position = "right"',
        'legend.position = "right", legend.key.size = grid::unit(5, "mm")'
      )
      .replaceAll(
        'scale_fill_manual(values = cols)',
        'scale_fill_manual(values = cols, guide = guide_legend(nrow = 2))'
      ),
    inputName: 'sample-groups-666666666666.csv',
    outputNames: ['synthetic_groups_bar_ggplot.png', 'synthetic_groups_pie_ggplot.png']
  }
])(
  'captures and replays the real $name',
  async ({ code, inputName, outputNames }) => {
    const root = await mkdtemp(join(tmpdir(), 'r-evaluation-pipeline-'))
    try {
      const content = `group\n${Array(33).fill('Ctrl\nIRI\n').join('')}`
      const run = async (directory: string): Promise<string[]> => {
        const dataRoot = join(directory, 'data')
        await mkdir(join(dataRoot, 'inputs'), { recursive: true })
        await writeFile(join(dataRoot, 'inputs', inputName), content)
        const observation = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot: directory,
          fileEvidenceStorageRoot: directory,
          cwd: dataRoot,
          code,
          registeredInputFiles: [
            {
              inputFileVersionId: 'input-v1',
              sourceKind: 'upload-version',
              sourceFileId: 'input',
              sourceProjectId: 'project',
              sourceSessionId: 'session',
              filename: inputName,
              sizeBytes: Buffer.byteLength(content),
              checksum: createHash('sha256').update(content).digest('hex'),
              storageKey: `data/inputs/${inputName}`,
              association: 'turn-attached'
            }
          ],
          language: 'r',
          runId: 'pipeline'
        })
        const execution = spawnSync(
          process.env.OPEN_SCIENCE_TEST_R_COMMAND!,
          [join(__dirname, '../../../resources/notebook/r_loop.R')],
          {
            cwd: dataRoot,
            input: frameRRequest('pipeline', code),
            encoding: 'utf8',
            timeout: 30000
          }
        )
        const captured = await observation.finish()
        expect(execution.error).toBeUndefined()
        expect(execution.status, execution.stderr).toBe(0)
        expect(
          execution.stdout
            .split('\n')
            .map(parseLoopResponse)
            .find((item) => item?.reqId === 'pipeline')?.error
        ).toBeNull()
        expect(captured.fileEvidence).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(captured.confirmedReadPaths).toEqual([`data/inputs/${inputName}`])
        expect(captured.workingFiles.map((file) => file.relativePath)).toEqual(
          expect.arrayContaining(outputNames.map((file) => `data/${file}`))
        )
        return Promise.all(
          outputNames.map(async (file) =>
            createHash('sha256')
              .update(await readFile(join(dataRoot, file)))
              .digest('hex')
          )
        )
      }
      const original = await run(join(root, 'original'))
      expect(await run(join(root, 'replay'))).toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)

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
      const projection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: {
          readSessionRuns: async () => [failedRun, run]
        }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
      expect(projection.stalenessByRunId['plot-run']).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.['plot-run']).toEqual([])
      const recipe = sealArtifactReproducibilityRecipe({
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
      const plan = resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')
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
