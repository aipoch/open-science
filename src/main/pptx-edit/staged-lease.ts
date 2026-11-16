import { createHash } from 'node:crypto'

import type { ManagedPreviewTrustedLease } from '../managed-preview-resources'

// Wraps immutable in-memory bytes as a preview lease so the Office iframe can load a working copy
// that was never published as a managed Version.
const createStagedBytesLease = (
  name: string,
  bytes: Uint8Array,
  revision: number
): ManagedPreviewTrustedLease => ({
  path: name,
  size: bytes.byteLength,
  versionToken: revision,
  snapshot: {
    dev: 0n,
    ino: BigInt(revision),
    size: BigInt(bytes.byteLength),
    mtimeNs: BigInt(revision)
  },
  checksum: createHash('sha256').update(bytes).digest('hex'),
  read: async (buffer, offset, length, position) => {
    const slice = bytes.subarray(position, position + length)
    buffer.set(slice, offset)
    return { bytesRead: slice.byteLength }
  },
  readRange: async (begin, end) => bytes.slice(begin, end),
  verifyUnchanged: async () => undefined,
  close: async () => undefined
})

export { createStagedBytesLease }
