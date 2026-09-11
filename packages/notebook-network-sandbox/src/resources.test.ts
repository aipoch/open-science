import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const sha256 = (relativePath: string): string =>
  createHash('sha256')
    .update(readFileSync(resolve(packageRoot, relativePath)))
    .digest('hex')

describe('Notebook network sandbox resources', () => {
  it.each([
    [
      'vendor/windows/x64/notebook-appcontainer-host.exe',
      '29ba89924a2e564f7e5d2a4527683d6a538c3cae324f4a8a9a373eab1505c925'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '5b1415f3192644ec999426d4a3564c0d54064998c74bd2b1807518990c4db1e4'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
