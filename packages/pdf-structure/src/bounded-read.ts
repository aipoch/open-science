import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const BOUNDED_READ_CHUNK_BYTES = 64 * 1024

export const readFileWithinLimit = async (path: string, maxBytes: number): Promise<string> => {
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error(`${basename(path)} is not a regular file.`)
    if (metadata.size > maxBytes)
      throw new Error(`${basename(path)} exceeds the ${maxBytes} byte read limit.`)

    const decoder = new StringDecoder('utf8')
    const parts: string[] = []
    // StringDecoder consumes each chunk synchronously, so subsequent reads can reuse it.
    const buffer = Buffer.allocUnsafe(Math.min(BOUNDED_READ_CHUNK_BYTES, maxBytes + 1))
    let bytesReadTotal = 0
    while (bytesReadTotal <= maxBytes) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes + 1 - bytesReadTotal),
        null
      )
      if (bytesRead === 0) break
      bytesReadTotal += bytesRead
      if (bytesReadTotal > maxBytes) {
        throw new Error(`${basename(path)} exceeds the ${maxBytes} byte read limit.`)
      }
      parts.push(decoder.write(buffer.subarray(0, bytesRead)))
    }
    parts.push(decoder.end())
    return parts.join('')
  } finally {
    await file.close()
  }
}
