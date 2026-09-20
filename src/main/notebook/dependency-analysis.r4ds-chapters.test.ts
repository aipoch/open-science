import { expect, it } from 'vitest'
import { analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

// Original small examples organized by R4DS 2e chapters, not executable book downloads.
// https://r4ds.hadley.nz/data-tidy.html / missing-values.html / rectangling.html
it.each([
  ['pivot_longer(data, x:y, names_to=key_name, values_to=value_name)', ['key_name', 'value_name']],
  ['pivot_wider(data, names_from=key, values_from=value, values_fill=fallback)', ['fallback']],
  [
    'complete(data, group, fill=list(value=fallback), explicit=explicit_missing)',
    ['fallback', 'explicit_missing']
  ],
  ['fill(data, value, .direction=direction)', ['direction']],
  ['replace_na(data, replace=list(value=fallback))', ['fallback']],
  ['separate(data, key, into=columns, sep=separator)', ['columns', 'separator']],
  ['separate(data, key, columns, separator)', ['columns', 'separator']],
  [
    'unite(data, combined, x, y, sep=separator, remove=remove_columns)',
    ['separator', 'remove_columns']
  ],
  ['unnest_wider(data, value, names_sep=separator, simplify=simplify)', ['separator', 'simplify']]
] as const)('tracks tidyr configuration as environment values: %s', async (call, names) => {
  for (const source of [
    `result <- tidyr::${call}`,
    `result <- data |> tidyr::${call.replace('data, ', '')}`
  ]) {
    const [facts] = await analyzeRSources([source])
    expect(facts?.priorUsedNames).toEqual(expect.arrayContaining([...names, 'data']))
  }
})

it.each([
  'pivot_wider(data, names_from=key, values_from=value, values_fn=sum)',
  'pivot_wider(data, names_from=key, values_from=value, values_fn=list(value=mean))',
  'pivot_longer(data, x:y, values_transform=as.numeric)',
  'pivot_longer(data, x:y, values_transform=list(value=as.numeric))',
  'pivot_wider(data, names_from=x, values_from=y, names_glue=NULL)'
])('analyzes tidyr callback options: %s', async (call) => {
  const source = `data <- data.frame(x=1:2,y=3:4); result <- tidyr::${call}`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    readState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  'values_fn=function(x) sum(x) + offset',
  'names_repair=function(x) paste0(prefix, x)',
  'names_repair=~ paste0(prefix, .x)'
])('retains invoking-environment reads in pivot callbacks: %s', async (option) => {
  const [facts] = await analyzeRSources([
    `result <- tidyr::pivot_wider(data, names_from=key, values_from=value, ${option})`
  ])
  expect(facts?.priorUsedNames).toContain(option.startsWith('values_fn') ? 'offset' : 'prefix')
})

it.each([
  'values_fn=function(x) read.csv("hidden.csv")',
  'names_repair=function(x) readLines("hidden.txt")',
  `names_glue='{readLines("hidden.txt")}'`
])('does not certify hidden evaluation in tidyr options: %s', async (option) => {
  expect(
    (await analyzeNotebookSourceFileAccess('r', `result <- tidyr::pivot_wider(data, ${option})`))
      .readState
  ).toBe('partial')
})

// https://r4ds.hadley.nz/rectangling.html#json
it.each([
  `data <- jsonlite::fromJSON('{"count":[1,2]}')`,
  `text <- '[{"group":"Ctrl"}]'; data <- jsonlite::fromJSON(text)`,
  `data <- jsonlite::parse_json('{"count":[1,2]}')`
])('does not invent a file input for JSON text: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    readState: 'complete',
    externalState: 'complete'
  })
})

it('still captures JSON files and text obtained from another file', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'data <- jsonlite::read_json("inputs/data.json"); other <- jsonlite::parse_json(readLines("inputs/text.json"))'
    )
  ).toMatchObject({ reads: ['inputs/data.json', 'inputs/text.json'], readState: 'complete' })
})

it('recognizes a JSON connection as file input, never as a literal', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'data <- jsonlite::parse_json(file("inputs/data.json"))'
    )
  ).toMatchObject({ reads: ['inputs/data.json'], readState: 'complete' })
  expect(
    (await analyzeNotebookSourceFileAccess('r', 'data <- jsonlite::parse_json(connection)'))
      .readState
  ).toBe('partial')
})

it.each(['42', 'true', 'null', '  {"value":1}'])(
  'keeps valid JSON %s ahead of path interpretation',
  async (literal) => {
    expect(
      (await analyzeNotebookSourceFileAccess('r', `data <- jsonlite::fromJSON('${literal}')`)).reads
    ).toEqual([])
  }
)

// Import / projects: selectors and paths are different values. These snippets are
// analyzed only: no spreadsheet, database, network or scientific data is opened.
it.each([
  [
    'project path',
    'p <- file.path("data", "counts.csv"); x <- readr::read_csv(p)',
    ['data/counts.csv']
  ],
  ['CSV text', 'x <- readr::read_csv(I("id,n\\na,2"))', []],
  [
    'multiple CSV sources',
    'x <- readr::read_csv(c("data/a.csv", "data/b.csv"), id="source")',
    ['data/a.csv', 'data/b.csv']
  ],
  [
    'Excel range',
    'x <- readxl::read_excel(range="Answers!A1:B3", path="data/survey.xlsx")',
    ['data/survey.xlsx']
  ],
  [
    'JSON round trip',
    'x <- jsonlite::read_json("data/a.json"); jsonlite::write_json(x,"results/a.json")',
    ['data/a.json']
  ],
  ['JSON embedded URL', `x <- jsonlite::parse_json('{"url":"https://example.test/a"}')`, []],
  [
    'base finite file iteration',
    'paths <- c("a.csv", "b.csv"); for (p in paths) { d <- read.csv(p); write.csv(d, paste0(p, ".copy")) }',
    ['a.csv', 'b.csv']
  ],
  [
    'base negative path slice',
    'paths <- c("a.csv", "b.csv", "c.csv"); x <- readr::read_csv(paths[-2])',
    ['a.csv', 'c.csv']
  ]
] as const)('captures bounded chapter example: %s', async (_label, source, reads) => {
  const result = await analyzeNotebookSourceFileAccess('r', source)
  expect(result.reads).toEqual([...reads])
  expect(result.readState).toBe('complete')
})

// Program / transform: callback locals must not become Notebook inputs, while
// lexical selectors and captured values must remain in the dependency closure.
it.each([
  ['native anonymous callback', 'out <- purrr::map_dbl(c(1,2), \\(x) x * 3)'],
  ['captured helper', 'scale <- 2; f <- function(x) x * scale; out <- purrr::map_dbl(c(2,4),f)'],
  ['paired callback', 'out <- purrr::map2_dbl(c(1,2), c(3,4), ~ .x + .y)'],
  ['pure conditional', 'value <- 2; f <- function(x) { if (x > 0) x else -x }; out <- f(value)'],
  [
    'across closure',
    'cols <- "x"; factor <- 2; df <- data.frame(x=1:3); out <- dplyr::mutate(df, dplyr::across(dplyr::all_of(cols), ~ .x * factor))'
  ]
])('keeps bounded programming example complete: %s', async (_label, source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: [],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

// These chapter patterns cross an unsupported execution boundary. An empty file
// list must not be interpreted as proof that there are no external dependencies.
it.each([
  ['directory input', 'paths <- list.files("data", full.names=TRUE); x <- readr::read_csv(paths)'],
  ['Google Sheets', 'x <- googlesheets4::read_sheet("sheet-id", sheet="Answers")'],
  [
    'database query',
    'con <- DBI::dbConnect(duckdb::duckdb()); x <- DBI::dbGetQuery(con,"SELECT n FROM counts")'
  ],
  ['Arrow lazy collection', 'ds <- arrow::open_dataset("data/parts"); x <- dplyr::collect(ds)'],
  [
    'Arrow to DuckDB',
    'ds <- arrow::open_dataset("data/parts"); x <- dplyr::collect(arrow::to_duckdb(ds))'
  ],
  ['HTML scraping', 'doc <- rvest::read_html("data/page.html"); x <- rvest::html_text2(doc)'],
  ['paired file writer', 'purrr::walk2(list(a,b),c("a.csv","b.csv"),readr::write_csv)'],
  [
    'tidy evaluation helper',
    'avg <- function(data,col) dplyr::summarise(data,value=mean({{ col }})); x <- avg(df,score)'
  ],
  ['Quarto execution', 'quarto::quarto_render("report.qmd",output_file="report.html")'],
  [
    'nested models',
    'df <- data.frame(g=c("a","a"),x=1:2,y=2:3); x <- tidyr::nest(df,data=c(x,y)); x <- dplyr::mutate(x,fit=purrr::map(data,~stats::lm(y~x,data=.x)))'
  ],
  [
    'string replacement callback',
    'x <- stringr::str_replace_all("abc", "a", function(x) readLines("hidden.txt"))'
  ],
  ['computed join', 'x <- dplyr::left_join(a,b,by=dplyr::join_by(x >= y-1))']
])('retains uncertainty for chapter boundary: %s', async (_label, source) => {
  const result = await analyzeNotebookSourceFileAccess('r', source)
  expect([result.readState, result.writeState, result.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})

it('does not apply JSON text semantics to a shadowed parser', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    `parse_json <- function(path) readLines(path); x <- parse_json("42")`
  )
  expect(result.reads).toEqual(['42'])
})

it.each(['jsonlite::parse_json()', 'jsonlite::fromJSON()'])(
  'handles missing JSON arguments conservatively: %s',
  async (source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).readState).toBe('partial')
  }
)
