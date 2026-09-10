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
      '20e74529296a62156cc27cac64368c6f9a825affce370a4ade0cc249eb92b980'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '6f8b08c043574ac723fe0d3d464672133ba1f10ac6cb68c7899b2b703988682b'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
