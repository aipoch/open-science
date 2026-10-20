import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
export const MAX_REPRODUCIBILITY_OUTPUT_BYTES = 32 * 1024 * 1024
// Bounded, regular-file-only reads, including detection of replacement or writes
// while a kernel's output is being captured. Never follow a final symlink.
export const readReproducibilityOutputFile = async (path: string): Promise<Buffer> => {
  // Windows CreateFile ignores O_NOFOLLOW, so a symlink must be rejected before open.
  const identity = await lstat(path)
  if (identity.isSymbolicLink() || !identity.isFile() || identity.nlink !== 1) {
    throw new Error('Reproduced output cannot be retained.')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_REPRODUCIBILITY_OUTPUT_BYTES)
      throw new Error('Reproduced output cannot be retained.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new Error('Reproduced output changed while reading.')
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Reproduced output changed while reading.')
    return bytes
  } finally {
    await file.close()
  }
}
