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
  it.each(['x64', 'arm64'])('ships the current display brand in the %s host', (architecture) => {
    const binary = readFileSync(
      resolve(packageRoot, `vendor/windows/${architecture}/notebook-appcontainer-host.exe`)
    )
    expect(binary.includes(Buffer.from('Open-Science Notebook'))).toBe(true)
    expect(binary.includes(Buffer.from('Open Science Notebook'))).toBe(false)
  })

  it.each([
    [
      'vendor/windows/x64/notebook-appcontainer-host.exe',
      'db63e4e273458c2e35f28efaa9ca875f8c9cfcda7ccc2b10536d4e4eea280222'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'bb2d0ed175ebd06d3f51f0b95e694a68e12dc8ffbd190aac25632288cefc73c7'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
