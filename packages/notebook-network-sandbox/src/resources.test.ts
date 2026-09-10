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
      '0225e1e922d5d2831e27f1ece326d39d511704ec0c1dc07a302d0ca5cfe4bba6'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'b4f9eaded9a6639f54274ac0762e663f024406a689d1fe647e8b083c0b059ff8'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
