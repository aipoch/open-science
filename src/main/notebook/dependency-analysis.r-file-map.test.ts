import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it.each([
  'readr::write_file("tiny","existing.dat",TRUE)',
  'readr::write_csv2("NA",TRUE,x=data.frame(n=1),file="existing.dat")',
  'readr::write_lines("tiny","existing.dat","\\n","NA",TRUE)',
  'utils::write.table(TRUE,x=data.frame(n=1),file="existing.dat")',
  'purrr::walk2(list("tiny"),"existing.dat",readr::write_file,TRUE)',
  'purrr::walk2(list(data.frame(n=1)),"existing.dat",readr::write_csv2,"NA",TRUE)'
])('matches positional append after named arguments: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['existing.dat'],
    writes: ['existing.dat'],
    writeState: 'complete'
  })
})

it.each([
  'utils::write.csv',
  'utils::write.csv2',
  'utils::write.table',
  'readr::write_csv',
  'readr::write_csv2',
  'readr::write_tsv',
  'readr::write_delim',
  'readr::write_lines',
  'readr::write_file',
  'readr::write_rds',
  'base::saveRDS',
  'base::writeLines',
  'jsonlite::write_json'
])('uses the existing file effect for %s', async (writer) => {
  expect(
    await analyzeNotebookSourceFileAccess('r', `purrr::walk2(list("tiny"),"result.dat",${writer})`)
  ).toMatchObject({
    writes: ['result.dat'],
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  'purrr::walk2(list(data.frame(n=1),data.frame(n=2)),c("a.csv","b.csv","c.csv"),utils::write.csv)',
  'purrr::walk2(dynamic,c("a.csv"),utils::write.csv)',
  'purrr::walk2(list(data.frame(n=1)),c("a.csv"),custom::write.csv)',
  'write.csv <- custom_writer; purrr::walk2(list(data.frame(n=1)),c("a.csv"),write.csv)',
  'walk2 <- custom_mapper; walk2(list(data.frame(n=1)),c("a.csv"),utils::write.csv)',
  'list <- custom_list; purrr::walk2(list(data.frame(n=1)),c("a.csv"),utils::write.csv)',
  'purrr::walk2(list(data.frame(n=1)),c("a.csv"),function(x,p) custom_writer(x,p))',
  'purrr::walk(c("a.csv"),"write.csv")',
  'c("a.csv") %>% purrr::map(utils::read.csv, extra=list(.))'
])('does not certify unknown iteration semantics: %s', async (source) => {
  expect((await analyzeNotebookSourceFileAccess('r', source)).writeState).toBe('partial')
})

it('does not invent writes when one recycled walk2 input is empty', async () => {
  expect(
    await analyzeNotebookSourceFileAccess('r', 'purrr::walk2(list(),"unused.csv",utils::write.csv)')
  ).toMatchObject({
    writes: [],
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('retains repeated writer paths', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'purrr::walk2(c("first","second"),"log.txt",base::writeLines)'
    )
  ).toMatchObject({
    writes: ['log.txt'],
    writeState: 'complete'
  })
})

it.each(['write_csv2', 'write_lines', 'write_file'])(
  'retains existing bytes for readr::%s append',
  async (writer) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `purrr::walk2(list("tiny"),"existing.dat",readr::${writer},append=TRUE)`
      )
    ).toMatchObject({
      reads: ['existing.dat'],
      writes: ['existing.dat'],
      writeState: 'complete'
    })
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          `purrr::walk2(list("tiny"),"existing.dat",readr::${writer},append=unknown)`
        )
      ).writeState
    ).toBe('partial')
  }
)

it('bounds writer expansion across multiple calls', async () => {
  const paths = Array.from({ length: 100 }, (_, i) => `"${i}.csv"`).join(',')
  expect(
    (
      await analyzeNotebookSourceFileAccess(
        'r',
        `paths <- c(${paths}); purrr::walk(paths,writeLines,text="a"); purrr::walk(paths,writeLines,text="b")`
      )
    ).writeState
  ).toBe('partial')
})

it.each([
  'x <- purrr::map(c("a.csv","b.csv"), utils::read.csv)',
  'paths <- c("a.csv","b.csv"); x <- purrr::map(paths, readr::read_csv)',
  'paths <- c("a.csv","b.csv"); x <- base::lapply(paths, utils::read.csv)',
  'x <- purrr::map(.f=readr::read_csv, .x=c("a.csv","b.csv"), col_names=TRUE)',
  'x <- c("a.csv","b.csv") |> purrr::map(utils::read.csv)',
  'x <- c("a.csv","b.csv") %>% purrr::map(utils::read.csv)',
  'x <- c("a.csv","b.csv") |> purrr::map(.f=utils::read.csv, .x=_)'
])('captures bounded reader callbacks: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['a.csv', 'b.csv'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  ['r', 'quarto::quarto_render("report.qmd", output_file="report.html")'],
  ['python', 'unknown_writer("result.csv")']
] as const)('does not certify unknown %s outputs: %s', async (language, source) => {
  expect((await analyzeNotebookSourceFileAccess(language, source)).writeState).toBe('partial')
})

it.each([
  'purrr::walk(c("a.csv","b.csv"), base::writeLines, text="ok")',
  'purrr::walk2(list(data.frame(n=1),data.frame(n=2)),c("a.csv","b.csv"),readr::write_csv)',
  'purrr::walk2(.f=utils::write.csv,.y=c("a.csv","b.csv"),.x=list(data.frame(n=1)))',
  'list(data.frame(n=1),data.frame(n=2)) |> purrr::walk2(c("a.csv","b.csv"),utils::write.csv)'
])('captures bounded writer callbacks: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    writes: ['a.csv', 'b.csv'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  'x <- purrr::map(paths, readr::read_csv)',
  'x <- purrr::map(c("a.csv",dynamic), readr::read_csv)',
  'x <- purrr::map(c("a.csv"), custom_reader)',
  'read.csv <- custom_reader; x <- purrr::map(c("a.csv"), read.csv)',
  'map <- custom_mapper; x <- map(c("a.csv"), utils::read.csv)',
  'x <- custom::map(c("a.csv"), utils::read.csv)',
  'x <- purrr::map(c("a.csv"), custom::read_csv)',
  'c <- custom_vector; paths <- c("a.csv"); x <- purrr::map(paths,utils::read.csv)',
  'paths <- custom::c("a.csv"); x <- purrr::map(paths,utils::read.csv)',
  'paste0 <- custom_join; paths <- paste0("a",".csv"); x <- purrr::map(paths,utils::read.csv)',
  'c <- custom_vector; x <- purrr::map(c("a.csv"), utils::read.csv)',
  'paths <- structure(c("a.csv"),class="dynamic"); x <- purrr::map(paths,readr::read_csv)',
  'paths <- c("a.csv"); paths[1] <- dynamic; x <- purrr::map(paths,readr::read_csv)'
])('keeps unresolved collection or callable identity partial: %s', async (source) => {
  const result = await analyzeNotebookSourceFileAccess('r', source)
  expect(result.readState).toBe('partial')
})

it('shares a bounded expansion budget across reader maps', async () => {
  const paths = Array.from({ length: 100 }, (_, i) => `"${i}.csv"`).join(',')
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    `paths <- c(${paths}); a <- purrr::map(paths,readr::read_csv); b <- purrr::map(paths,readr::read_csv)`
  )
  expect(result.readState).toBe('partial')
  expect(result.externalState).toBe('partial')
})

it('preserves known output evidence alongside an unknown writer', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    'custom_writer(); write.csv(data.frame(n=1),"known.csv")'
  )
  expect(result).toMatchObject({ writes: ['known.csv'], writeState: 'partial' })
})

it('does not downgrade known output paths solely for unresolved input data', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'import pandas as pd\ndf = pd.read_csv(path)\ndf.to_csv("known.csv")'
  )
  expect(result).toMatchObject({
    readState: 'partial',
    writes: ['known.csv'],
    writeState: 'complete'
  })
})

it('does not trust a callable replaced in the prior kernel context', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    'result <- map(c("a.csv"),utils::read.csv)',
    {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      rFunctions: [
        {
          name: 'map',
          summary: {
            name: 'map',
            kind: 'r-function',
            fields: [],
            methods: [{ name: '__call__', effect: 'unknown' }]
          }
        }
      ]
    }
  )
  expect(result.readState).toBe('partial')
})
