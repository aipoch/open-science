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
      'a365f2b57da75f41fd8ea730840ca49e45d270f56879400b8fbe84136fbb5b39'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '8c5f3783d3c0a0628ca753bb47fe526bfc51953e13674bbbc40b41b9367abf5f'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
