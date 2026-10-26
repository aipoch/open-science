import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const sha256 = (relativePath: string): string =>
  createHash('sha256')
    .update(
      execFileSync('git', ['show', `HEAD:packages/notebook-network-sandbox/${relativePath}`], {
        cwd: packageRoot
      })
    )
    .digest('hex')

describe('Notebook network sandbox resources', () => {
  it.each([
    [
      'vendor/windows/x64/notebook-appcontainer-host.exe',
      'dbdb1a6b75c5bdc71b3202a0b14c22112d4221552dba90415476a8d2610964d5'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      '8c5f3783d3c0a0628ca753bb47fe526bfc51953e13674bbbc40b41b9367abf5f'
    ]
  ])('verifies committed %s', (relativePath, expectedHash) => {
    // CI rebuilds the working copy from source; fixed hashes describe the committed fallback.
    expect(sha256(relativePath)).toBe(expectedHash)
  })

  it.each([
    ['x64', 0x8664],
    ['arm64', 0xaa64]
  ] as const)('ships a valid %s Windows executable', (architecture, machine) => {
    const bytes = readFileSync(
      resolve(packageRoot, `vendor/windows/${architecture}/notebook-appcontainer-host.exe`)
    )
    expect(bytes.subarray(0, 2).toString()).toBe('MZ')
    const pe = bytes.readUInt32LE(0x3c)
    expect(bytes.subarray(pe, pe + 4)).toEqual(Buffer.from([0x50, 0x45, 0, 0]))
    expect(bytes.readUInt16LE(pe + 4)).toBe(machine)
  })
})
