import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { NotebookKernelExecutor } from './kernel-executor'

// This opt-in integration test needs pandas and PyArrow in the selected interpreter.
const python = process.env.OPEN_SCIENCE_TEST_PARQUET_PY_ENV
const gate = process.env.RUN_REAL_NOTEBOOK && python ? describe : describe.skip
const pythonLoopPath = join(__dirname, '../../../resources/notebook/python_loop.py')

const cells = [
  `from pathlib import Path
import pandas as pd
records = pd.read_csv(Path("inputs") / "measurements.csv")
records.to_parquet(Path("work") / "measurements.parquet", index=False)
print("rows", len(records))`,
  `from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
records = pd.read_parquet(Path("work") / "measurements.parquet")
summary = records.groupby("group", as_index=False)["value"].mean()
summary.to_parquet(Path("outputs") / "summary_dataset", index=False, partition_cols=["group"])
summary.plot.bar(x="group", y="value")
plt.savefig(Path("outputs") / "summary.png")`
] as const

const analyzedPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

gate('real Parquet notebook execution and lineage', () => {
  it('captures a DataFrame intermediate and derived summary outputs', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'real-parquet-lineage-'))
    const runtimeRoot = join(storageRoot, 'runtime')
    const notebookSessionRoot = join(storageRoot, 'notebook')
    const dataRoot = join(notebookSessionRoot, 'data')
    const inputPath = join(dataRoot, 'inputs', 'measurements.csv')
    const intermediatePath = join(dataRoot, 'work', 'measurements.parquet')
    const outputPath = join(dataRoot, 'outputs', 'summary_dataset')
    const plotPath = join(dataRoot, 'outputs', 'summary.png')
    await mkdir(join(dataRoot, 'inputs'), { recursive: true })
    await mkdir(join(dataRoot, 'work'), { recursive: true })
    await mkdir(join(dataRoot, 'outputs'), { recursive: true })
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(inputPath, 'group,value\na,1\na,3\nb,2\nb,6\n')

    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['Path', 'pd', 'records'],
      pythonBindings: [
        { name: 'Path', qualifiedName: 'pathlib.Path', kind: 'import' as const },
        { name: 'records', qualifiedName: 'pandas.DataFrame', kind: 'object' as const }
      ]
    }
    const access = [
      await analyzeNotebookSourceFileAccess('python', cells[0]),
      await analyzeNotebookSourceFileAccess('python', cells[1], context)
    ]
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
            runId: `real-parquet-run-${index}`,
            ...(index === 1 ? { sourceFileAccessContext: context } : {})
          })
        )
      }
      expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
      expect(results[0]?.stdout).toContain('rows 4')
      expect((await stat(intermediatePath)).size).toBeGreaterThan(0)
      expect((await readdir(outputPath)).length).toBeGreaterThan(0)
      expect((await stat(plotPath)).size).toBeGreaterThan(0)
      expect(results[0]?.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete'
      })
      expect(results[1]?.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete'
      })
      expect(access[0]).toMatchObject({
        reads: [analyzedPath('inputs/measurements.csv')],
        writes: [analyzedPath('work/measurements.parquet')],
        readState: 'complete',
        writeState: 'complete'
      })
      expect(access[1]).toMatchObject({
        reads: [analyzedPath('work/measurements.parquet')],
        writes: expect.arrayContaining([
          analyzedPath('outputs/summary_dataset'),
          analyzedPath('outputs/summary.png')
        ]),
        writeScopes: [{ kind: 'directory', path: analyzedPath('outputs/summary_dataset') }],
        readState: 'complete',
        writeState: 'complete'
      })
      expect(await readdir(join(dataRoot, 'outputs'))).toEqual(
        expect.arrayContaining(['summary_dataset', 'summary.png'])
      )
    } finally {
      await executor.shutdown()
      await rm(storageRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
