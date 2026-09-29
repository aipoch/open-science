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
      '580f54e54bc87c218f1045b74e4942e68d03f6bd4b9f6a805162813a23ffe393'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'e5d102c3270a693afafdc44c88e4a3288816350cf525cdf9a2df542e8a554f5e'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
