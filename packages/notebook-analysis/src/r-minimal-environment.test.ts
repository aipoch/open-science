import { describe, expect, it } from 'vitest'
import { canReplayRFileCodeInFreshSession, type RPackageBindings } from './r-minimal-environment'

const bindings = (): RPackageBindings => ({
  before: ['base', 'utils', 'stats', 'graphics', 'grDevices', 'methods', 'datasets', 'jsonlite'],
  after: ['base', 'utils', 'stats', 'graphics', 'grDevices', 'methods', 'datasets', 'jsonlite'],
  complete: true,
  cleanSession: true,
  reads: [
    ...[
      '<-',
      '=',
      '::',
      '$',
      '[',
      '[[',
      '-',
      '+',
      '*',
      '/',
      '>',
      '&',
      '!',
      'c',
      'pmax',
      'pmin',
      'log10',
      'is.finite',
      'is.na',
      'as.numeric',
      'ifelse',
      'nrow',
      'length',
      'as.matrix',
      'colnames',
      'rownames',
      'identical',
      'stopifnot'
    ].map((name) => ({ name, package: 'base' })),
    { name: 'read.csv', package: 'utils' },
    { name: 'write.csv', package: 'utils' },
    { name: '.subset2', package: 'base' },
    { name: 'png', package: 'grDevices' },
    { name: 'plot', package: 'graphics' },
    { name: 'plot.default', package: 'graphics' },
    { name: 'abline', package: 'graphics' },
    { name: 'dev.off', package: 'grDevices' }
  ]
})

// Locally read CSV columns are ordinary values; plotting uses an explicitly owned device.
const plotSource = `plotData <- read.csv("de-results.csv", row.names = 1, stringsAsFactors = FALSE)
png("volcano.png", width = 640, height = 480)
graphics::plot.default(plotData$log2FoldChange, -log10(pmax(plotData$pvalue, 1e-300)), pch = 16,
     xlab = "log2 fold change: treated / control", ylab = "-log10 p-value", main = "Synthetic DESeq2")
abline(v = c(-1, 1), h = -log10(0.05), lty = 2)
dev.off()`

// Original clean-stage source, with only the registered input filenames fixed for this fixture.
const cleanSource = `countData <- as.matrix(utils::read.csv("counts.csv", row.names = 1, check.names = FALSE, stringsAsFactors = FALSE))
sampleInfo <- utils::read.csv("metadata.csv", row.names = 1, stringsAsFactors = FALSE)
stopifnot(identical(colnames(countData), rownames(sampleInfo)))
utils::write.csv(countData, "clean-counts.csv", row.names = TRUE, na = "NA")
utils::write.csv(sampleInfo, "clean-metadata.csv", row.names = TRUE, na = "NA")`

describe('bounded R file code isolation', () => {
  const warmBindings = (): RPackageBindings => ({
    ...bindings(),
    cleanSession: false,
    before: ['DESeq2'],
    after: ['DESeq2']
  })

  it('proves local CSV values and an owned device without reducing a warm environment', async () => {
    expect(await canReplayRFileCodeInFreshSession(plotSource, warmBindings())).toBe('isolated')
    expect(await canReplayRFileCodeInFreshSession(cleanSource, warmBindings())).toBe('isolated')
  })

  it.each([
    plotSource.replace('png("volcano.png", width = 640, height = 480)', ''),
    `dev.off()\n${plotSource}`,
    plotSource.replace('dev.off()', ''),
    plotSource.replace('png("volcano.png",', 'png("extra.png"); png("volcano.png",'),
    plotSource + '\ngraphics::plot.default(c(1, 2), c(3, 4))',
    cleanSource + '\ngraphics::plot.default(c(1, 2), c(3, 4)); dev.off()'
  ])('rejects consumption of an implicit or unclosed device: %s', async (source) => {
    expect(await canReplayRFileCodeInFreshSession(source, warmBindings())).toBe('unavailable')
  })

  it.each(['$.data.frame', '[[.data.frame', 'as.matrix.data.frame', 'names.data.frame'])(
    'vetoes replay when a related method %s was defined earlier',
    async (method) => {
      const source =
        method === '[[.data.frame'
          ? plotSource.replaceAll('plotData$log2FoldChange', 'plotData[["log2FoldChange"]]')
          : method === 'as.matrix.data.frame' || method === 'names.data.frame'
            ? cleanSource
            : plotSource
      expect(await canReplayRFileCodeInFreshSession(source, warmBindings(), [method])).toBe(
        'method-conflict'
      )
    }
  )

  it('uses direct column extraction without invoking an unrelated custom method', async () => {
    const source = plotSource
      .replaceAll('plotData$log2FoldChange', 'base::.subset2(plotData, "log2FoldChange")')
      .replaceAll('plotData$pvalue', 'base::.subset2(plotData, "pvalue")')
    expect(await canReplayRFileCodeInFreshSession(source, warmBindings(), ['$.data.frame'])).toBe(
      'isolated'
    )
  })

  it('does not prove unknown bindings or old external values in a warm session', async () => {
    expect(await canReplayRFileCodeInFreshSession(plotSource)).toBe('unavailable')
    const masked = warmBindings()
    masked.reads.find(({ name }) => name === '$')!.package = 'custom'
    expect(await canReplayRFileCodeInFreshSession(plotSource, masked)).toBe('unavailable')
    expect(
      await canReplayRFileCodeInFreshSession(
        'png("plot.png"); graphics::plot.default(old$x, old$y); dev.off()',
        warmBindings()
      )
    ).toBe('unavailable')
  })
})

describe('bounded R file code source guards', () => {
  const withOwnedDevice = (source: string): string =>
    `grDevices::png("guard-test.png")\n${source}\ngrDevices::dev.off()`
  it('accepts the original local CSV clean stage with complete binding evidence', async () => {
    expect(await canReplayRFileCodeInFreshSession(cleanSource, bindings())).toBe('isolated')
  })

  it('rejects masked or unproven unqualified CSV preparation functions', async () => {
    const unqualified = cleanSource.replaceAll('utils::write.csv', 'write.csv')
    expect(await canReplayRFileCodeInFreshSession(unqualified, bindings())).toBe('isolated')
    const masked = bindings()
    masked.reads.find(({ name }) => name === 'write.csv')!.package = 'customPackage'
    expect(await canReplayRFileCodeInFreshSession(unqualified, masked)).toBe('unavailable')
    const missing = bindings()
    missing.reads = missing.reads.filter(({ name }) => name !== 'as.matrix')
    expect(await canReplayRFileCodeInFreshSession(cleanSource, missing)).toBe('unavailable')
  })

  it.each([
    cleanSource.replace('check.names = FALSE', 'colClasses = "custom"'),
    cleanSource.replace('as.matrix(utils::read.csv', 'as.matrix(custom_read.csv'),
    cleanSource.replace('colnames(countData)', 'colnames(unknownData)'),
    cleanSource.replace('write.csv(countData,', 'write.csv(unknownData,'),
    cleanSource.replace('as.matrix(utils::read.csv', 'custom_matrix(utils::read.csv'),
    cleanSource.replace('na = "NA"', 'quote = TRUE'),
    cleanSource.replace('row.names = TRUE', 'row.names = custom_callback()'),
    '`as.matrix.data.frame` <- function(x, ...) custom_matrix(x);\n' + cleanSource,
    cleanSource.replace('stopifnot(identical', 'stopifnot(custom_check'),
    cleanSource + '\ngraphics::plot.default(countData, countData)'
  ])(
    'rejects unsupported clean-stage objects, conversion, or write options: %s',
    async (source) => {
      expect(await canReplayRFileCodeInFreshSession(withOwnedDevice(source), bindings())).toBe(
        'unavailable'
      )
    }
  )

  it('accepts the bounded file-to-volcano source with an owned device', async () => {
    expect(await canReplayRFileCodeInFreshSession(plotSource, bindings())).toBe('isolated')
  })

  it('accepts local numeric vectors and explicitly qualified default R calls', async () => {
    expect(
      await canReplayRFileCodeInFreshSession(
        withOwnedDevice('graphics::plot.default(base::c(1, 2), base::c(3, 4))'),
        {
          ...bindings(),
          reads: [{ name: '::', package: 'base' }]
        }
      )
    ).toBe('isolated')
    expect(
      await canReplayRFileCodeInFreshSession(
        withOwnedDevice('x <- c(1, 2); graphics::plot.default(x, x + 1)'),
        bindings()
      )
    ).toBe('isolated')
  })

  it('preserves ordinary CSV columns through row filtering and numeric transforms', async () => {
    const source = `tab <- read.csv("de-results.csv", stringsAsFactors = FALSE)
x <- as.numeric(base::.subset2(tab, "log2FoldChange"))
y <- base::.subset2(tab, "pvalue")
keep <- is.finite(y) & !is.na(x)
x <- x[keep]
y <- -log10(pmax(y[keep], 1e-300))
graphics::plot.default(x, y)`
    expect(await canReplayRFileCodeInFreshSession(withOwnedDevice(source), bindings())).toBe(
      'isolated'
    )
  })

  it('accepts literal [[ column extraction only from a locally read plain CSV frame', async () => {
    expect(
      await canReplayRFileCodeInFreshSession(
        withOwnedDevice(`tab <- read.csv("de-results.csv", stringsAsFactors = FALSE)
graphics::plot.default(tab[["log2FoldChange"]], tab[["pvalue"]])`),
        bindings()
      )
    ).toBe('isolated')
    expect(
      await canReplayRFileCodeInFreshSession(
        withOwnedDevice(`tab <- read.csv("de-results.csv", stringsAsFactors = FALSE)
column <- "pvalue"
graphics::plot.default(tab[[column]], tab[[column]])`),
        bindings()
      )
    ).toBe('unavailable')
  })

  it('rejects a dataframe extraction method definition in the file consumer', async () => {
    expect(
      await canReplayRFileCodeInFreshSession(
        '`$.data.frame` <- function(x, name) custom_read();\n' + plotSource,
        bindings()
      )
    ).toBe('unavailable')
  })

  it.each([undefined, { ...bindings(), complete: false }])(
    'requires complete captured binding evidence',
    async (observed) => {
      expect(await canReplayRFileCodeInFreshSession(plotSource, observed)).toBe('unavailable')
    }
  )

  it('rejects missing, masked, or ambiguous call and operator bindings', async () => {
    const missing = bindings()
    missing.reads = missing.reads.filter(({ name }) => name !== 'log10')
    expect(await canReplayRFileCodeInFreshSession(plotSource, missing)).toBe('unavailable')
    const masked = bindings()
    masked.reads.find(({ name }) => name === 'log10')!.package = 'BiocGenerics'
    expect(await canReplayRFileCodeInFreshSession(plotSource, masked)).toBe('unavailable')
    const ambiguous = bindings()
    ambiguous.reads.push({ name: 'log10', package: 'BiocGenerics' })
    expect(await canReplayRFileCodeInFreshSession(plotSource, ambiguous)).toBe('unavailable')
    const operator = bindings()
    operator.reads = operator.reads.filter(({ name }) => name !== '::')
    expect(await canReplayRFileCodeInFreshSession(plotSource, operator)).toBe('unavailable')
    operator.reads = bindings().reads.filter(({ name }) => name !== '$')
    expect(await canReplayRFileCodeInFreshSession(plotSource, operator)).toBe('unavailable')
    operator.reads = bindings().reads.filter(({ name }) => name !== '[[')
    expect(
      await canReplayRFileCodeInFreshSession(
        withOwnedDevice(
          'tab <- read.csv("de-results.csv", stringsAsFactors = FALSE); graphics::plot.default(tab[["x"]], tab[["y"]])'
        ),
        operator
      )
    ).toBe('unavailable')
  })

  it.each([
    'plot(res$log2FoldChange, res$pvalue)',
    'plot(c(1, 2), c(3, 4))',
    'plot.default(c(1, 2), c(3, 4))',
    'tab <- read.csv("de-results.csv", stringsAsFactors = FALSE); tab <- tab[1, ]',
    'tab <- read.csv("de-results.csv"); graphics::plot.default(base::.subset2(tab, "x"), base::.subset2(tab, "y"))',
    'tab <- read.csv("de-results.csv", stringsAsFactors = TRUE); graphics::plot.default(base::.subset2(tab, "x"), base::.subset2(tab, "y"))',
    'x <- structure(c(1, 2), class = "custom"); plot(x, x)',
    'x <- readRDS("de-results.rds"); plot(x, x)',
    'x <- read.csv("de-results.csv", colClasses = "custom"); plot(x$v, x$v)',
    'x <- data.frame(value = c(1, 2)); class(x) <- "custom"; plot(x, x)',
    'library(DESeq2); plot(c(1, 2), c(3, 4))',
    'require("graphics"); plot(c(1, 2), c(3, 4))',
    'ggplot2::ggplot()',
    'base:::log10(1)',
    'plot <- custom_plot; plot(c(1, 2), c(3, 4))',
    'p <- plot; p(c(1, 2), c(3, 4))',
    'f <- function(x) x; plot(f(1), f(2))',
    'plot(lapply(c(1, 2), identity), c(3, 4))',
    'plot(c(1, 2), c(3, 4), panel.first = custom_plot())',
    'source("plot.R")',
    'eval(parse(text = "plot(1, 2)"))',
    'do.call("plot", list(1, 2))',
    'get("plot")(1, 2)',
    'plot(c(1, 2), c(3, 4)) + unknown_call()',
    'if (TRUE) plot(c(1, 2), c(3, 4))',
    'plot('
  ])('rejects unsupported values, dispatch, or execution: %s', async (source) => {
    expect(await canReplayRFileCodeInFreshSession(withOwnedDevice(source), bindings())).toBe(
      'unavailable'
    )
  })

  it('rejects oversized source and incomplete package-binding payloads', async () => {
    expect(await canReplayRFileCodeInFreshSession(' '.repeat(256 * 1024 + 1), bindings())).toBe(
      'unavailable'
    )
    expect(
      await canReplayRFileCodeInFreshSession(plotSource, {
        ...bindings(),
        reads: [{ name: 'plot', package: 'graphics', unknown: true }]
      } as unknown as RPackageBindings)
    ).toBe('unavailable')
  })
})
