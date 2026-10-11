import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

import { expect, it } from 'vitest'

import { execFile } from 'node:child_process'

import { promisify } from 'node:util'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { startWorkingFileObservation } from './working-file-observer'

it.skipIf(!process.env.RUN_KERNEL).each(['python', 'r'] as const)(
  'captures %s snapshot iteration with real file reads and writes',
  async (language) => {
    const command =
      language === 'python'
        ? process.env.OPEN_SCIENCE_TEST_PYTHON
        : process.env.OPEN_SCIENCE_TEST_R_COMMAND
    expect(command).toBeTruthy()
    const root = await mkdtemp(join(tmpdir(), 'iteration-snapshot-'))
    const script =
      language === 'python'
        ? `paths = ["a.csv", "b.csv"]
for path in paths[::-1]:
    paths.clear()
    with open(path) as source:
        text = source.read()
    with open(path + ".copy", "w") as output:
        output.write(text)`
        : `paths <- c("a.csv", "b.csv")
for (path in paths[c(2,1)]) {
  paths[2] <- "missing.csv"
  writeLines(readLines(path), paste0(path, ".copy"))
}`
    try {
      for (const name of ['original', 'replay']) {
        const notebookSessionRoot = join(root, name)
        const dataRoot = join(notebookSessionRoot, 'data')
        await mkdir(dataRoot, { recursive: true })
        await writeFile(join(dataRoot, 'a.csv'), 'Ctrl\n')
        await writeFile(join(dataRoot, 'b.csv'), 'IRI\n')
        const observer = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot,
          cwd: dataRoot,
          language,
          code: script,
          runId: name
        })
        await promisify(execFile)(
          command!,
          language === 'python' ? ['-c', script] : ['--vanilla', '-e', script],
          { cwd: dataRoot, timeout: 30_000 }
        )
        const files = await observer.finish()
        expect(files.fileEvidence).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(files.confirmedReadPaths).toEqual(['data/a.csv', 'data/b.csv'])
        expect(files.workingFiles.map(({ relativePath }) => relativePath).sort()).toEqual([
          'data/a.csv.copy',
          'data/b.csv.copy'
        ])
        expect(await readFile(join(dataRoot, 'a.csv.copy'), 'utf8')).toBe('Ctrl\n')
        expect(await readFile(join(dataRoot, 'b.csv.copy'), 'utf8')).toBe('IRI\n')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

configureTestRuntimeMetadata()
