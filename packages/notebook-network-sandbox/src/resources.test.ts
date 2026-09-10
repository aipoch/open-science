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
      '26b0b3d677255fd128e5f60764d814e3b4aa924567da1cc404d63f93c19d73b8'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'cee1971fbfe04be540b76f3a5d73e0354207b02071cbafbc5a65c77f74e951d1'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
