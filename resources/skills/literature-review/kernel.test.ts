import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const configuredPython = process.env.OPEN_SCIENCE_TEST_PY_ENV
// Honor the shared test override and require the version used by the kernel's type annotations.
const candidates = configuredPython
  ? [configuredPython]
  : [
      'python3',
      'python3.14',
      'python3.13',
      'python3.12',
      'python3.11',
      'python3.10',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3'
    ]
const python3 = candidates.find(
  (candidate) =>
    spawnSync(candidate, ['-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], {
      timeout: 5_000,
      stdio: 'ignore'
    }).status === 0
)
if (configuredPython && !python3) {
  throw new Error('OPEN_SCIENCE_TEST_PY_ENV must point to a working Python 3.10+ executable.')
}
const gate = python3 ? describe : describe.skip
const testFile = resolve(dirname(fileURLToPath(import.meta.url)), 'test_kernel.py')

gate('literature-review kernel', () => {
  it('passes its Python regression tests', () => {
    expect(() => execFileSync(python3 as string, [testFile], { timeout: 5_000 })).not.toThrow()
  })
})
