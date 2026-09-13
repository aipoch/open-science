import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import cells from './bh-r-welch-volcano.fixture.json'

// Uses the existing opt-in R runtime prefix, but requires only base R/stats.
// This checks numerical meaning separately from Notebook provenance and image replay.
const rPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV
if (process.env.RUN_KERNEL === '1' && !rPrefix) {
  throw new Error(
    'Real runtime certification requires OPEN_SCIENCE_TEST_R_ENV for Welch statistics'
  )
}
it.skipIf(!rPrefix)('preserves BH decisions and untestable contrasts in the Welch example', () => {
  const root = mkdtempSync(join(tmpdir(), 'welch-statistics-'))
  try {
    const computePath = join(root, 'compute.R')
    const classifyPath = join(root, 'classify.R')
    writeFileSync(computePath, cells.find((cell) => cell.runId === 'compute')!.script)
    writeFileSync(classifyPath, cells.find((cell) => cell.runId === 'classify')!.script)
    const testPath = join(root, 'assertions.R')
    writeFileSync(testPath, readFileSync(join(__dirname, 'welch-volcano-statistics.test.R')))
    const stdout = execFileSync(
      join(rPrefix!, 'bin', process.platform === 'win32' ? 'Rscript.exe' : 'Rscript'),
      ['--vanilla', testPath, computePath, classifyPath],
      { encoding: 'utf8', timeout: 30000 }
    )
    expect(stdout).toContain('All Welch scientific assertions passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
