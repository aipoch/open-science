import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from '../../src/index'

it.each(['python', 'r'] as const)(
  'matches %s snapshot analysis with native file reads and writes',
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
        const analysis = await analyzeNotebookSourceFileAccess(language, script)
        expect(analysis).toMatchObject({ readState: 'complete', writeState: 'complete' })
        expect(analysis.reads).toEqual(['a.csv', 'b.csv'])
        expect(analysis.writes.slice().sort()).toEqual(['a.csv.copy', 'b.csv.copy'])
        await promisify(execFile)(
          command!,
          language === 'python' ? ['-c', script] : ['--vanilla', '-e', script],
          { cwd: dataRoot, timeout: 30_000 }
        )
        expect(
          (await readFile(join(dataRoot, 'a.csv.copy'), 'utf8')).replaceAll('\r\n', '\n')
        ).toBe('Ctrl\n')
        expect(
          (await readFile(join(dataRoot, 'b.csv.copy'), 'utf8')).replaceAll('\r\n', '\n')
        ).toBe('IRI\n')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  90000
)
