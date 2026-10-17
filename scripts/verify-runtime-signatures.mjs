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
        const header = Buffer.alloc(16)
        let bytesRead
        try {
          const result = await handle.read(header, 0, header.length, 0)
          bytesRead = result.bytesRead
        } finally {
          await handle.close()
        }
        if (!isMachO(header)) continue
        assert.equal(bytesRead, header.length, `Truncated Mach-O header: ${file}`)
        // mach_header.filetype is at offset 12 in both 32- and 64-bit thin headers.
        // MH_OBJECT (1) is linker input, not a signed runtime image. Keep universal
        // binaries and every other Mach-O type subject to the existing checks.
        const magic = header.subarray(0, 4).toString('hex')
        if (
          (['feedface', 'feedfacf'].includes(magic) && header.readUInt32BE(12) === 1) ||
          (['cefaedfe', 'cffaedfe'].includes(magic) && header.readUInt32LE(12) === 1)
        )
          continue
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
