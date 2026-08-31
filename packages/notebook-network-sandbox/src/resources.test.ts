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
      'b4e85dd93fb4b79bd2bb729eb9e5f2769da2bd9b89ac48ab4c066f411e68f888'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '7e8d0afa82feab7bba5b7e2b5e73c8a95407b4c4fddf56dd180a7370ff22fc57'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
