import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

import { expect, it } from 'vitest'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { startWorkingFileObservation } from './working-file-observer'

it('attributes only matching timestamped logs to the writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-log-'))
  const sessionRoot = join(root, 'notebook')
  const dataRoot = join(sessionRoot, 'data')
  try {
    await mkdir(dataRoot, { recursive: true })
    const observation = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        language: 'r',
        code: 'VennDiagram::venn.diagram(list(A=1:3,B=2:4),"plot.png",imagetype="png")',
        runId: 'run'
      },
      {
        watchDirectory: () => {
          throw new Error('unavailable')
        }
      }
    )
    await writeFile(join(dataRoot, 'plot.png'), 'image')
    await writeFile(join(dataRoot, 'plot.png.2026-09-09_10-01-02.log'), 'log')
    const evidence = await observation.finish()
    expect(evidence.fileEvidence, JSON.stringify(evidence)).toMatchObject({
      state: 'available',
      writerAttribution: 'complete'
    })
    expect(evidence.workingFiles.map((f) => f.relativePath).sort()).toEqual([
      'data/plot.png',
      'data/plot.png.2026-09-09_10-01-02.log'
    ])
    const second = await startWorkingFileObservation(
      {
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        language: 'r',
        code: 'VennDiagram::venn.diagram(list(A=1:3,B=2:4),"plot.png",imagetype="png")',
        runId: 'run2'
      },
      {
        watchDirectory: () => {
          throw new Error('unavailable')
        }
      }
    )
    await writeFile(join(dataRoot, 'plot.png.unrelated.log'), 'unrelated')
    expect((await second.finish()).fileEvidence.writerAttribution).not.toBe('complete')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

configureTestRuntimeMetadata()
