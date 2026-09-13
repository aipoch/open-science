import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import cells from './bh-r-welch-volcano.fixture.json'

const runKernel = process.env.RUN_KERNEL === '1'
const rPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV
if (runKernel && !rPrefix) {
  throw new Error('Real plot certification requires OPEN_SCIENCE_TEST_R_ENV')
}

it.skipIf(!runKernel)(
  'renders Welch boundary cases and preserves CSV evidence when plotting fails',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'welch-plot-'))
    try {
      const paths = cells.map((cell) => {
        const path = join(root, `${cell.runId}.R`)
        writeFileSync(path, cell.script)
        return path
      })
      const assertions = join(root, 'assertions.R')
      writeFileSync(assertions, readFileSync(join(__dirname, 'welch-volcano-plot.test.R')))
      const stdout = execFileSync(
        join(rPrefix!, 'bin', process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'),
        ['--vanilla', assertions, ...paths],
        { cwd: root, encoding: 'utf8', timeout: 60000 }
      )
      expect(stdout).toContain('All Welch plot and export assertions passed')
      for (const name of ['ordinary', 'no_hits', 'all_missing', 'nonfinite', 'all_zero']) {
        const png = readFileSync(join(root, name, 'diagonal_volcano.png'))
        expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
        expect(png.readUInt32BE(16)).toBe(1800)
        expect(png.readUInt32BE(20)).toBe(1800)
        expect(png.length).toBeGreaterThan(1000)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  90000
)
