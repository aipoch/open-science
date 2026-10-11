import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'

import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

import { readFileSync } from 'node:fs'

import { execFile } from 'node:child_process'

import { createHash } from 'node:crypto'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { promisify } from 'node:util'

import { expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'

import type { NotebookDependencyProjection } from '@aipoch/notebook-analysis/contracts'

import { frameRRequest, parseLoopResponse } from './kernel-protocol'

import { startWorkingFileObservation } from './working-file-observer'

const cells = readFileSync(join(__dirname, 'reported-r-circlize.fixture.R'), 'utf8')
  .trim()
  .split('\n\n# %%\n\n')

const explorationCells = readFileSync(
  join(__dirname, 'reported-r-exploration-chord.fixture.R'),
  'utf8'
)
  .trim()
  .split('\n\n# %%\n\n')

const deviceCopyCells = readFileSync(join(__dirname, 'reported-r-device-copy.fixture.R'), 'utf8')
  .trim()
  .split('\n\n# %%\n\n')

const packageReplayCells = readFileSync(
  join(__dirname, 'reported-r-package-replay.fixture.R'),
  'utf8'
)
  .trim()
  .split('\n\n# %%\n\n')

const project = async (
  scripts: string[],
  failedIndex?: number
): Promise<NotebookDependencyProjection> => {
  const root = await mkdtemp(join(tmpdir(), 'circlize-analysis-'))
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'default-r',
    script,
    status: index === failedIndex ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: []
  }))
  try {
    return await createNotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'p', sessionId: 's', completedRun: runs.at(-1)! })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it
  .skipIf(
    process.env.RUN_KERNEL !== '1' ||
      !process.env.OPEN_SCIENCE_TEST_R_ENV ||
      !process.env.OPEN_SCIENCE_TEST_PYTHON
  )
  .each([
    { name: 'package-replay', script: packageReplayCells[6]!, filenames: ['chord_diagram.png'] },
    ...[3, 4].map((index) => ({
      name: `wrapper-${index}`,
      script: cells[index]!,
      filenames: [
        'chord_diagram.pdf',
        'chord_diagram.png',
        ...(index === 4 ? ['chord_diagram_legend.png'] : [])
      ]
    })),
    ...[4, 7].map((index) => ({
      name: `device-copy-${index}`,
      script: deviceCopyCells[index]!,
      filenames: ['chord_diagram.png']
    })),
    ...[3, 5, 8, 9].map((index) => ({
      name: `exploration-${index}`,
      script: [
        'set.seed(42)',
        explorationCells[0],
        explorationCells[2],
        explorationCells[index]
      ].join('\n'),
      filenames:
        index === 8
          ? ['chord_test.png']
          : index === 9
            ? ['test_a.png', 'test_b.png', 'test_c.png']
            : ['chord_diagram.png']
    }))
  ])(
  'captures and replays reported circlize $name in fresh R processes',
  async ({ script: caseScript, filenames, name: caseName }) => {
    const root = await mkdtemp(join(tmpdir(), 'native-circlize-'))
    const execute = promisify(execFile)
    const snapshots: string[][] = []
    let replayScript = caseScript
    if (caseName === 'package-replay') {
      const projection = await project(packageReplayCells)
      const required = new Set(['run-6'])
      const addDependencies = (runId: string): void => {
        for (const dependency of projection.dependenciesByRunId?.[runId] ?? []) {
          if (required.has(dependency)) continue
          required.add(dependency)
          addDependencies(dependency)
        }
      }
      addDependencies('run-6')
      expect([...required].sort()).toEqual(['run-2', 'run-6'])
      // Fix RNG at each test cell boundary: circlize can choose random colors.
      // Package restoration is the subject here, not implicit RNG-state replay.
      replayScript = packageReplayCells
        .filter((_, index) => required.has(`run-${index}`))
        .map((source) => `set.seed(42)\n${source}`)
        .join('\n')
    }
    try {
      for (const name of ['original', 'replay']) {
        const script =
          caseName === 'package-replay' && name === 'original'
            ? packageReplayCells.map((source) => `set.seed(42)\n${source}`).join('\n')
            : replayScript
        const sessionRoot = join(root, name)
        const dataRoot = join(sessionRoot, 'data')
        await mkdir(join(dataRoot, 'inputs'), { recursive: true })
        await execute(
          process.env.OPEN_SCIENCE_TEST_PYTHON!,
          [
            '-c',
            'import pandas as pd; pd.DataFrame([(f"Gene{i}",f"S{j}",float(i+j)) for i in range(1,7) for j in range(1,11)],columns=["from","to","value"]).to_excel("inputs/edge-weights-222222222222.xlsx",index=False,sheet_name="Sheet 1")'
          ],
          { cwd: dataRoot, timeout: 20000 }
        )
        if (name === 'original') {
          await writeFile(join(dataRoot, 'chord_diagram.png'), 'previous generation')
          await writeFile(join(dataRoot, 'chord_diagram.pdf'), 'previous generation')
        }
        const observation = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot: sessionRoot,
          cwd: dataRoot,
          code: script,
          language: 'r',
          runId: name
        })
        const figuresRoot = join(sessionRoot, 'figures')
        await mkdir(figuresRoot, { recursive: true })
        // Use the application's device lifecycle. Bare Rscript may open an
        // implicit Rplots.pdf when circlize restores par() after dev.off().
        const execution = execute(
          join(process.env.OPEN_SCIENCE_TEST_R_ENV!, 'bin/Rscript'),
          ['--vanilla', join(__dirname, '../../../resources/notebook/r_loop.R')],
          {
            cwd: dataRoot,
            timeout: 90000,
            env: { ...process.env, OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresRoot },
            maxBuffer: 8 * 1024 * 1024
          }
        )
        execution.child.stdin!.end(frameRRequest(name, script))
        const output = await execution
        const response = output.stdout
          .split('\n')
          .map(parseLoopResponse)
          .find((item) => item?.reqId === name)
        expect(response).toMatchObject({ error: null })
        expect(response?.stdout).not.toContain('FAIL test_')
        const evidence = await observation.finish()
        expect(evidence.fileEvidence).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(evidence.confirmedReadPaths).toEqual(['data/inputs/edge-weights-222222222222.xlsx'])
        expect(evidence.workingFiles.map((file) => file.relativePath).sort()).toEqual(
          filenames.map((file) => `data/${file}`).sort()
        )
        const hashes: string[] = []
        for (const filename of filenames) {
          const data = await readFile(join(dataRoot, filename))
          if (filename.endsWith('.png')) {
            expect(data.subarray(1, 4).toString()).toBe('PNG')
            hashes.push(createHash('sha256').update(data).digest('hex'))
          } else expect(data.subarray(0, 4).toString()).toBe('%PDF')
        }
        snapshots.push(hashes)
      }
      expect(snapshots[0]).toEqual(snapshots[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  240000
)

configureTestRuntimeMetadata()
