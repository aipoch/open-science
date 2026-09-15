import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { defaultDiscoveryDeps } from './environment-discovery'

const prefix = process.env.OPEN_SCIENCE_TEST_R_CONDA_PREFIX

it.skipIf(process.platform !== 'win32' || !prefix)(
  'recognizes a runnable Windows conda R in the bin/x64 layout without an activated parent PATH',
  async () => {
    const executable = join(prefix!, 'Lib/R/bin/x64/Rscript.exe')
    const env = { ...process.env, PATH: join(process.env.SystemRoot!, 'System32') }
    // Independent control establishes that this real installation and its protocol package work.
    const control = await promisify(execFile)(
      executable,
      [
        '--vanilla',
        '-e',
        'stopifnot(requireNamespace("jsonlite", quietly=TRUE)); cat("R_DEPENDENCIES_OK")'
      ],
      {
        env: { ...env, PATH: `${join(prefix!, 'Library/bin')};${env.PATH}` },
        windowsHide: true,
        timeout: 15_000
      }
    )
    expect(control.stdout).toContain('R_DEPENDENCIES_OK')

    const discovery = defaultDiscoveryDeps(join(prefix!, 'unused-runtime'), undefined, { env })
    // Calls the existing public probe with real subprocesses, without replacing any collaborator.
    await expect(discovery.rRunnable(executable)).resolves.toBe(true)
  }
)
