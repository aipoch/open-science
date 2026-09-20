import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it
  .skipIf(process.env.RUN_KERNEL !== '1')
  .each([
    'purrr::walk(c("a.csv","b.csv"),base::writeLines,text="ok")',
    'purrr::walk2(list(data.frame(n=1),data.frame(n=2)),c("a.csv","b.csv"),utils::write.csv)',
    'list(data.frame(n=1)) |> purrr::walk2(c("a.csv","b.csv"),utils::write.csv)',
    'purrr::walk2(list(),"unused.csv",utils::write.csv)',
    'purrr::walk2(list(data.frame(n=1),data.frame(n=2)),"a.csv",utils::write.csv)'
  ])('matches native purrr writer paths: %s', async (source) => {
  const root = await mkdtemp(join(tmpdir(), 'r-file-walk-'))
  try {
    await promisify(execFile)(
      process.env.OPEN_SCIENCE_TEST_R_COMMAND || 'Rscript',
      ['--vanilla', '-e', source],
      { cwd: root, timeout: 15000 }
    )
    const actual = (await readdir(root)).sort()
    const analyzed = await analyzeNotebookSourceFileAccess('r', source)
    expect(analyzed.writes).toEqual(actual)
    expect(analyzed.writeState).toBe('complete')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it
  .skipIf(process.env.RUN_KERNEL !== '1')
  .each([
    'paths <- c("a.csv","b.csv"); out <- base::lapply(paths, utils::read.csv)',
    'out <- c("a.csv","b.csv") |> base::lapply(utils::read.csv)',
    'out <- c("a.csv","b.csv") |> purrr::map(utils::read.csv)',
    'out <- c("a.csv","b.csv") |> purrr::map(.f=utils::read.csv,.x=_)'
  ])('matches native R reader paths on tiny CSV files: %s', async (source) => {
  const root = await mkdtemp(join(tmpdir(), 'r-file-map-'))
  try {
    await Promise.all(['a.csv', 'b.csv'].map((path) => writeFile(join(root, path), 'n\n2\n')))
    const result = await promisify(execFile)(
      process.env.OPEN_SCIENCE_TEST_R_COMMAND || 'Rscript',
      [
        '--vanilla',
        '-e',
        `trace("read.csv", where=asNamespace("utils"), tracer=quote(cat("READ:",file,"\\n",sep="")), print=FALSE); ${source}; stopifnot(length(out)==2, sum(out[[1]]$n)==2)`
      ],
      { cwd: root, timeout: 15000 }
    )
    const actual = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('READ:'))
      .map((line) => line.slice(5))
      .sort()
    expect(actual).toEqual(['a.csv', 'b.csv'])
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(actual)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
