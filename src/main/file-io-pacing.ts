import { AsyncLocalStorage } from 'node:async_hooks'
import { Transform } from 'node:stream'

type FileIoPacer = (bytes: number, signal?: AbortSignal) => Promise<void>
const pacing = new AsyncLocalStorage<FileIoPacer>()

// Only descendants of an admitted transfer inherit its budget. Unrelated Session I/O and SQL
// never acquire this owner. This also covers existing provenance readers used for validation.
export const withFileIoPacing = <T>(pacer: FileIoPacer, work: () => T): T => pacing.run(pacer, work)
export const paceFileIo = (bytes: number, signal?: AbortSignal): Promise<void> | undefined =>
  pacing.getStore()?.(bytes, signal)

export const pacedFileTransform = (signal?: AbortSignal, passes = 1): Transform =>
  new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const pending = paceFileIo(chunk.byteLength * passes, signal)
      if (pending)
        pending.then(
          () => callback(null, chunk),
          (error: Error) => callback(error)
        )
      else callback(null, chunk)
    }
  })
