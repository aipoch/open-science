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
      '91c58e50d59751723ad41df5d13836faabeb2036b4ec25714d97fee8db74aef9'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '24cb35550c35cfad4ddf46891e7769f46b4eacb03124c2a8d8c114e2f429777b'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
