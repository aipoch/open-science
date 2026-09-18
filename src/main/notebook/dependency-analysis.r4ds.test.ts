import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzeRNotebookSource, analyzeRSources } from './dependency-analysis-r'

// Original file-processing fixtures based on R4DS's vector subsetting categories:
// https://r4ds.had.co.nz/vectors.html#subsetting
// https://r4ds.hadley.nz/base-R.html
const setup = 'paths <- c("inputs/control.csv", "inputs/treated.csv", "inputs/qc.csv")'
it.each([
  ['c(TRUE,FALSE,TRUE)', ['inputs/control.csv', 'inputs/qc.csv']],
  ['c(TRUE,FALSE)', ['inputs/control.csv', 'inputs/qc.csv']],
  ['!c(FALSE,TRUE,FALSE)', ['inputs/control.csv', 'inputs/qc.csv']],
  ['2:3', ['inputs/qc.csv', 'inputs/treated.csv']],
  ['3:2', ['inputs/qc.csv', 'inputs/treated.csv']],
  ['-(1:2)', ['inputs/qc.csv']],
  ['seq_along(paths)', ['inputs/control.csv', 'inputs/qc.csv', 'inputs/treated.csv']],
  ['seq_len(2)', ['inputs/control.csv', 'inputs/treated.csv']],
  ['c(1:2, 2)', ['inputs/control.csv', 'inputs/treated.csv']],
  ['TRUE', ['inputs/control.csv', 'inputs/qc.csv', 'inputs/treated.csv']]
])('captures R4DS-style vector selection %s in a file-processing loop', async (selector, reads) => {
  const script = `${setup}
selected <- paths[${selector}]
for (path in selected) {
  data <- read.csv(path)
  write.csv(data, paste0(path, ".copy"), row.names=FALSE)
}`
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads,
    writes: reads.map((path) => path + '.copy'),
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each([
  'seq_len <- custom_selector; selected <- paths[seq_len(2)]',
  'seq_along <- custom_selector; selected <- paths[seq_along(paths)]',
  'c <- custom_selector; selected <- paths[c(TRUE, FALSE)]',
  'selected <- paths[custom::seq_len(2)]'
])('does not trust a shadowed selector: %s', async (selection) => {
  expect(
    (
      await analyzeNotebookSourceFileAccess(
        'r',
        `${setup}\n${selection}\nfor (path in selected) read.csv(path)`
      )
    ).readState
  ).toBe('partial')
})

it('keeps explicit base sequence identity when an unqualified name is shadowed', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `${setup}
seq_along <- custom_selector
for (path in paths[base::seq_along(paths)]) read.csv(path)`
    )
  ).toMatchObject({
    reads: ['inputs/control.csv', 'inputs/qc.csv', 'inputs/treated.csv'],
    readState: 'complete'
  })
})

it.each([
  'col_character()',
  'col_double()',
  'col_integer()',
  'col_logical()',
  'col_factor(levels = c("Ctrl", "Case"))',
  'col_date(format = "%Y-%m-%d")',
  'col_time()',
  'col_datetime()',
  'col_number()',
  'col_skip()',
  'col_guess()'
])('captures readr column configuration: %s', async (spec) => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `data <- readr::read_csv("inputs/patients.csv", col_types = readr::cols_only(value = readr::${spec}))`
    )
  ).toMatchObject({ reads: ['inputs/patients.csv'], readState: 'complete', writeState: 'complete' })
})

it.each([
  'cols <- custom_spec; readr::read_csv("patients.csv", col_types = cols())',
  'col_double <- custom_spec; readr::read_csv("patients.csv", col_types = readr::cols(value = col_double()))',
  'readr::read_csv("patients.csv", col_types = custom::cols())',
  'readr::cols(value = function() read.csv("hidden.csv"))'
])('keeps unknown column configuration conservative: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).readState).toBe('partial')
})

it('retains file dependencies evaluated inside column configuration', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'data <- readr::read_csv("patients.csv", col_types = readr::cols(group = readr::col_factor(levels = readLines("groups.txt"))))'
    )
  ).toMatchObject({ reads: ['groups.txt', 'patients.csv'], readState: 'complete' })
})

const rCommand = process.env.OPEN_SCIENCE_TEST_R_COMMAND
it.skipIf(!process.env.RUN_KERNEL || !rCommand)(
  'agrees with native R for bounded logical and range selections',
  async () => {
    const selectors = [
      'TRUE',
      'FALSE',
      'c(TRUE,FALSE)',
      'c(FALSE,TRUE)',
      '!c(FALSE,TRUE,FALSE)',
      'c(TRUE,FALSE,FALSE,FALSE)',
      'c()',
      '2:3',
      '3:1',
      '-(1:2)',
      'c(1:2,2)',
      'c(TRUE,2)',
      'seq_along(paths)',
      'seq_len(0)',
      'seq_len(2)',
      'base::seq_len(3)'
    ]
    const { stdout } = await promisify(execFile)(rCommand!, [
      '--vanilla',
      '-e',
      `${setup}; ${selectors.map((selector) => `cat(paste(paths[${selector}], collapse="|"), "\\n", sep="")`).join('; ')}`
    ])
    const expected = stdout
      .split('\n')
      .slice(0, selectors.length)
      .map((line) => (line ? line.split('|') : []))
    for (const [index, selector] of selectors.entries()) {
      const result = await analyzeRNotebookSource(`${setup}\nselected <- paths[${selector}]`)
      const context = result.fileAccess?.context
      const scalar = context?.staticStrings.find(({ name }) => name === 'selected')?.value
      const values =
        context?.staticCollections.find(({ name }) => name === 'selected')?.values ??
        (scalar === undefined ? undefined : [scalar])
      expect(values, selector).toEqual(expected[index])
    }
  }
)

it.each([
  'c(TRUE,NA,FALSE)',
  'c(TRUE,FALSE,FALSE,TRUE)',
  '1:100000000',
  'seq_len(count)',
  'custom_mask(paths)'
])('does not certify unresolved or oversized R selection %s', async (selector) => {
  expect(
    (
      await analyzeNotebookSourceFileAccess(
        'r',
        `${setup}\nfor (path in paths[${selector}]) read.csv(path)`
      )
    ).readState
  ).toBe('partial')
})

it.each(['', 'readr::'])('captures explicit readr column specifications (%s)', async (prefix) => {
  const script = `library(readr)
data <- ${prefix}read_csv("inputs/patients.csv",
  col_types = ${prefix}cols(patient_id = ${prefix}col_character(), measurement = ${prefix}col_double()),
  na = c("", "-999"), show_col_types = FALSE)
${prefix}write_csv(data, "clean.csv")`
  const facts = (await analyzeRSources([script]))[0]
  expect(facts?.state === 'unknown' ? facts.reasons : []).toEqual(['external-state'])
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads: ['inputs/patients.csv'],
    writes: ['clean.csv'],
    readState: 'complete',
    writeState: 'complete'
  })
})
