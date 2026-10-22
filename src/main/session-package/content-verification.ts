import { lstat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { digestFileWithinBudget } from '../bounded-file-io'
import { assertWithinResourceBudget } from '../resource-budget'

const observation = (stat: Stats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`

// Reuse reads only within one validation pass, including immutable hardlink aliases. A changed
// observation requires a fresh digest; separate calls never trust an earlier import/export.
export const createPackageContentVerifier = (): typeof digestFileWithinBudget => {
  const verified = new Map<string, Awaited<ReturnType<typeof digestFileWithinBudget>>>()
  return async (path, maxBytes, signal) => {
    signal?.throwIfAborted()
    const before = await lstat(path)
    signal?.throwIfAborted()
    if (!before.isFile()) throw new Error('Session package content is not a regular file.')
    assertWithinResourceBudget('file', before.size, maxBytes)
    const key = observation(before)
    // Filesystems without a usable inode identity cannot establish that aliases share bytes.
    const reusable = Number.isSafeInteger(before.ino) && before.ino > 0
    const cached = reusable ? verified.get(key) : undefined
    if (cached) return cached
    const digest = await digestFileWithinBudget(path, maxBytes, signal)
    const after = await lstat(path)
    signal?.throwIfAborted()
    if (!after.isFile() || observation(after) !== key || digest.sizeBytes !== after.size)
      throw new Error('Session package content changed during validation.')
    if (reusable) verified.set(key, digest)
    return digest
  }
}
