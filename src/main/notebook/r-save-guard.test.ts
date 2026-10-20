import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(!process.env.OPEN_SCIENCE_TEST_RSCRIPT)(
  'preserves save symbols, promises and caller environments without weakening runtime write protection',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'r-save-guard-'))
    try {
      const runtimeRoot = join(root, 'managed')
      await mkdir(runtimeRoot)
      const code = await readFile(join(__dirname, 'fixtures/lineage/r-save-promises.R'))
      const prefix = process.env.OPEN_SCIENCE_TEST_R_PREFIX
      const path = prefix
        ? [
            join(prefix, 'Library', 'bin'),
            join(prefix, 'Scripts'),
            join(prefix, 'bin'),
            process.env.PATH
          ].join(delimiter)
        : process.env.PATH
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.env.OPEN_SCIENCE_TEST_RSCRIPT!,
          ['--vanilla', join(__dirname, '../../../resources/notebook/r_loop.R')],
          {
            cwd: root,
            env: { ...process.env, PATH: path, OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot },
            windowsHide: true,
            timeout: 30000
          }
        )
        const stdout: Buffer[] = [],
          stderr: Buffer[] = []
        child.stdout.on('data', (chunk) => stdout.push(chunk))
        child.stderr.on('data', (chunk) => stderr.push(chunk))
        child.on('error', reject)
        child.stdin.on('error', reject)
        child.on('close', (code) =>
          code === 0
            ? resolve(Buffer.concat(stdout).toString('utf8'))
            : reject(new Error(`R exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
        )
        child.stdin.end(Buffer.concat([Buffer.from(`save-test ${code.length}\n`), code]))
      })
      const result = JSON.parse(output.trim())
      expect(result.error).toBeNull()
      expect(result.stdout).toContain('SAVE_GUARD_OK')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  45000
)
