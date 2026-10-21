import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from '../../src/index'

const rCommand = process.env.OPEN_SCIENCE_TEST_R_COMMAND

const pythonCommand = process.env.OPEN_SCIENCE_TEST_PYTHON

it('matches inline Python selections and executes them in a fresh directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'python-inline-paths-'))
  const script = `import pandas as pd
df = pd.read_csv({"csv": "inputs/groups.csv"}["csv"])
df.to_csv(("unused.csv", "copy.csv")[-1], index=False)`
  try {
    const outputs = []
    for (const name of ['original', 'replay']) {
      const notebookSessionRoot = join(root, name)
      const dataRoot = join(notebookSessionRoot, 'data')
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await writeFile(join(dataRoot, 'inputs/groups.csv'), 'group\nCtrl\nIRI\n')
      expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        reads: ['inputs/groups.csv'],
        writes: ['copy.csv']
      })
      await promisify(execFile)(pythonCommand!, ['-c', script], {
        cwd: dataRoot,
        timeout: 30_000
      })
      outputs.push((await readFile(join(dataRoot, 'copy.csv'), 'utf8')).replaceAll('\r\n', '\n'))
    }
    expect(outputs).toEqual(['group\nCtrl\nIRI\n', 'group\nCtrl\nIRI\n'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90000)

it('matches inline R input/output selection and executes it in a fresh directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r-inline-paths-'))
  const script = `paths <- file.path("inputs", c("unused.csv", "groups.csv"))
df <- read.csv(paths[2])
counts <- as.data.frame(table(df$group))
write.csv(counts, list(csv="counts.csv", ignored="unused-output.csv")["csv"][[1]], row.names=FALSE)`
  try {
    const expressions = [
      'c("inputs/unused.csv", "inputs/groups.csv")[2]',
      'c(csv="inputs/groups.csv")["csv"]',
      'list(csv="inputs/groups.csv")[1][[1]]',
      'setNames(list("inputs/groups.csv"), c("csv"))$csv',
      'list(csv="inputs/groups.csv")[["csv"]]',
      'list(csv="inputs/groups.csv")$csv',
      'file.path("inputs", c("unused.csv", "groups.csv"))[[2]]',
      'setNames(nm=c("csv"), object=c("inputs/groups.csv"))[["csv"]]',
      'structure(names=c("csv"), .Data=c("inputs/groups.csv"))[["csv"]]'
    ]
    const { stdout } = await promisify(execFile)(
      rCommand!,
      ['--vanilla', '-e', `cat(c(${expressions.join(',')}), sep="\\n")`],
      { timeout: 30_000 }
    )
    expect(stdout.trim().split(/\r?\n/)).toEqual(expressions.map(() => 'inputs/groups.csv'))
    for (const expression of expressions) {
      expect((await analyzeNotebookSourceFileAccess('r', `read.csv(${expression})`)).reads).toEqual(
        ['inputs/groups.csv']
      )
    }
    const contents = []
    for (const name of ['original', 'replay']) {
      const notebookSessionRoot = join(root, name)
      const dataRoot = join(notebookSessionRoot, 'data')
      await mkdir(join(dataRoot, 'inputs'), { recursive: true })
      await writeFile(join(dataRoot, 'inputs/groups.csv'), 'group\nCtrl\nIRI\nCtrl\n')
      expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        reads: ['inputs/groups.csv'],
        writes: ['counts.csv']
      })
      await promisify(execFile)(rCommand!, ['--vanilla', '-e', script], {
        cwd: dataRoot,
        timeout: 30_000
      })
      contents.push(await readFile(join(dataRoot, 'counts.csv'), 'utf8'))
    }
    expect(contents[1]).toEqual(contents[0])
    expect(contents[0]).toContain('"Ctrl",2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
