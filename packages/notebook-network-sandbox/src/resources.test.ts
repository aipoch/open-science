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
      '16e2c00509dfc85739f60e56308562cf3f327ff07eec0da625d7579aed51c974'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '7dc991eaa2fa6d25ca9341649d2f5973990fb06a45d834df159d3d93cdb504c2'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
