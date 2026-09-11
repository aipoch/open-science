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
      '25a8bcece66a700196a2412b9c38202738d9642ee2127f97b767c316184748ef'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '2b24a3c07618871ade588ec69b54d0857520e09873e9ab54820bf31c6df00a5b'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})
