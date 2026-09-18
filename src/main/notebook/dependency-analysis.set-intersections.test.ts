import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { projectNotebookDependencies } from './dependency-projection'
import type { NotebookRunRecord } from '../../shared/notebook'

const script = String.raw`
suppressPackageStartupMessages({library(readxl)})
f <- "inputs/set-membership-111111111111.xlsx"
d <- read_excel(f, sheet = "5组")
cat("Full dims:", paste(dim(d), collapse = " x "), "\n")
sets <- lapply(d, function(col) unique(stats::na.omit(col)))
cat("Set sizes (unique):\n")
for (nm in names(sets)) cat("  ", nm, ":", length(sets[[nm]]), "\n")
all_e <- unique(unlist(sets))
cat("\nTotal unique elements across all 5 sets:", length(all_e), "\n")
cat("\nPairwise intersections (size):\n")
for (i in 1:(length(sets)-1)) for (j in (i+1):length(sets)) {
  inter <- length(intersect(sets[[i]], sets[[j]]))
  cat(sprintf("  %s ∩ %s = %d\n", names(sets)[i], names(sets)[j], inter))
}
five <- Reduce(intersect, sets)
cat("\nA ∩ B ∩ C ∩ D ∩ E =", length(five), "\n")
`
const runFor = (script: string, id = '0'): NotebookRunRecord => ({
  runId: id,
  cellId: id,
  script,
  kernelKind: 'r',
  kernelEpochId: 'r',
  environment: 'r',
  source: 'agent',
  status: 'completed',
  kernelDispatched: true,
  startedAt: 0,
  endedAt: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it.each([
  script,
  script.replace('1:(length(sets)-1)', 'seq_len(length(sets)-1)'),
  script.replace('1:(length(sets)-1)', 'base::seq_len(base::length(sets)-1)'),
  script.replace('for (j in (i+1):length(sets))', 'for (j in length(sets):(i+1))')
])('tracks workbook set intersections and their input: %#', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  const run = runFor(script)
  expect(
    projectNotebookDependencies([{ run, facts }]).stalenessByRunId['0'],
    JSON.stringify(facts)
  ).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/set-membership-111111111111.xlsx'],
    writes: []
  })
})

it.each([
  script + '\nprint(inter)',
  script + '\nprint(j)',
  script.replace('1:(length(sets)-1)', '1:unknown_bound'),
  script.replace('inter <- length(intersect', 'inter <<- length(intersect'),
  script.replace(
    'inter <- length(intersect(sets[[i]], sets[[j]]))',
    'inter <- custom(sets[[i]], sets[[j]])'
  ),
  script.replace('for (i in', '`:` <- custom_range\nfor (i in'),
  script.replace('inter <- length(intersect', 'if (i > 2) break\ninter <- length(intersect')
])('preserves uncertain state and effects around index loops: %#', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(
    projectNotebookDependencies([{ run: runFor(script), facts }]).stalenessByRunId['0']?.state,
    JSON.stringify(facts)
  ).toBe('unknown')
})

it('keeps conditional loop bindings uncertain when consumed by a later cell', async () => {
  const first = await analyzeRNotebookSource(script)
  const next = 'print(inter)'
  const second = await analyzeRNotebookSource(next)
  const projection = projectNotebookDependencies([
    { run: runFor(script), facts: first.facts },
    { run: runFor(next, '1'), facts: second.facts }
  ])
  expect(projection.stalenessByRunId['0']).toEqual({ state: 'clear' })
  expect(projection.stalenessByRunId['1']?.state).toBe('unknown')
})

it('links a later cell to the workbook analysis through the established set result', async () => {
  const first = await analyzeRNotebookSource(script)
  const next = 'cat(length(five))'
  const second = await analyzeRNotebookSource(next)
  const projection = projectNotebookDependencies([
    { run: runFor(script), facts: first.facts },
    { run: runFor(next, '1'), facts: second.facts }
  ])
  expect(projection.stalenessByRunId['1']).toEqual({ state: 'clear' })
  expect(projection.dependenciesByRunId?.['1']).toContain('0')
})
