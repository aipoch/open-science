import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import {
  resolveManagedOutputAuthority,
  type ManagedOutputAuthority
} from '../notebook/managed-output-authority'

const MAX_BYTES = 16 * 1024 * 1024
// Darwin fcntl.h O_NOFOLLOW_ANY: Node does not expose this flag, but open(2) rejects a
// symlink in every path component atomically. Fail closed if the host does not support it.
const NOFOLLOW_PATH = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW
const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isFile() &&
  right.nlink === 1n &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

export class ObservationProjectExportError extends Error {
  readonly name = 'ObservationProjectExportError'
  constructor() {
    super('The declared observation image is unavailable.')
  }
}

/** Main-only intake of a predeclared sandbox output, never a public file-reading endpoint. */
export async function readObservationProjectExport(input: {
  authority: ManagedOutputAuthority
  scope: { projectId: string; sessionId: string; operationId: string }
  path: string
  signal: AbortSignal
}): Promise<{ bytes: Uint8Array }> {
  try {
    input.signal.throwIfAborted()
    const initial = await resolveManagedOutputAuthority(input.authority, input.scope, input.path)
    const signal = AbortSignal.any([input.signal, initial.signal])
    signal.throwIfAborted()
    const before = await lstat(initial.path, { bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(MAX_BYTES)
    )
      throw new ObservationProjectExportError()
    const handle = await open(initial.path, constants.O_RDONLY | NOFOLLOW_PATH)
    try {
      signal.throwIfAborted()
      if (!sameFile(before, await handle.stat({ bigint: true })))
        throw new ObservationProjectExportError()
      const bytes = Buffer.alloc(Number(before.size))
      let offset = 0
      while (offset < bytes.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          Math.min(64 * 1024, bytes.length - offset),
          offset
        )
        if (!bytesRead) throw new ObservationProjectExportError()
        offset += bytesRead
      }
      signal.throwIfAborted()
      if (!sameFile(before, await handle.stat({ bigint: true })))
        throw new ObservationProjectExportError()
      const after = await resolveManagedOutputAuthority(input.authority, input.scope, input.path)
      signal.throwIfAborted()
      after.signal.throwIfAborted()
      if (
        after.path !== initial.path ||
        after.root !== initial.root ||
        !sameFile(before, await lstat(after.path, { bigint: true })) ||
        !sameFile(before, await handle.stat({ bigint: true }))
      )
        throw new ObservationProjectExportError()
      signal.throwIfAborted()
      return { bytes }
    } finally {
      await handle.close()
    }
  } catch {
    // Do not expose sandbox paths or filesystem diagnostics through the viewer API.
    throw new ObservationProjectExportError()
  }
}
