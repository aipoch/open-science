import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from '../../src/index'
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

it('captures the reported plot from native R with its diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r-plot-diagnostics-'))
  const sessionRoot = join(root, 'notebook')
  const dataRoot = join(sessionRoot, 'data')
  try {
    await mkdir(dataRoot, { recursive: true })
    expect(await analyzeNotebookSourceFileAccess('r', reportedBaseSine)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: [],
      writes: ['sin_plot.png']
    })
    const { stdout } = await promisify(execFile)(
      process.env.OPEN_SCIENCE_TEST_R_COMMAND || 'Rscript',
      ['--vanilla', '-e', reportedBaseSine],
      { cwd: dataRoot, timeout: 15000 }
    )
    expect(stdout).toContain('sin_plot.png')
    const image = await readFile(join(dataRoot, 'sin_plot.png'))
    expect(image.subarray(1, 4).toString()).toBe('PNG')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
