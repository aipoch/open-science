import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it.each(['mutate', 'summarise'])(
  'shares ownership rules between direct, piped and qualified %s calls',
  async (verb) => {
    for (const reducer of ['mean', 'base::mean', 'function(x) mean(x)']) {
      for (const pipe of [false, true]) {
        const args = `dplyr::across(dplyr::everything(), ${reducer})`
        const script = `d<-read.csv("data.csv"); out<-${pipe ? `d |> dplyr::${verb}(${args})` : `dplyr::${verb}(d,${args})`};head(out)`
        const { facts } = await analyzeRNotebookSource(script)
        expect(facts.copyOnModifyNames, script).toContain('out')
        expect(await analyzeNotebookSourceFileAccess('r', script), script).toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete',
          reads: ['data.csv']
        })
      }
    }
  }
)

it.each(['dplyr::mutate(d,obsolete=NULL)', 'd |> dplyr::mutate(obsolete=NULL)'])(
  'keeps ordinary table ownership when deleting columns: %s',
  async (expression) => {
    const { facts } = await analyzeRNotebookSource(
      `d<-read.csv("data.csv");out<-${expression};head(out)`
    )
    expect(facts.copyOnModifyNames).toContain('out')
  }
)

it.each([
  'pd.read_csv("input.csv", converters={"value": converter})',
  'pd.read_excel("input.xlsx", converters={"value": converter})',
  'xl.parse(0, converters={"value": converter})'
])('does not hide converter effects when reading a table: %s', async (reader) => {
  const script = `import pandas as pd\nxl=pd.ExcelFile("input.xlsx")\ndef converter(value):\n    return open("lookup.txt").read()\ndf=${reader}`
  const access = await analyzeNotebookSourceFileAccess('python', script)
  expect(
    access.readState === 'partial' || access.reads.includes('lookup.txt'),
    JSON.stringify(access)
  ).toBe(true)
})

it.each(['{}', 'None', '{"value": lambda value: value}'])(
  'keeps proven file-free converters complete: %s',
  async (converters) => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      `import pandas as pd\ndf=pd.read_excel("input.xlsx", converters=${converters})`
    )
    expect(access).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['input.xlsx']
    })
  }
)

it.each([
  'converters',
  '{"value": lambda value: open("extra.txt").read()}',
  '{"value": lambda value: open("audit.txt", "w").write(value)}'
])('does not certify unresolved converter containers or their I/O: %s', async (converters) => {
  const access = await analyzeNotebookSourceFileAccess(
    'python',
    `import pandas as pd\ndf=pd.read_excel("input.xlsx", converters=${converters})`
  )
  expect(access.readState).toBe('partial')
  expect(access.writeState).toBe('partial')
})

it('does not apply the builtin reducer contract to a replacement function', async () => {
  const { facts } = await analyzeRNotebookSource(
    `d<-read.csv("data.csv");mean<-function(x) new.env();out<-dplyr::mutate(d,dplyr::across(dplyr::everything(),mean));head(out)`
  )
  expect(facts.copyOnModifyNames ?? []).not.toContain('out')
})

it.each(['mean', 'base::mean', 'function(x) mean(x)'])(
  'does not turn unknown input objects into ordinary tables through across(%s)',
  async (reducer) => {
    const script = `d<-readRDS("unknown.rds");out<-dplyr::mutate(d,dplyr::across(dplyr::everything(),${reducer}));head(out)`
    const { facts } = await analyzeRNotebookSource(script)
    expect(facts.copyOnModifyNames ?? []).not.toContain('out')
  }
)
