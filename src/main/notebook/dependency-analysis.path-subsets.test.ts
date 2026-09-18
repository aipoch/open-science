import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'

it.each([
  ['[1:][0]', 'b.csv'],
  ['[:2][-1]', 'b.csv'],
  ['[::-1][0]', 'c.csv'],
  ['[::2][-1]', 'c.csv'],
  ['[-2:][0]', 'b.csv'],
  ['[2:0:-1][-1]', 'b.csv'],
  ['[:-1][0]', 'a.csv'],
  ['[-99:99:2][-1]', 'c.csv']
])('captures Python path slicing %s', async (selection, file) => {
  const script = `import pandas as pd
paths = ["a.csv", "b.csv", "c.csv"]
df = pd.read_csv(paths${selection})`
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads: [file],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each([
  'paths[::0][0]',
  'paths[1.0:][0]',
  'paths[start:][0]',
  'paths[9:][0]',
  '{"csv":"a.csv"}[:][0]'
])('does not certify unknown or invalid Python slicing %s', async (selection) => {
  const script = `import pandas as pd
paths = ["a.csv", "b.csv", "c.csv"]
df = pd.read_csv(${selection})`
  expect((await analyzeNotebookSourceFileAccess('python', script)).readState).toBe('partial')
})

it.each([
  ['c(a="a.csv", b="b.csv", c="c.csv")[c("c", "b")][[2]]', 'b.csv'],
  ['c("a.csv", "b.csv", "c.csv")[c(3, 1)][[2]]', 'a.csv'],
  ['list(a="a.csv", b="b.csv")[c("b", "a")]$b', 'b.csv'],
  ['c("a.csv", "b.csv", "c.csv")[-1][[1]]', 'b.csv']
])('captures R path subset %s', async (selection, file) => {
  expect(await analyzeNotebookSourceFileAccess('r', `df <- read.csv(${selection})`)).toMatchObject({
    reads: [file],
    readState: 'complete',
    writeState: 'complete'
  })
})

const pythonCommand = process.env.OPEN_SCIENCE_TEST_PYTHON
it.skipIf(!process.env.RUN_KERNEL || !pythonCommand)(
  'agrees with native Python for omitted, clipped and reversed slice bounds',
  async () => {
    const selections: string[] = []
    for (const lower of ['', '-9', '-1', '0', '2', '9']) {
      for (const upper of ['', '-9', '-1', '0', '2', '9']) {
        for (const step of ['', '-2', '-1', '1', '2']) {
          selections.push(`[${lower}:${upper}:${step}]`)
        }
      }
    }
    const { stdout } = await promisify(execFile)(pythonCommand!, [
      '-c',
      `import json
paths = ["a.csv", "b.csv", "a.csv", "c.csv"]
selections = json.loads(${JSON.stringify(JSON.stringify(selections))})
print(json.dumps([eval("paths" + selection) for selection in selections]))`
    ])
    const expected: string[][] = JSON.parse(stdout)
    for (const [index, selection] of selections.entries()) {
      const result = await analyzePythonNotebookSource(
        `paths = ["a.csv", "b.csv", "a.csv", "c.csv"]\nselected = paths${selection}`
      )
      expect(
        result.fileAccess?.context?.staticCollections.find(({ name }) => name === 'selected')
          ?.values,
        selection
      ).toEqual(expected[index])
    }
  }
)

const rCommand = process.env.OPEN_SCIENCE_TEST_R_COMMAND
it.skipIf(!process.env.RUN_KERNEL || !rCommand)(
  'agrees with native R for ordered, repeated and excluded subset indices',
  async () => {
    const selections = ['c(3,1,3)', 'c(0,2)', '-1', 'c(-1,-3)', 'c(-9,0)', '0', 'c("c","a","c")']
    for (const selection of selections) {
      const setup = 'paths <- c(a="a.csv", b="b.csv", c="c.csv")'
      const { stdout } = await promisify(execFile)(rCommand!, [
        '--vanilla',
        '-e',
        `${setup}; cat(paths[${selection}], sep="\\n")`
      ])
      const result = await analyzeRNotebookSource(`${setup}\nselected <- paths[${selection}]`)
      expect(
        result.fileAccess?.context?.staticCollections.find(({ name }) => name === 'selected')
          ?.values,
        selection
      ).toEqual(stdout.trim() ? stdout.trim().split('\n') : [])
    }
  }
)

it.each([
  'paths[c(1, -2)]',
  'paths[c(1, index)]',
  'paths[c("missing")]',
  'structure(paths, class="custom")[c(2, 1)]'
])('does not certify unknown or invalid R subsets %s', async (selection) => {
  expect(
    (
      await analyzeNotebookSourceFileAccess(
        'r',
        `paths <- c(a="a.csv", b="b.csv")\nread.csv((${selection})[[1]])`
      )
    ).readState
  ).toBe('partial')
})

it.each(['c("b")', '2'])(
  'retains singleton R subset names through assignment: %s',
  async (selection) => {
    const script = `paths <- c(a="a.csv", b="b.csv")\nselected <- paths[${selection}]\nalias <- selected\nread.csv(alias[["b"]])`
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      reads: ['b.csv'],
      readState: 'complete'
    })
  }
)
