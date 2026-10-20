import { expect, it } from 'vitest'

import { analyzeRSources } from './index'

import { analyzeNotebookSourceFileAccess } from './index'

const sineSource = String.raw`suppressPackageStartupMessages(library(ggplot2))
x <- seq(-2 * pi, 2 * pi, length.out = 400)
df <- data.frame(x = x, y = sin(x))
breaks_pi <- c(-2, -1, 0, 1, 2) * pi
labels_pi <- c("-2π", "-π", "0", "π", "2π")
p <- ggplot(df, aes(x = x, y = y)) +
  geom_hline(yintercept = 0, color = "#666666", linewidth = 0.4) +
  geom_vline(xintercept = 0, color = "#666666", linewidth = 0.4) +
  geom_line(color = "#1f77b4", linewidth = 1.0) +
  scale_x_continuous(breaks = breaks_pi, labels = labels_pi, limits = c(-2 * pi, 2 * pi)) +
  scale_y_continuous(breaks = c(-1, -0.5, 0, 0.5, 1), limits = c(-1.2, 1.2)) +
  labs(title = "Sine Function", x = "x (radians)", y = "sin(x)") +
  theme_minimal(base_size = 12) +
  theme(panel.grid.major = element_line(color = "#e6e6e6", linewidth = 0.4),
        panel.grid.minor = element_blank())
ggsave("sin_plot.png", plot = p, width = 8, height = 4.5, dpi = 120)
cat("saved sin_plot.png\n")`

const reportedBaseSine = String.raw`x <- seq(0, 2*pi, length.out = 200)
y <- sin(x)
png("sin_plot.png", width = 960, height = 540, res = 120)
plot(x, y, type = "l", col = "#2E86AB", lwd = 2,
     main = "Sine Function", xlab = "x (radians)", ylab = "sin(x)", xaxt = "n")
axis(1, at = c(0, pi/2, pi, 3*pi/2, 2*pi), labels = c("0", "π/2", "π", "3π/2", "2π"))
abline(h = 0, col = "gray", lwd = 0.5)
abline(v = 0, col = "gray", lwd = 0.5)
grid(col = "lightgray", lty = 3)
legend("topright", legend = "sin(x)", col = "#2E86AB", lwd = 2, bty = "n")
dev.off()
cat("saved:", normalizePath("sin_plot.png"), "\n")
file.info("sin_plot.png")$size`

it.each([
  'file.copy("a.png","b.png")',
  'file.remove("a.png")',
  'base::file.rename("a.png","b.png")'
])('keeps filesystem gaps separate from unknown kernel mutations: %s', async (source) => {
  expect((await analyzeRSources([source]))[0]).toMatchObject({
    state: 'unknown',
    reasons: ['external-state']
  })
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'file.copy <- custom; file.copy("a.png","b.png")',
  'other::file.copy("a.png","b.png")',
  'file.copy(dynamic_path,"b.png")',
  'file.remove(custom_path())'
])('does not waive unknown conversion or callable effects: %s', async (source) => {
  const [facts] = await analyzeRSources([source])
  expect(facts.safeCallNames).not.toContain('file.copy')
  expect((await analyzeNotebookSourceFileAccess('r', source)).externalState).toBe('partial')
})

it.each([
  'path <- normalizePath("sin_plot.png"); writeLines(path,"path.txt")',
  'bytes <- file.info("sin_plot.png")$size; writeLines(as.character(bytes),"size.txt")',
  'if(file.info("sin_plot.png")$size > 0) writeLines("ok","result.txt")',
  'cat(getwd(),file="cwd.txt")',
  'sink("cwd.txt"); cat(getwd()); sink()',
  'print <- custom_print; print(list.files())',
  'normalizePath <- custom_path; cat(normalizePath("sin_plot.png"))',
  'print(other::file.info("sin_plot.png"))',
  'cat(normalizePath(readLines("path.txt")))'
])('preserves meaningful filesystem or unknown callable dependencies: %s', async (source) => {
  expect((await analyzeNotebookSourceFileAccess('r', source)).externalState).toBe('partial')
})

it('retains path binding dependencies in a console diagnostic', async () => {
  const [facts] = await analyzeRSources(['path <- "sin_plot.png"; cat(normalizePath(path))'])
  expect(facts).toMatchObject({ state: 'available', usedNames: expect.arrayContaining(['path']) })
})

it.each([
  'cat("cwd:", getwd(), "\\n")',
  'print(list.files(".", recursive=TRUE, pattern="png$"))',
  'cat("saved:", normalizePath("sin_plot.png"), "\\n")',
  'file.info("sin_plot.png")$size',
  reportedBaseSine
])('does not turn console-only filesystem diagnostics into opaque effects: %s', async (source) => {
  expect((await analyzeRSources([source]))[0]).toMatchObject({ state: 'available' })
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each(['', '\nlist.files(pattern = "sin_plot\\\\.png$")'])(
  'captures the reported sine plot with suffix %s',
  async (suffix) => {
    const source = sineSource + suffix
    const [facts] = await analyzeRSources([source])
    expect(facts?.state === 'unknown' ? facts.reasons : []).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('r', source)).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['sin_plot.png'],
      reasonCodes: []
    })
  }
)

it.each([
  'breaks <- c(-2, -1, 0, 1, 2) * pi',
  'breaks <- -(c(1, 2) / 2)',
  'points <- c(1, 2); breaks <- points ^ 2 + 1'
])('recognizes computed scale values: %s', async (setup) => {
  const [facts] = await analyzeRSources([`${setup}; ggplot2::scale_x_continuous(breaks=breaks)`])
  expect(facts?.state).toBe('available')
})

it.each([
  'breaks <- external_values * pi',
  'breaks <- c(1, 2); breaks <- unknown_value * pi',
  'breaks <- c(1, 2) * pi; breaks <- unknown_formatter',
  'pi <- custom_value; breaks <- c(1, 2) * pi',
  '`*` <- function(x, y) custom(); breaks <- c(1, 2) * pi'
])('does not certify unknown scale values: %s', async (setup) => {
  const [facts] = await analyzeRSources([`${setup}; ggplot2::scale_x_continuous(breaks=breaks)`])
  expect(facts?.state).toBe('unknown')
})

it.each([
  'list.files(pattern="png$")',
  'base::list.files(pattern="png$")',
  '{ list.files(pattern="png$") }'
])('does not invent file inputs for a diagnostic listing: %s', async (source) => {
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    externalState: 'complete',
    reads: [],
    reasonCodes: []
  })
})

it.each([
  'files <- list.files(); read.csv(files[[1]])',
  'writeLines(list.files(), "manifest.txt")',
  'files <- { list.files() }; writeLines(files, "manifest.txt")',
  'if (length(list.files())) writeLines("found", "result.txt")',
  'other::list.files()',
  'list.files <- custom; list.files()',
  'list.files(path=readLines("directory.txt"))'
])('retains dependencies when a directory result is consumed: %s', async (source) => {
  const files = await analyzeNotebookSourceFileAccess('r', source)
  if (source.startsWith('list.files(path=')) expect(files.reads).toEqual(['directory.txt'])
  else expect(files.externalState).toBe('partial')
})

it.each([
  'library(ggplot2)',
  'suppressPackageStartupMessages({library(ggplot2)})',
  'suppressPackageStartupMessages(library(ggplot2))'
])('loads plotting contracts through %s', async (load) => {
  const source = `${load}\np <- ggplot(data.frame(x=1), aes(x=x)) + geom_line()`
  const [facts] = await analyzeRSources([source])
  expect(facts?.state === 'unknown' ? facts.reasons : []).toEqual([])
})
