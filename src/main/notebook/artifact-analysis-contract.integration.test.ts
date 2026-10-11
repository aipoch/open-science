import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'
import { startWorkingFileObservation } from './working-file-observer'

it.each([
  {
    script: 'png("sin_plot.png"); plot(1); dev.off(); list.files()',
    prior:
      'suppressPackageStartupMessages({ if (!requireNamespace("ggplot2", quietly=TRUE)) install.packages("ggplot2"); library(ggplot2) })',
    dispatched: false
  },
  {
    script: 'png("sin_plot.png"); plot(1); dev.off()',
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

it('keeps a captured output and dependency path complete after an unrelated failure', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'r-sine-evidence-'))
  const sessionRoot = join(storageRoot, 'notebook')
  const dataRoot = join(sessionRoot, 'data')
  try {
    await mkdir(dataRoot, { recursive: true })
    const observation = await startWorkingFileObservation({
      dataRoot,
      notebookSessionRoot: sessionRoot,
      cwd: dataRoot,
      code: 'png("sin_wave_r.png"); plot(1); dev.off()',
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
      script: 'png("sin_wave_r.png"); plot(1); dev.off()',
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
    const projection = await createNotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: async () => [failedRun, run] }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
    expect(projection.stalenessByRunId[run.runId]).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.[run.runId]).toEqual([])
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})

configureTestRuntimeMetadata()
