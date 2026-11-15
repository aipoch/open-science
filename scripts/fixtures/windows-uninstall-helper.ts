import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let executable: string | undefined

// Compiles the uninstall helper once per test file, with the test-only seams that redirect the
// ApplicationData root, inject a process inventory, and intercept elevation. The shipped helper is
// built without OPEN_SCIENCE_HELPER_TEST_SEAMS and has none of them.
export const uninstallHelperExecutable = (): string => {
  if (executable) return executable
  const output = join(
    mkdtempSync(join(tmpdir(), 'uninstall-helper-')),
    'windows-uninstall-helper.exe'
  )
  createRequire(import.meta.url)(
    '../../build/compile-windows-install-publication.cjs'
  ).uninstallHelper(output, ['OPEN_SCIENCE_HELPER_TEST_SEAMS'])
  executable = output
  return output
}

export const runUninstallHelper = (
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): SpawnSyncReturns<string> =>
  spawnSync(uninstallHelperExecutable(), args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 30_000
  })
