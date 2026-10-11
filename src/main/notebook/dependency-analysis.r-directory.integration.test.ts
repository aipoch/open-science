import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'

import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { execFile } from 'node:child_process'

import { promisify } from 'node:util'

import { expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'

import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'

import { startWorkingFileObservation } from './working-file-observer'

const sineSource = String.raw`suppressPackageStartupMessages(library(ggplot2))
x <- seq(-2 * pi, 2 * pi, length.out = 400)
df <- data.frame(x = x, y = sin(x))
breaks_pi <- c(-2, -1, 0, 1, 2) * pi
labels_pi <- c("-2π", "-π", "0", "π", "2π")
p <- ggplot(df, aes(x = x, y = y)) +
  geom_hline(yintercept = 0, color = "#666666", linewidth = 0.4) +
  geom_vline(xintercept = 0, color = "#666666", linewidth = 0.4) +
  geom_line(color = "#1f77b4", linewidth = 1.0) +
  scale_x_continuous(breaks = breaks_pi, labels = labels_pi, limits = c(-2 * pi, 2 * pi)) +
  scale_y_continuous(breaks = c(-1, -0.5, 0, 0.5, 1), limits = c(-1.2, 1.2)) +
  labs(title = "Sine Function", x = "x (radians)", y = "sin(x)") +
  theme_minimal(base_size = 12) +
  theme(panel.grid.major = element_line(color = "#e6e6e6", linewidth = 0.4),
        panel.grid.minor = element_blank())
ggsave("sin_plot.png", plot = p, width = 8, height = 4.5, dpi = 120)
cat("saved sin_plot.png\n")`

const reportedBaseSine = String.raw`x <- seq(0, 2*pi, length.out = 200)
y <- sin(x)
png("sin_plot.png", width = 960, height = 540, res = 120)
plot(x, y, type = "l", col = "#2E86AB", lwd = 2,
     main = "Sine Function", xlab = "x (radians)", ylab = "sin(x)", xaxt = "n")
axis(1, at = c(0, pi/2, pi, 3*pi/2, 2*pi), labels = c("0", "π/2", "π", "3π/2", "2π"))
abline(h = 0, col = "gray", lwd = 0.5)
abline(v = 0, col = "gray", lwd = 0.5)
grid(col = "lightgray", lty = 3)
legend("topright", legend = "sin(x)", col = "#2E86AB", lwd = 2, bty = "n")
dev.off()
cat("saved:", normalizePath("sin_plot.png"), "\n")
file.info("sin_plot.png")$size`

it.skipIf(process.env.RUN_KERNEL !== '1')(
  'captures the reported plot from native R with its diagnostics',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'r-plot-diagnostics-'))
    const sessionRoot = join(root, 'notebook')
    const dataRoot = join(sessionRoot, 'data')
    try {
      await mkdir(dataRoot, { recursive: true })
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        code: reportedBaseSine,
        registeredInputFiles: [],
        language: 'r',
        runId: 'native-sine'
      })
      const { stdout } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_TEST_R_COMMAND || 'Rscript',
        ['--vanilla', '-e', reportedBaseSine],
        { cwd: dataRoot, timeout: 15000 }
      )
      expect(stdout).toContain('sin_plot.png')
      const image = await readFile(join(dataRoot, 'sin_plot.png'))
      expect(image.subarray(1, 4).toString()).toBe('PNG')
      const result = await observation.finish()
      expect(result.fileEvidence).toMatchObject({ state: 'available' })
      expect(result.workingFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: 'data/sin_plot.png', size: image.length })
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  {
    script: sineSource + '\nlist.files(pattern = "sin_plot\\\\.png$")',
    prior:
      'suppressPackageStartupMessages({ if (!requireNamespace("ggplot2", quietly=TRUE)) install.packages("ggplot2"); library(ggplot2) })',
    dispatched: false
  },
  {
    script: reportedBaseSine,
    prior:
      'file.remove("data/sin_plot.png"); file.copy("data/sin_plot_r.png","data/sin_plot.png",overwrite=TRUE); file.remove("data/sin_plot_r.png"); list.files("data")',
    dispatched: true
  }
])(
  'captures the independent output after earlier operations: $prior',
  async ({ script, prior, dispatched }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'r-directory-evidence-'))
    const sessionRoot = join(storageRoot, 'notebook')
    const dataRoot = join(sessionRoot, 'data')
    try {
      await mkdir(dataRoot, { recursive: true })
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        code: script,
        registeredInputFiles: [],
        language: 'r',
        runId: 'sine-run'
      })
      // Exercise actual file capture and graph sealing without installing ggplot2.
      await writeFile(join(dataRoot, 'sin_plot.png'), 'rendered-image-fixture')
      const files = await observation.finish()
      expect(files.fileEvidence.state).toBe('available')
      const output = files.workingFiles.find((file) => file.relativePath === 'data/sin_plot.png')!
      expect(output.checksum).toBeDefined()
      const run: NotebookRunRecord = {
        runId: 'sine-run',
        cellId: 'sine-cell',
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
        workingFiles: files.workingFiles,
        inputFiles: [],
        fileEvidence: files.fileEvidence
      }
      const failedRun: NotebookRunRecord = {
        ...run,
        runId: 'blocked-run',
        cellId: 'blocked-cell',
        status: dispatched ? 'completed' : 'failed',
        kernelDispatched: dispatched,
        startedAt: 0,
        endedAt: 0,
        script: prior,
        workingFiles: [],
        fileEvidence: undefined
      }
      const diagnosticRun: NotebookRunRecord = {
        ...failedRun,
        runId: 'diagnostic-run',
        cellId: 'diagnostic-cell',
        status: 'completed',
        kernelDispatched: true,
        script:
          'cat("cwd:",getwd(),"\\n"); print(list.files(".",recursive=TRUE,pattern="png$")); print(list.files("data"))'
      }
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'sine-version',
          filename: 'sin_plot.png',
          checksum: output.checksum!,
          sizeBytes: output.size!,
          producerRunId: run.runId,
          sourceGenerationId: output.generationId
        },
        notebookActivities: [
          { run: failedRun, runIndex: 0 },
          { run: diagnosticRun, runIndex: 1 },
          {
            run,
            runIndex: 2,
            evidenceJson: await readFile(join(storageRoot, files.fileEvidence.storageKey!), 'utf8')
          }
        ],
        computeActivities: []
      })
      expect(graph.completeness).toBe('complete')
      const projection = await createNotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => [failedRun, diagnosticRun, run] }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
      expect(projection.stalenessByRunId[run.runId]).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.[run.runId]).toEqual([])
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  }
)

configureTestRuntimeMetadata()
