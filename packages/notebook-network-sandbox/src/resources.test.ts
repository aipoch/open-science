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
      '68e493b159a19050c37cc3530fdd600e87b7af054154c2cf948e1f37b5442be3'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'b2ecca8baa0ce5062ba723d9a01888461019f04c051dadd0fbb38c078133f7f3'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
