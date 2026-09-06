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
      '948c8e09a304b533e36d5fccab149fb46f763ca104131fe50874a2f96d8c2e5c'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '4c759fa45271a8ff386f00ded62b621d651f0aeae71fb1f20e05094a80372337'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
