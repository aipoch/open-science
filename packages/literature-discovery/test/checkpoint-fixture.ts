import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CheckpointStorage, WriteAdmission } from '../src/ports.js'
export class RecoveryBarrier extends Error {}
// Real files, atomic publication and restart, without borrowing the application's filesystem
// recovery implementation. The host suite separately exercises its temp recovery/fsync adapter.
export const checkpoints: CheckpointStorage = {
  async read(path, decode, maxBytes) {
    try {
      if ((await stat(path)).size > maxBytes) throw new RecoveryBarrier('Read limit exceeded')
      return { status: 'found', value: decode(await readFile(path, 'utf8')) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      throw error
    }
  },
  async write(path, contents) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, contents)
    await rename(tmp, path)
  },
  async recoverDirectory() {
    /* This fixture leaves no interrupted temporary writes. */
  },
  recoveryBarrier: (message) => new RecoveryBarrier(message)
}
let writers = 0
const waiting = new Set<() => void>()
export const admission: WriteAdmission = {
  acquireWriter: () => {
    writers++
    return () => {
      if (--writers === 0) {
        for (const resolve of waiting) resolve()
        waiting.clear()
      }
    }
  },
  isPending: () => false,
  withWrite: (operation) => operation()
}
export const waitForWriters = (): Promise<void> =>
  writers ? new Promise((resolve) => waiting.add(resolve)) : Promise.resolve()
export const jobOptions = {
  checkpoints,
  admission,
  oversizedError: (id: string) => new Error(`oversized:${id}`)
}
