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
      '8393f9e27fdd4266dadc0de0d214a3a1f99b473826381f4631da7c2fe5f43436'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '7e8d0afa82feab7bba5b7e2b5e73c8a95407b4c4fddf56dd180a7370ff22fc57'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
