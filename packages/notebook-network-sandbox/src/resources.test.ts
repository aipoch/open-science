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
      'ac4a72dea29f00461871b612b762c0a7a6e818c3cb72a1013aabb7305f9fd0df'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'e5d102c3270a693afafdc44c88e4a3288816350cf525cdf9a2df542e8a554f5e'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
