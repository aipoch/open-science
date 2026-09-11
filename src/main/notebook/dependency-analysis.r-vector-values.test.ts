import { expect, it } from 'vitest'
import { analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

// R4DS vector operations composed with value-or-callback consumers:
// https://r4ds.had.co.nz/vectors.html and https://r4ds.hadley.nz/base-R.html
// Native R checks below validate the bounded fixtures; inference never evaluates them.
const values = [
  'breaks <- seq(-2, 2, by=0.5) * pi',
  'breaks <- rep(c(1, 2), times=2)',
  'breaks <- c(1, 2); breaks <- breaks * pi',
  'x <- c(1, 2, 3); breaks <- x[x > 1]',
  'x <- c(1, 2, 3); breaks <- x[-1]',
  'x <- c(1, 2, 3); breaks <- x[c(FALSE, FALSE, FALSE)]',
  'breaks <- c(1, 2, 3); breaks[2] <- 2.5',
  'breaks <- seq_len(0)',
  'breaks <- numeric(0)',
  'breaks <- c() * pi',
  'x <- c("1", "2"); breaks <- as.numeric(x)',
  'x <- c(1.123, 2.345); breaks <- round(x, 1)'
]

it.each(values)('keeps an ordinary vector distinct from a callback: %s', async (setup) => {
  const source = `${setup}; ggplot2::scale_x_continuous(breaks=breaks)`
  expect((await analyzeRSources([source]))[0]?.state).toBe('available')
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    readState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it.each([
  'x <- c(1, 2); breaks <- x[unknown_index]',
  'x <- list(function(x) read.csv("hidden.csv")); breaks <- x[[1]]',
  'x <- structure(c(1, 2), class="custom"); breaks <- x + 1',
  'seq <- custom; breaks <- seq(1, 2)',
  'breaks <- c(1, 2); class(breaks) <- "custom"',
  'breaks <- c(1, 2); breaks[1] <- list(function(x) read.csv("hidden.csv"))',
  'breaks <- seq(1, 2); breaks <- unknown_formatter'
])('retains uncertain dispatch and reassignment: %s', async (setup) => {
  const source = `${setup}; ggplot2::scale_x_continuous(breaks=breaks)`
  expect((await analyzeRSources([source]))[0]?.state).toBe('unknown')
})

it.each(['breaks <- seq_len(0)', 'x <- c(1, 2); breaks <- x[FALSE]', 'breaks <- rep(1, 0)'])(
  'does not turn known data into proof a loop runs: %s',
  async (setup) => {
    const [facts] = await analyzeRSources([
      `${setup}; for (x in breaks) { result <- 1 }; print(result)`
    ])
    expect(facts?.state).toBe('unknown')
    expect(facts?.conditionallyDefinedNames).toContain('result')
  }
)

it('uses the same data/callback distinction for base graphics', async () => {
  const source = 'values <- c(1,2,3); breaks <- seq(0, 4, by=1); hist(values, breaks=breaks)'
  expect((await analyzeRSources([source]))[0]?.state).toBe('available')
})

it('infers a value category without expanding a large vector', async () => {
  expect(
    (
      await analyzeRSources([
        'breaks <- seq_len(1000000000); ggplot2::scale_x_continuous(breaks=breaks)'
      ])
    )[0]?.state
  ).toBe('available')
})

it('honors base qualification without trusting custom-class method dispatch', async () => {
  expect(
    (
      await analyzeRSources([
        'seq <- custom; breaks <- base::seq(0, 2); ggplot2::scale_x_continuous(breaks=breaks)'
      ])
    )[0]?.state
  ).toBe('available')
  expect(
    (
      await analyzeRSources([
        'x <- structure(2, class="custom"); breaks <- base::seq(x); ggplot2::scale_x_continuous(breaks=breaks)'
      ])
    )[0]?.state
  ).toBe('unknown')
})

const rCommand = process.env.OPEN_SCIENCE_TEST_R_COMMAND
it.skipIf(!process.env.RUN_KERNEL || !rCommand)(
  'checks the bounded value fixtures against native R',
  async () => {
    const { stdout } = await promisify(execFile)(rCommand!, [
      '--vanilla',
      '-e',
      values
        .map(
          (source) =>
            `{ ${source}; stopifnot(is.atomic(breaks) || is.null(breaks)); cat("value\\n") }`
        )
        .join('; ')
    ])
    expect(stdout.trim().split('\n')).toEqual(values.map(() => 'value'))
  }
)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
