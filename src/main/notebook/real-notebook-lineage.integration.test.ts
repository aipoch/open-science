import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzePythonSources } from './dependency-analysis-python'
import { projectNotebookDependencies } from './dependency-projection'
import { NotebookKernelExecutor } from './kernel-executor'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

// This is intentionally opt-in: it exercises the shipped kernel loop against a provisioned local
// interpreter, creates real scientific outputs, and verifies the analyzer against those outputs.
// Run with RUN_REAL_NOTEBOOK=1 OPEN_SCIENCE_TEST_PY_ENV=/path/to/python npx vitest run <this file>.
const python = process.env.OPEN_SCIENCE_TEST_PY_ENV
const gate = process.env.RUN_REAL_NOTEBOOK && python ? describe : describe.skip
const pythonLoopPath = join(__dirname, '../../../resources/notebook/python_loop.py')
const analyzedPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

const cells = [
  `from pathlib import Path
import numpy as np
input_path = Path("inputs") / "counts.tsv"
counts = np.loadtxt(input_path, delimiter="\\t", skiprows=1)
print("shape", counts.shape)`,
  `from pathlib import Path
import matplotlib.pyplot as plt
normalized = counts / counts.sum(axis=0, keepdims=True)
np.savetxt(Path("outputs") / "normalized.tsv", normalized, delimiter="\\t", header="A\\tB", comments="")
plt.plot(normalized)
plt.scatter([0, 1], [0, 1])
plt.bar([0, 1], [1, 2], alpha=0.2)
plt.savefig(Path("outputs") / "qc.png")`
] as const

const imageCells = [
  `from pathlib import Path
from PIL import Image
import numpy as np
image = Image.open(Path("inputs") / "cells.pgm").convert("L")
pixels = np.asarray(image)
mask = pixels >= 128
print("foreground", int(mask.sum()))`,
  `from pathlib import Path
from PIL import Image
import matplotlib.pyplot as plt
result = Image.fromarray((mask * 255).astype("uint8"))
result.save(Path("outputs") / "mask.png")
plt.imshow(mask, cmap="gray")
plt.axis("off")
plt.savefig(Path("outputs") / "mask-qc.png")`
] as const

const runRecord = (script: string, index: number): NotebookRunRecord => ({
  runId: String(index),
  cellId: String(index),
  script,
  kernelKind: 'python',
  kernelEpochId: 'real-notebook',
  environment: 'local',
  source: 'agent',
  status: 'completed',
  kernelDispatched: true,
  startedAt: index,
  endedAt: index + 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

gate('real notebook execution and lineage', () => {
  it('captures outputs from a real numeric notebook and projects cell dependencies', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'real-notebook-lineage-'))
    const runtimeRoot = join(storageRoot, 'runtime')
    const notebookSessionRoot = join(storageRoot, 'notebook')
    const dataRoot = join(notebookSessionRoot, 'data')
    const inputPath = join(dataRoot, 'inputs', 'counts.tsv')
    const normalizedPath = join(dataRoot, 'outputs', 'normalized.tsv')
    const plotPath = join(dataRoot, 'outputs', 'qc.png')
    await mkdir(join(dataRoot, 'inputs'), { recursive: true })
    await mkdir(join(dataRoot, 'outputs'), { recursive: true })
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(
      inputPath,
      Buffer.from([65, 9, 66, 10, 49, 48, 9, 50, 48, 10, 51, 48, 9, 49, 48, 10])
    )
    const access = [
      await analyzeNotebookSourceFileAccess('python', cells[0]),
      await analyzeNotebookSourceFileAccess('python', cells[1], {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: ['counts', 'np']
      })
    ]
    const cell2Context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['counts', 'np']
    }
    const facts = await analyzePythonSources([...cells])
    const executor = new NotebookKernelExecutor({ pythonLoopPath })
    try {
      const results = []
      for (const [index, code] of cells.entries()) {
        results.push(
          await executor.execute({
            code,
            cwd: dataRoot,
            notebookSessionRoot,
            dataRoot,
            runtimeRoot,
            environment: 'local',
            resolvedInterpreter: { command: python! },
            runId: `real-run-${index}`,
            ...(index === 1 ? { sourceFileAccessContext: cell2Context } : {})
          })
        )
      }

      expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
      expect(results[0]?.stdout).toContain('shape (2, 2)')
      expect(results[1]?.outputs.some((output) => output.type === 'display')).toBe(true)
      expect((await stat(normalizedPath)).size).toBeGreaterThan(0)
      expect((await stat(plotPath)).size).toBeGreaterThan(0)
      expect(await readFile(normalizedPath, 'utf8')).toMatch(/2\.500+e-01/)
      expect(results[0]?.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete'
      })
      const readEvidence = JSON.parse(
        await readFile(join(storageRoot, results[0]!.fileEvidence!.storageKey!), 'utf8')
      ) as { relations: Array<{ relativePath: string }> }
      expect(readEvidence.relations.map((relation) => relation.relativePath)).toContain(
        'data/inputs/counts.tsv'
      )
      expect(results[1]?.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete'
      })
      expect(results[1]?.workingFiles?.map((file) => file.relativePath)).toEqual(
        expect.arrayContaining(['data/outputs/normalized.tsv', 'data/outputs/qc.png'])
      )

      expect(access[0]).toMatchObject({
        reads: [analyzedPath('inputs/counts.tsv')],
        readState: 'complete'
      })
      expect(access[1]).toMatchObject({
        writes: [analyzedPath('outputs/normalized.tsv'), analyzedPath('outputs/qc.png')],
        readState: 'complete',
        writeState: 'complete'
      })
      const projection = projectNotebookDependencies(
        cells.map((script, index) => ({ run: runRecord(script, index), facts: facts[index]! }))
      )
      expect(projection.dependenciesByRunId).toEqual({ '0': [], '1': ['0'] })
      expect(projection.stalenessByRunId).toEqual({
        '0': { state: 'clear' },
        '1': { state: 'clear' }
      })
    } finally {
      await executor.shutdown()
      await rm(storageRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it('captures a real image-mask workflow and its derived PNG outputs', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'real-image-lineage-'))
    const runtimeRoot = join(storageRoot, 'runtime')
    const notebookSessionRoot = join(storageRoot, 'notebook')
    const dataRoot = join(notebookSessionRoot, 'data')
    const inputPath = join(dataRoot, 'inputs', 'cells.pgm')
    const maskPath = join(dataRoot, 'outputs', 'mask.png')
    const qcPath = join(dataRoot, 'outputs', 'mask-qc.png')
    await mkdir(join(dataRoot, 'inputs'), { recursive: true })
    await mkdir(join(dataRoot, 'outputs'), { recursive: true })
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(inputPath, `P2\n4 3\n255\n0 255 0 255\n255 0 255 0\n0 255 255 0\n`)
    const imageContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['Image', 'Path', 'image', 'mask', 'np', 'pixels'],
      pythonBindings: [
        { name: 'Image', qualifiedName: 'PIL.Image', kind: 'import' as const },
        { name: 'Path', qualifiedName: 'pathlib.Path', kind: 'import' as const },
        { name: 'image', qualifiedName: 'PIL.Image.Image', kind: 'object' as const },
        { name: 'mask', qualifiedName: 'numpy.ndarray', kind: 'object' as const }
      ]
    }
    const access = [
      await analyzeNotebookSourceFileAccess('python', imageCells[0]),
      await analyzeNotebookSourceFileAccess('python', imageCells[1], imageContext)
    ]
    const executor = new NotebookKernelExecutor({ pythonLoopPath })
    try {
      const results = []
      for (const [index, code] of imageCells.entries()) {
        results.push(
          await executor.execute({
            code,
            cwd: dataRoot,
            notebookSessionRoot,
            dataRoot,
            runtimeRoot,
            environment: 'local',
            resolvedInterpreter: { command: python! },
            runId: `real-image-run-${index}`,
            ...(index === 1 ? { sourceFileAccessContext: imageContext } : {})
          })
        )
      }
      expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
      expect(results[0]?.stdout).toContain('foreground 6')
      expect((await stat(maskPath)).size).toBeGreaterThan(0)
      expect((await stat(qcPath)).size).toBeGreaterThan(0)
      expect(results[0]?.fileEvidence).toMatchObject({ state: 'available' })
      expect(results[1]?.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete'
      })
      expect(access[0]).toMatchObject({
        reads: [analyzedPath('inputs/cells.pgm')],
        readState: 'complete'
      })
      expect(access[1]).toMatchObject({
        writes: expect.arrayContaining([
          analyzedPath('outputs/mask.png'),
          analyzedPath('outputs/mask-qc.png')
        ]),
        readState: 'complete',
        writeState: 'complete'
      })
    } finally {
      await executor.shutdown()
      await rm(storageRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
