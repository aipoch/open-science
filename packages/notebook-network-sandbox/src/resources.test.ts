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
      '87c2be7e94e13457656aafcda3906782f9ddb9827a8f5d236a03b9d1a9ff265b'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '5eaece3e03562395bd8c77d768abf57708085f41e9f7de53bbada0200c1cd82c'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
