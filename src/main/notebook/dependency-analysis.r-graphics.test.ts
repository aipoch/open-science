import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeRNotebookSource, analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

// R's graphics and grDevices manuals define these as drawing/numeric calls,
// unlike locator(), curve(), or dev.copy(), which require additional state/evaluation.
// https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/00Index.html
// https://stat.ethz.ch/R-manual/R-devel/library/grDevices/html/dev2.html
const drawingCalls = [
  'arrows(1, 1, 2, 2)',
  'segments(1, 1, 2, 2)',
  'rect(0, 0, 1, 1)',
  'polygon(c(0, 1, 2), c(0, 2, 0))',
  'polypath(c(0, 1, 2), c(0, 2, 0))',
  'box()',
  'boxplot(c(1, 2, 3))',
  'hist(c(1, 2, 3))',
  'dotchart(c(1, 2, 3))',
  'rug(c(1, 2, 3))',
  'matplot(matrix(1:4, 2))',
  'matlines(matrix(1:4, 2))',
  'matpoints(matrix(1:4, 2))',
  'contour(matrix(1:4, 2))',
  'image(matrix(1:4, 2))',
  'rasterImage(grDevices::as.raster(matrix("red", 2, 2)), 0, 0, 1, 1)',
  'stripchart(c(1, 2, 3))',
  'symbols(1, 1, circles=1)',
  'plot.new()',
  'plot.window(c(0, 1), c(0, 1))',
  'clip(0, 1, 0, 1)',
  'strwidth("label")',
  'grconvertX(1)',
  'layout.show(1)'
]
it.each(drawingCalls)('recognizes drawing calls with and without graphics::: %s', async (call) => {
  for (const prefix of ['', 'graphics::']) {
    expect(await analyzeNotebookSourceFileAccess('r', `${prefix}${call}`)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  }
})

it.each([
  'adjustcolor("red", alpha.f=0.5)',
  'rgb(1, 0, 0)',
  'hcl.colors(3, "Viridis")',
  'palette.colors(3)',
  'col2rgb("red")',
  'grey.colors(3)',
  'boxplot.stats(1:3)',
  'dev.capabilities()',
  'dev.hold()',
  'dev.flush()',
  'graphics.off()'
])('recognizes grDevices helpers: %s', async (call) => {
  for (const prefix of ['', 'grDevices::']) {
    expect(await analyzeNotebookSourceFileAccess('r', `${prefix}${call}`)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  }
})

it.each(['png', 'pdf', 'cairo_pdf', 'cairo_ps', 'postscript', 'pictex', 'xfig'])(
  'captures the explicit output of %s with options before the path',
  async (device) => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `
      df <- read.csv("inputs/cohort.csv")
      grDevices::${device}(width=7, "figure.out")
      graphics::hist(df$value)
      graphics::segments(1, 0, 1, 2)
      grDevices::dev.off()
    `
    )
    expect(result).toEqual({
      reads: ['inputs/cohort.csv'],
      writes: ['figure.out'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reasonCodes: []
    })
  }
)

it('preserves the prior data dependency and recognizes nested input reads', async () => {
  const [facts] = await analyzeRSources([
    'png("distribution.png"); hist(values); rug(values); dev.off()'
  ])
  expect(facts).toMatchObject({
    state: 'available',
    priorUsedNames: expect.arrayContaining(['values'])
  })
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'png("labels.png"); plot(1); mtext(readLines("inputs/labels.txt")); dev.off()'
    )
  ).toMatchObject({ reads: ['inputs/labels.txt'], writes: ['labels.png'], readState: 'complete' })
})

it.each([
  'graphics::locator(1)',
  'graphics::identify(1:3)',
  'graphics::curve(custom(x))',
  'graphics::pairs(matrix(1:4,2), panel=custom)',
  'grDevices::dev.copy(device=custom, file="copy.png")',
  'grDevices::dev.print()',
  'grDevices::recordGraphics(custom(), list(), globalenv())',
  'grDevices::replayPlot(previous_plot)',
  'graphics::hist(custom_breaks())',
  'graphics::png("wrong.png")',
  'grDevices::segments(1,1,2,2)',
  'hist <- custom; hist(1:3)',
  'breaks <- function(x) { read.csv("hidden.csv"); 3 }; hist(1:3, breaks=breaks)',
  'hist(1:3, breaks=function(x) 3)'
])(
  'does not certify interactive, callback, wrong-namespace or shadowed calls: %s',
  async (code) => {
    expect((await analyzeNotebookSourceFileAccess('r', code)).readState).not.toBe('complete')
  }
)

it.each(['png("page-%03d.png")', 'pdf(file="page-%d.pdf", onefile=FALSE)', 'cairo_ps()'])(
  'does not claim an exact output without a concrete device path: %s',
  async (code) => {
    expect(await analyzeNotebookSourceFileAccess('r', code)).toMatchObject({
      writeState: 'partial',
      writes: []
    })
  }
)
it.each([
  'postscript(file="|printer")',
  'pdf(file="|printer")',
  'postscript(file="out.ps", print.it=TRUE)',
  'postscript(file="out.ps", print.it=flag)',
  'postscript(file="out.ps", command="printer")',
  'postscript(file="")',
  'postscript(file="page-%d.ps", print.it=TRUE)'
])('retains external-state gaps for piped/printed output: %s', async (code) => {
  expect((await analyzeNotebookSourceFileAccess('r', code)).externalState).toBe('partial')
})
it('does not lose PostScript encoding-file evidence', async () => {
  expect(
    (await analyzeNotebookSourceFileAccess('r', 'postscript("out.ps", encoding="custom.enc")'))
      .readState
  ).toBe('partial')
})
it('does not invent an output for an incorrectly qualified device', async () => {
  expect((await analyzeRNotebookSource('graphics::png("wrong.png")')).fileAccess?.writes).toEqual(
    []
  )
})

const scientificPlot = `
df <- read.csv("inputs/cohort.csv")
cols <- grDevices::hcl.colors(3, "Viridis")
grDevices::png("summary.png", width=800, height=400)
layout(matrix(1:2, nrow=1))
hist(df$value, breaks=c(0, 2, 4, 6), col=cols, main="Distribution")
rug(df$value)
arrows(2, 2, 2, 1, length=0.1)
mtext("cohort")
text.default(3, 1, labels=paste0("n = ", formatC(nrow(df), format="d")), pos=3)
legend("topright", legend=prettyNum(nrow(df)), bty="n")
boxplot(df$value, col=grDevices::adjustcolor("steelblue", alpha.f=0.5))
segments(0.7, 3, 1.3, 3, col="red")
points(1, 3, pch=19)
box()
grDevices::dev.off()
`
it('captures a scientific multi-panel graphics workflow', async () => {
  expect(await analyzeNotebookSourceFileAccess('r', scientificPlot)).toEqual({
    reads: ['inputs/cohort.csv'],
    writes: ['summary.png'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})
it.skipIf(!process.env.RUN_KERNEL || !process.env.OPEN_SCIENCE_TEST_R_ENV)(
  'renders and repeats the scientific graphics workflow in an isolated R directory',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'r-scientific-graphics-'))
    try {
      await mkdir(join(root, 'inputs'))
      await writeFile(join(root, 'inputs/cohort.csv'), 'value\n1\n2\n3\n4\n5\n')
      await writeFile(join(root, 'plot.R'), scientificPlot)
      const execute = (): Promise<{ stdout: string; stderr: string }> =>
        promisify(execFile)(
          join(process.env.OPEN_SCIENCE_TEST_R_ENV!, 'bin/Rscript'),
          ['--vanilla', 'plot.R'],
          { cwd: root, env: { ...process.env, LC_ALL: 'C' }, timeout: 20000 }
        )
      await execute()
      const first = await readFile(join(root, 'summary.png'))
      expect(first.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      await execute()
      expect(await readFile(join(root, 'summary.png'))).toEqual(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  45000
)

// Annotation values are evaluated; plotmath expressions are quoted data.
// https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/text.html
it.each([
  'text.default(1, 1, labels="sample", pos=3, offset=0.5, srt=30)',
  'graphics::text.default(1, 1, labels=c("Ctrl", "Case"), adj=c(0,1), xpd=NA)',
  'graphics::Axis(at=c(0, 1), labels=c("Ctrl", "Case"), side=1)',
  'graphics::points.default(1:3, c(2, 4, 3))',
  'graphics::lines.default(1:3, c(2, 4, 3))',
  'graphics::plot.default(1:3, c(2, 4, 3))',
  'graphics::barplot.default(c(33, 33))',
  'graphics::boxplot.default(c(1, 2, 3))',
  'graphics::hist.default(c(1, 2, 3))',
  'graphics::contour.default(matrix(1:4, 2))',
  'graphics::image.default(matrix(1:4, 2))',
  'text(1, 1, labels=formatC(0.125, format="f", digits=2))',
  'mtext(paste("n =", prettyNum(12345, big.mark=",")))',
  'axis(2, at=pretty(c(0, 100)), labels=format(pretty(c(0,100)), scientific=FALSE))',
  'legend("topright", legend=base::format.default(c(0.1, 0.2), digits=2))',
  'title(main=expression(alpha + beta), sub=sprintf("n = %d", 66))',
  'text(1, 1, labels=expression(italic(P) < 0.05, beta[1] == frac(a,b)))',
  'mtext(expression(log[2](fold~change)), side=2)',
  'legend("topright", legend=c("Ctrl", "Case"), pch=c(16,17), bty="n")'
])('captures base annotation forms: %s', async (code) => {
  expect(await analyzeNotebookSourceFileAccess('r', code)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: [],
    writes: []
  })
})
it.each([
  'formatC <- custom; text(1,1,formatC(2))',
  'text.default <- custom; text.default(1,1,"x")',
  'graphics::hist.default(1:3, breaks=function(x) read.csv("hidden.csv"))',
  'text(1,1,labels=bquote(alpha == .(custom())))',
  'text(1,1,labels=parse(text=custom()))',
  'grDevices::text.default(1,1,"x")',
  'graphics::formatC(2)'
])('keeps annotation evaluation boundaries: %s', async (code) => {
  expect((await analyzeNotebookSourceFileAccess('r', code)).readState).toBe('partial')
})
it('keeps nested label inputs and does not execute quoted plotmath calls', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `
    png("annotated.png")
    plot(1)
    text.default(1, 1, labels=format(readLines("inputs/labels.txt")))
    mtext(expression(read.csv("quoted.csv")))
    dev.off()
  `
    )
  ).toMatchObject({
    reads: ['inputs/labels.txt'],
    writes: ['annotated.png'],
    readState: 'complete'
  })
})
