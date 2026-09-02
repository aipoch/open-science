import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseImageHeaderDimensions, readImageHeaderDimensions } from './image-header-dimensions'

const pngBuffer = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

const jpegBuffer = (width: number, height: number): Buffer => {
  const app0Payload = Buffer.alloc(14)
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(11, 0) // segment length includes its own two bytes
  sof[2] = 8 // sample precision
  sof.writeUInt16BE(height, 3)
  sof.writeUInt16BE(width, 5)
  sof[7] = 1 // component count
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]),
    Buffer.from([0x00, 0x10]),
    app0Payload,
    Buffer.from([0xff, 0xc0]),
    sof
  ])
}

const gifBuffer = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(13)
  buffer.write('GIF89a', 0, 'ascii')
  buffer.writeUInt16LE(width, 6)
  buffer.writeUInt16LE(height, 8)
  return buffer
}

const webpBuffer = (width: number, height: number, variant: 'VP8 ' | 'VP8L' | 'VP8X'): Buffer => {
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(22, 4)
  buffer.write('WEBP', 8, 'ascii')
  buffer.write(variant, 12, 'ascii')
  if (variant === 'VP8X') {
    buffer.writeUIntLE(width - 1, 24, 3)
    buffer.writeUIntLE(height - 1, 27, 3)
  } else if (variant === 'VP8L') {
    buffer[20] = 0x2f
    buffer.writeUInt32LE(((height - 1) << 14) | (width - 1), 21)
  } else {
    buffer[23] = 0x9d
    buffer[24] = 0x01
    buffer[25] = 0x2a
    buffer.writeUInt16LE(width, 26)
    buffer.writeUInt16LE(height, 28)
  }
  return buffer
}

const bmpBuffer = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(26)
  buffer.write('BM', 0, 'ascii')
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  return buffer
}

describe('parseImageHeaderDimensions', () => {
  it('parses PNG IHDR dimensions', () => {
    expect(parseImageHeaderDimensions(pngBuffer(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('parses JPEG dimensions by scanning past APP segments to the SOF marker', () => {
    expect(parseImageHeaderDimensions(jpegBuffer(640, 400))).toEqual({ width: 640, height: 400 })
  })

  it('parses GIF logical screen dimensions', () => {
    expect(parseImageHeaderDimensions(gifBuffer(320, 200))).toEqual({ width: 320, height: 200 })
  })

  it.each(['VP8 ', 'VP8L', 'VP8X'] as const)('parses WebP %s dimensions', (variant) => {
    expect(parseImageHeaderDimensions(webpBuffer(800, 600, variant))).toEqual({
      width: 800,
      height: 600
    })
  })

  it('parses BMP dimensions, including top-down bitmaps with negative height', () => {
    expect(parseImageHeaderDimensions(bmpBuffer(1024, 768))).toEqual({ width: 1024, height: 768 })
    expect(parseImageHeaderDimensions(bmpBuffer(1024, -768))).toEqual({ width: 1024, height: 768 })
  })

  it('returns undefined for truncated headers', () => {
    expect(parseImageHeaderDimensions(pngBuffer(10, 10).subarray(0, 12))).toBeUndefined()
    expect(parseImageHeaderDimensions(jpegBuffer(10, 10).subarray(0, 8))).toBeUndefined()
    expect(parseImageHeaderDimensions(gifBuffer(10, 10).subarray(0, 6))).toBeUndefined()
    expect(parseImageHeaderDimensions(webpBuffer(10, 10, 'VP8X').subarray(0, 22))).toBeUndefined()
  })

  it('returns undefined for forged headers', () => {
    const forgedPng = pngBuffer(10, 10)
    forgedPng.write('XXXX', 12, 'ascii') // not an IHDR chunk
    expect(parseImageHeaderDimensions(forgedPng)).toBeUndefined()

    const forgedWebp = webpBuffer(10, 10, 'VP8 ')
    forgedWebp[23] = 0x00 // broken lossy sync code
    expect(parseImageHeaderDimensions(forgedWebp)).toBeUndefined()
  })

  it('returns undefined for implausible dimensions', () => {
    expect(parseImageHeaderDimensions(pngBuffer(0, 100))).toBeUndefined()
    expect(parseImageHeaderDimensions(gifBuffer(0, 0))).toBeUndefined()
  })

  it('returns undefined for unknown formats', () => {
    expect(parseImageHeaderDimensions(Buffer.from('not an image at all'))).toBeUndefined()
    expect(parseImageHeaderDimensions(Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBeUndefined() // %PDF
  })
})

describe('readImageHeaderDimensions', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'image-header-dimensions-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('reads dimensions from a file on disk', async () => {
    const filePath = join(directory, 'plot.png')
    await writeFile(filePath, Buffer.concat([pngBuffer(48, 32), Buffer.alloc(1024)]))
    await expect(readImageHeaderDimensions(filePath)).resolves.toEqual({ width: 48, height: 32 })
  })

  it('degrades to undefined for missing or unreadable files instead of throwing', async () => {
    await expect(readImageHeaderDimensions(join(directory, 'missing.png'))).resolves.toBeUndefined()
  })
})
