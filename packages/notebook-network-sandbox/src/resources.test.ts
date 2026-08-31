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
      'd280e083aa1fda5903f4d5e35b2f57117d4f2e1ff77e1084a0a8a8bfc40db669'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '389e8c8a7c2a6e584630d35e16bb02b01165528dd0a30025db94ac2f54d717c1'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
