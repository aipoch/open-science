/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export function isMachO(header) {
  return (
    header.length >= 4 &&
    new Set([
      'feedface',
      'cefaedfe',
      'feedfacf',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca'
    ]).has(header.subarray(0, 4).toString('hex'))
  )
}
export async function verifyRuntimeSignatures(directory) {
  if (process.platform === 'linux') return
  if (process.platform === 'win32') {
    execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        join(import.meta.dirname, 'verify-runtime-signatures.ps1'),
        '-Directory',
        directory
      ],
      { stdio: 'inherit' }
    )
    return
  }
  let count = 0
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        const handle = await open(file, 'r')
        const header = Buffer.alloc(4)
        try {
          await handle.read(header, 0, 4, 0)
        } finally {
          await handle.close()
        }
        if (!isMachO(header)) continue
        // Check each loose binary, including Apple's notarization record for its code hash.
        execFileSync('codesign', ['--verify', '--strict', '--check-notarization', file], {
          stdio: 'pipe'
        })
        const details = spawnSync('codesign', ['--display', '--verbose=4', file], {
          encoding: 'utf8'
        })
        assert.equal(details.status, 0, details.stderr)
        assert.match(
          details.stderr,
          /Authority=Developer ID Application:/,
          `Missing Developer ID: ${file}`
        )
        count++
      }
    }
  }
  await visit(directory)
  assert.ok(count > 0, 'No Mach-O payloads found')
  console.log(`Verified ${count} notarized native payloads`)
}
