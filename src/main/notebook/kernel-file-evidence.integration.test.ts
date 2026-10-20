import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { frameRRequest, parseLoopResponse } from './kernel-protocol'
import { startWorkingFileObservation } from './working-file-observer'

const rCommand =
  process.env.OPEN_SCIENCE_TEST_R_COMMAND ??
  (process.env.OPEN_SCIENCE_TEST_R_ENV
    ? join(process.env.OPEN_SCIENCE_TEST_R_ENV, 'bin/Rscript')
    : undefined)

it.skipIf(process.env.RUN_KERNEL !== '1' || !rCommand).each([
  {
    name: 'restored graphics parameters',
    script: 'old <- par(no.readonly=TRUE)\npng("plot.png"); plot(values); dev.off(); par(old)',
    outputs: ['plot.png']
  },
  {
    name: 'device copy',
    script: 'plot(values)\ndev.copy(png,filename="plot.png"); dev.off()',
    outputs: ['plot.png']
  },
  {
    name: 'multiple explicit devices',
    script: 'png("plot.png"); plot(values); dev.off()\npdf("plot.pdf"); plot(values); dev.off()',
    outputs: ['plot.pdf', 'plot.png']
  }
])(
  'keeps $name inside the R kernel device and evidence contract',
  async ({ script, outputs }) => {
    const root = await mkdtemp(join(tmpdir(), 'kernel-device-evidence-'))
    const dataRoot = join(root, 'data')
    const figuresRoot = join(root, 'figures')
    const code = 'values <- scan("inputs/values.txt",quiet=TRUE)\n' + script
    try {
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await mkdir(figuresRoot)
      await writeFile(join(dataRoot, 'inputs/values.txt'), '1 2 3')
      await writeFile(join(dataRoot, 'plot.png'), 'old generation')
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: root,
        fileEvidenceStorageRoot: root,
        cwd: dataRoot,
        code,
        language: 'r',
        runId: 'run'
      })
      const execution = promisify(execFile)(
        rCommand!,
        ['--vanilla', join(__dirname, '../../../resources/notebook/r_loop.R')],
        {
          cwd: dataRoot,
          timeout: 30000,
          env: { ...process.env, OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresRoot },
          maxBuffer: 8 * 1024 * 1024
        }
      )
      execution.child.stdin!.end(frameRRequest('run', code))
      const { stdout } = await execution
      const response = stdout
        .split('\n')
        .map(parseLoopResponse)
        .find((item) => item?.reqId === 'run')
      expect(response).toMatchObject({ error: null })
      const evidence = await observation.finish()
      expect(evidence.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete',
        reasonCodes: []
      })
      expect(evidence.confirmedReadPaths).toEqual(['data/inputs/values.txt'])
      expect(evidence.workingFiles.map((file) => file.relativePath).sort()).toEqual(
        outputs.map((name) => `data/${name}`)
      )
      expect(await readdir(dataRoot)).not.toContain('Rplots.pdf')
      for (const name of outputs) {
        const bytes = await readFile(join(dataRoot, name))
        expect(
          name.endsWith('.png') ? bytes.subarray(1, 4).toString() : bytes.subarray(0, 4).toString()
        ).toBe(name.endsWith('.png') ? 'PNG' : '%PDF')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  45000
)

configureTestRuntimeMetadata()
