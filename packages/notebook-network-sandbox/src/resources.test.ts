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
      'd987b83b16c252ffa2adc9d1fa2cb50fedacd97dbcc5ddaf38b43babd3516d8a'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'e29c00b41accff0fce742a3a12366f509e55dd358e81a66e88b80e033a6c63cf'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
