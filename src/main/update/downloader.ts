import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'

import type { PlatformDownload } from '../../shared/update'

export type DownloadDeps = {
  fetchImpl?: typeof fetch
  onProgress?: (percent: number) => void
  // Aborts the request/stream when signalled; the reader rejects and the partial file is cleaned up.
  signal?: AbortSignal
}

// Streams the installer to `targetPath`, hashing as it goes. The sha256 comes from the manifest
// chunks (independent of file-flush timing), so a mismatch means a corrupt/tampered download — the
// partial file is removed and the caller sees an error rather than a broken installer.
export const downloadInstaller = async (
  download: PlatformDownload,
  targetPath: string,
  deps: DownloadDeps = {}
): Promise<string> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const response = await fetchImpl(download.url, { signal: deps.signal })
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)

  const hash = createHash('sha256')
  const file = createWriteStream(targetPath)
  const reader = response.body.getReader()

  // Guard against a write-stream error firing with no pending write callback
  // (e.g. between reads); without this Node throws it as an uncaught exception.
  let streamError: Error | null = null
  file.on('error', (err) => {
    streamError = err
  })

  const writeChunk = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => file.write(chunk, (err) => (err ? reject(err) : resolve())))

  try {
    let received = 0
    for (;;) {
      if (streamError) throw streamError
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      hash.update(chunk)
      await writeChunk(chunk)
      received += chunk.byteLength
      if (download.size > 0) deps.onProgress?.(Math.round((received / download.size) * 100))
    }
    if (streamError) throw streamError

    await new Promise<void>((resolve, reject) => {
      file.on('error', reject)
      file.end(() => resolve())
    })

    if (hash.digest('hex') !== download.sha256) {
      await rm(targetPath, { force: true })
      throw new Error('Checksum mismatch')
    }
    deps.onProgress?.(100)
    return targetPath
  } catch (error) {
    // Wait for the underlying fd to actually close before unlinking: createWriteStream opens
    // the file asynchronously, so destroy()-then-rm can race an in-flight open() and leave an
    // orphaned empty file behind.
    await new Promise<void>((resolve) => {
      if (file.destroyed) return resolve()
      file.once('close', () => resolve())
      file.destroy()
    })
    await rm(targetPath, { force: true })
    throw error
  }
}
