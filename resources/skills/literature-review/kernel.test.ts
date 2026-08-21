import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const python3 = [
  process.env.OPEN_SCIENCE_TEST_PY_ENV,
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3'
].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate))
const gate = python3 ? describe : describe.skip
const testFile = resolve(dirname(fileURLToPath(import.meta.url)), 'test_kernel.py')

gate('literature-review kernel', () => {
  it('passes its Python regression tests', () => {
    expect(() => execFileSync(python3 as string, [testFile], { timeout: 5_000 })).not.toThrow()
  })
})
