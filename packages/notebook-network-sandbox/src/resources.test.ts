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
      'e8cb1e0577abf6e06f5df975bfbe60e22e5ed225f4a75846fe387d765a884f4f'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'c2dd6644ca7c85d3f7f5a285cabb4480e35837e0f4363c7703e635d719d2fb86'
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
