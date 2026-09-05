import { mkdtemp, open, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildImageContentData,
  canInlineImageInSession,
  consumeInlineImageBudget,
  extractPdfText,
  extractPdfTextPages,
  inspectPdfPageCount,
  ImageContentError,
  MAX_AUTO_EXTRACT_PDF_BYTES,
  MAX_AUTO_PROCESS_IMAGE_BYTES,
  MAX_CONCURRENT_PDF_TEXT_EXTRACTIONS,
  MAX_IMAGE_PAYLOAD_BYTES,
  MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES,
  MAX_SESSION_INLINE_IMAGE_BYTES,
  prepareImageContentData,
  type ImageContentData
} from './attachment-media'

// A configurable processor double keeps policy/error tests deterministic. The separate
// attachment-media.sharp test exercises the real cross-platform adapter and image fixtures.
type FakeImage = {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  crop: ReturnType<
    typeof vi.fn<(options: { x: number; y: number; width: number; height: number }) => FakeImage>
  >
  resize: ReturnType<
    typeof vi.fn<(options: { width: number; height: number; quality: 'better' }) => FakeImage>
  >
  toJPEG: (quality: number) => Buffer
  toPNG: () => Buffer
  hasAlpha?: boolean
  isOpaque?: boolean
}

type FakeSharpPipeline = {
  metadata: ReturnType<
    typeof vi.fn<
      () => Promise<{
        width: number
        height: number
        autoOrient: { width: number; height: number }
        hasAlpha: boolean
      }>
    >
  >
  clone: () => FakeSharpPipeline
  autoOrient: () => FakeSharpPipeline
  extract: (options: {
    left: number
    top: number
    width: number
    height: number
  }) => FakeSharpPipeline
  resize: (width: number, height: number) => FakeSharpPipeline
  ensureAlpha: () => FakeSharpPipeline
  raw: () => FakeSharpPipeline
  png: () => FakeSharpPipeline
  jpeg: (options: { quality: number }) => FakeSharpPipeline
  toBuffer: ReturnType<
    typeof vi.fn<
      (options?: {
        resolveWithObject?: boolean
      }) => Promise<Buffer | { data: Buffer; info: { channels: number } }>
    >
  >
}

let fakeImage: FakeImage
const makeSharpPipeline = (input: Buffer): FakeSharpPipeline => {
  let encode = (): Buffer => fakeImage.toPNG()
  const pipeline = {
    metadata: vi.fn(async () => {
      if (fakeImage.isEmpty()) throw new Error('decode failed')
      const size = fakeImage.getSize()
      const inputIsPng = input[0] === 0x89 && input[1] === 0x50
      return {
        ...size,
        autoOrient: size,
        hasAlpha: fakeImage.hasAlpha ?? inputIsPng
      }
    }),
    clone: () => makeSharpPipeline(input),
    autoOrient() {
      return this
    },
    extract({
      left,
      top,
      width,
      height
    }: {
      left: number
      top: number
      width: number
      height: number
    }) {
      fakeImage.crop({ x: left, y: top, width, height })
      return this
    },
    resize(width: number, height: number) {
      fakeImage.resize({ width, height, quality: 'better' })
      return this
    },
    ensureAlpha() {
      return this
    },
    raw() {
      return this
    },
    png() {
      encode = () => fakeImage.toPNG()
      return this
    },
    jpeg({ quality }: { quality: number }) {
      encode = () => fakeImage.toJPEG(quality)
      return this
    },
    toBuffer: vi.fn(async (options?: { resolveWithObject?: boolean }) =>
      options?.resolveWithObject
        ? {
            data: Buffer.from([0, 0, 0, fakeImage.isOpaque === true ? 0xff : 0]),
            info: { channels: 4 }
          }
        : encode()
    )
  }
  return pipeline
}
const sharpFactory = vi.fn((input: Buffer) => makeSharpPipeline(input))

vi.mock('sharp', () => ({ default: (input: Buffer) => sharpFactory(input) }))

// A fake pdfjs document so text extraction is deterministic and does not parse a real PDF.
let beforePdfPageRead: (() => Promise<void>) | undefined
type FakePdfTextItem =
  | string
  | Readonly<{
      str: string
      transform: readonly number[]
      width: number
      height: number
      dir?: string
    }>
let fakePdf: { numPages: number; pages: FakePdfTextItem[][] }
type FakePdfDocument = {
  promise: Promise<{
    numPages: number
    getPage: (pageNumber: number) => Promise<{
      getTextContent: () => Promise<{ items: unknown[] }>
      cleanup: () => void
    }>
    destroy: () => Promise<void>
  }>
}
const getDocument = vi.fn<(options?: { data?: Uint8Array }) => FakePdfDocument>(() => ({
  promise: Promise.resolve({
    numPages: fakePdf.numPages,
    getPage: async (pageNumber: number) => ({
      getTextContent: async () => {
        await beforePdfPageRead?.()
        return {
          items: (fakePdf.pages[pageNumber - 1] ?? []).map((item) =>
            typeof item === 'string' ? { str: item } : item
          )
        }
      },
      cleanup: () => {}
    }),
    destroy: async () => {}
  })
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: (options?: unknown) => getDocument(options as { data?: Uint8Array } | undefined)
}))

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'attachment-media-'))
  sharpFactory.mockClear()
  getDocument.mockClear()
  beforePdfPageRead = undefined
  fakeImage = {
    isEmpty: () => false,
    getSize: () => ({ width: 4000, height: 2000 }),
    crop: vi.fn(function (this: FakeImage) {
      return this
    }),
    resize: vi.fn(function (this: FakeImage) {
      return this
    }),
    toJPEG: (quality: number) => Buffer.from(`jpeg-${quality}`),
    toPNG: () => Buffer.from('png-bytes')
  }
  fakePdf = {
    numPages: 2,
    pages: [
      ['Hello', ' world'],
      ['Second', ' page']
    ]
  }
})

describe('prepareImageContentData', () => {
  const pngFixture = (width: number, height: number): Buffer => {
    const bytes = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    bytes.writeUInt32BE(13, 8)
    bytes.write('IHDR', 12, 'ascii')
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    bytes[24] = 8
    bytes[25] = 6
    return bytes
  }

  const jpegSegment = (marker: number, payload: Buffer): Buffer => {
    const bytes = Buffer.alloc(payload.length + 4)
    bytes[0] = 0xff
    bytes[1] = marker
    bytes.writeUInt16BE(payload.length + 2, 2)
    payload.copy(bytes, 4)
    return bytes
  }

  const jpegFrameSegment = (width: number, height: number): Buffer => {
    const payload = Buffer.alloc(15)
    payload[0] = 8
    payload.writeUInt16BE(height, 1)
    payload.writeUInt16BE(width, 3)
    payload[5] = 3
    Buffer.from([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]).copy(payload, 6)
    return jpegSegment(0xc0, payload)
  }

  const jpegFixture = (width: number, height: number, prefixes: Buffer[] = []): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xd8]), ...prefixes, jpegFrameSegment(width, height)])

  const writePng = (path: string, width = 4000, height = 2000): Promise<void> =>
    writeFile(path, pngFixture(width, height))

  it('resolves fraction crops outward before resizing the cropped image', async () => {
    fakeImage.getSize = () => ({ width: 101, height: 51 })
    const filePath = join(root, 'fraction.png')
    await writeFile(filePath, pngFixture(101, 51))

    const result = await prepareImageContentData(filePath, {
      crop: { unit: 'fraction', left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 },
      maxSize: 40
    })

    expect(fakeImage.crop).toHaveBeenCalledWith({ x: 10, y: 10, width: 71, height: 36 })
    expect(fakeImage.resize).toHaveBeenCalledWith({ width: 40, height: 20, quality: 'better' })
    expect(result).toEqual({
      data: Buffer.from('png-bytes').toString('base64'),
      mimeType: 'image/png',
      originalSize: { width: 101, height: 51 },
      crop: { left: 10, top: 10, right: 81, bottom: 46 },
      outputSize: { width: 40, height: 20 }
    })
  })

  it('accepts JPEG by signature and never upscales a smaller oriented image', async () => {
    fakeImage.getSize = () => ({ width: 100, height: 50 })
    const filePath = join(root, 'small.jpg')
    await writeFile(filePath, jpegFixture(100, 50))

    await expect(prepareImageContentData(filePath)).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      originalSize: { width: 100, height: 50 },
      outputSize: { width: 100, height: 50 }
    })
    expect(fakeImage.resize).not.toHaveBeenCalled()
  })

  it('skips valid JPEG metadata and table segments before the frame header', async () => {
    fakeImage.getSize = () => ({ width: 120, height: 80 })
    const filePath = join(root, 'prefixed.jpg')
    await writeFile(
      filePath,
      jpegFixture(120, 80, [
        jpegSegment(0xe0, Buffer.from('JFIF\0', 'ascii')),
        jpegSegment(0xdb, Buffer.alloc(65, 1))
      ])
    )

    await expect(prepareImageContentData(filePath)).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      originalSize: { width: 120, height: 80 }
    })
    expect(sharpFactory).toHaveBeenCalledOnce()
  })

  it('rejects malformed JPEG frame markers before native decode', async () => {
    const malformedShortFrame = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x00
    ])
    const mismatchedComponentFrame = jpegSegment(
      0xc0,
      Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00])
    )

    for (const [name, bytes] of [
      ['short-sof.jpg', Buffer.concat([malformedShortFrame, jpegFrameSegment(5000, 4000)])],
      [
        'mismatched-sof.jpg',
        Buffer.concat([
          Buffer.from([0xff, 0xd8]),
          mismatchedComponentFrame,
          jpegFrameSegment(5000, 4000)
        ])
      ],
      [
        'repeated-soi.jpg',
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd8]), jpegFrameSegment(1, 1)])
      ],
      [
        'restart-before-sof.jpg',
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd0]), jpegFrameSegment(1, 1)])
      ]
    ] as const) {
      const filePath = join(root, name)
      await writeFile(filePath, bytes)
      await expect(prepareImageContentData(filePath)).rejects.toMatchObject({
        code: 'IMAGE_DECODE_FAILED'
      })
    }
    expect(sharpFactory).not.toHaveBeenCalled()
  })

  it('rejects a truncated PNG IHDR before native decode', async () => {
    const filePath = join(root, 'truncated.png')
    await writeFile(filePath, pngFixture(1, 1).subarray(0, 32))

    await expect(prepareImageContentData(filePath)).rejects.toMatchObject({
      code: 'IMAGE_DECODE_FAILED'
    })
    expect(sharpFactory).not.toHaveBeenCalled()
  })

  it('rejects SVG and optional formats before invoking the native decoder', async () => {
    for (const [name, bytes] of [
      ['image.svg', Buffer.from('<svg/>')],
      ['image.webp', Buffer.from('RIFFxxxxWEBP')],
      ['image.gif', Buffer.from('GIF89a')]
    ] as const) {
      await writeFile(join(root, name), bytes)
      await expect(prepareImageContentData(join(root, name))).rejects.toMatchObject({
        code: 'IMAGE_DECODE_FAILED'
      })
    }
    expect(sharpFactory).not.toHaveBeenCalled()
  })

  it('rejects source bytes and declared pixels before native decode or crop/resize allocations', async () => {
    const oversized = join(root, 'oversized.png')
    await writePng(oversized)
    await truncate(oversized, MAX_AUTO_PROCESS_IMAGE_BYTES + 1)
    await expect(prepareImageContentData(oversized)).rejects.toMatchObject({
      code: 'IMAGE_SOURCE_TOO_LARGE'
    })

    for (const [name, bytes] of [
      ['bomb.png', pngFixture(5000, 4000)],
      ['bomb.jpg', jpegFixture(5000, 4000)]
    ] as const) {
      const bomb = join(root, name)
      await writeFile(bomb, bytes)
      await expect(prepareImageContentData(bomb)).rejects.toThrow(/pixel processing limit/u)
    }
    expect(sharpFactory).not.toHaveBeenCalled()
    expect(fakeImage.crop).not.toHaveBeenCalled()
    expect(fakeImage.resize).not.toHaveBeenCalled()
  })

  it('rechecks the bytes returned by readFile when a source grows after stat', async () => {
    const filePath = join(root, 'growing.png')
    await writePng(filePath, 100, 60)
    const probe = await open(filePath, 'r')
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      readFile: typeof probe.readFile
    }
    await probe.close()
    const readFile = vi
      .spyOn(fileHandlePrototype, 'readFile')
      .mockResolvedValueOnce(Buffer.alloc(MAX_AUTO_PROCESS_IMAGE_BYTES + 1))

    try {
      await expect(prepareImageContentData(filePath)).rejects.toMatchObject({
        code: 'IMAGE_SOURCE_TOO_LARGE',
        sourceBytes: MAX_AUTO_PROCESS_IMAGE_BYTES + 1
      })
      expect(sharpFactory).not.toHaveBeenCalled()
    } finally {
      readFile.mockRestore()
    }
  })

  it('validates pixel crop bounds and preserves PNG output for cropped PNG input', async () => {
    const filePath = join(root, 'crop.png')
    await writePng(filePath, 1568, 784)
    fakeImage.getSize = () => ({ width: 100, height: 60 })

    await expect(
      prepareImageContentData(filePath, {
        crop: { unit: 'pixels', left: 10, top: 5, right: 90, bottom: 55 }
      })
    ).resolves.toMatchObject({
      mimeType: 'image/png',
      crop: { left: 10, top: 5, right: 90, bottom: 55 }
    })
    expect(fakeImage.crop).toHaveBeenCalledWith({ x: 10, y: 5, width: 80, height: 50 })

    await expect(
      prepareImageContentData(filePath, {
        crop: { unit: 'pixels', left: 0, top: 0, right: 101, bottom: 60 }
      })
    ).rejects.toThrow(/outside the image bounds/u)
  })

  it('downscales oversized PNG output without converting away transparency', async () => {
    const filePath = join(root, 'transparent.png')
    await writePng(filePath)
    fakeImage.getSize = () => ({ width: 1568, height: 784 })
    fakeImage.toPNG = vi
      .fn()
      .mockReturnValueOnce(Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES + 1))
      .mockReturnValueOnce(Buffer.from('transparent-png'))
    fakeImage.toJPEG = vi.fn(() => Buffer.from('jpeg'))

    await expect(prepareImageContentData(filePath)).resolves.toMatchObject({
      mimeType: 'image/png',
      outputSize: { width: 768, height: 384 }
    })
    expect(fakeImage.resize).toHaveBeenCalledWith({ width: 768, height: 384, quality: 'better' })
    expect(fakeImage.toJPEG).not.toHaveBeenCalled()
  })

  it('honors an already-aborted processing signal without decoding', async () => {
    const filePath = join(root, 'aborted.png')
    await writePng(filePath)
    const controller = new AbortController()
    controller.abort()

    await expect(prepareImageContentData(filePath, {}, controller.signal)).rejects.toThrow(
      /aborted/u
    )
    expect(sharpFactory).not.toHaveBeenCalled()
  })

  it('rejects a workspace file replaced by an outside symlink after authorization', async () => {
    const authorized = join(root, 'authorized.png')
    const outside = join(root, 'outside.png')
    await writePng(authorized)
    await writePng(outside)
    const expectedCanonicalPath = await realpath(authorized)
    await rm(authorized)
    await symlink(outside, authorized)

    await expect(
      prepareImageContentData(authorized, {}, undefined, expectedCanonicalPath)
    ).rejects.toThrow(/changed while it was being opened/u)
    expect(sharpFactory).not.toHaveBeenCalled()
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('MAX_IMAGE_PAYLOAD_BYTES', () => {
  it('stays under the 5MB per-image provider limit after base64 growth', () => {
    // Anthropic and OpenCode cap a single image near 5MB of base64; base64 inflates raw bytes ~4/3.
    // Guards against raising the raw cap back to a value whose encoded form exceeds the provider limit.
    const base64Bytes = Math.ceil(MAX_IMAGE_PAYLOAD_BYTES / 3) * 4
    expect(base64Bytes).toBeLessThanOrEqual(5 * 1024 * 1024)
  })
})

describe('buildImageContentData', () => {
  it('does not decode image sources above the automatic processing limit', async () => {
    const filePath = join(root, 'huge.png')
    await writeFile(filePath, Buffer.from('small fixture'))

    await expect(
      buildImageContentData(filePath, 'image/png', MAX_AUTO_PROCESS_IMAGE_BYTES + 1)
    ).rejects.toMatchObject({ code: 'IMAGE_SOURCE_TOO_LARGE' })
    expect(sharpFactory).not.toHaveBeenCalled()
  })

  it('passes small images through untouched as raw base64', async () => {
    const filePath = join(root, 'small.png')
    const bytes = Buffer.from('tiny-image-bytes')
    await writeFile(filePath, bytes)

    const result = await buildImageContentData(filePath, 'image/png', bytes.byteLength)

    expect(result).toEqual({ data: bytes.toString('base64'), mimeType: 'image/png' })
    expect(sharpFactory).not.toHaveBeenCalled()
  })

  it('reads small managed images from the trusted byte source instead of the path', async () => {
    const bytes = Buffer.from('trusted-image-bytes')
    const readBytes = vi.fn(async () => bytes)

    const result = await buildImageContentData(
      join(root, 'missing.png'),
      'image/png',
      bytes.byteLength,
      readBytes
    )

    expect(result).toEqual({ data: bytes.toString('base64'), mimeType: 'image/png' })
    expect(readBytes).toHaveBeenCalledOnce()
  })

  it('downscales large images to the long-edge cap and re-encodes to JPEG', async () => {
    const filePath = join(root, 'large.jpg')
    await writeFile(filePath, Buffer.from('ignored-because-sharp-is-mocked'))

    const result = await buildImageContentData(filePath, 'image/jpeg', 3 * 1024 * 1024)

    // 4000px long edge is scaled to the 1568 cap while preserving aspect ratio.
    expect(fakeImage.resize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1568, height: 784 })
    )
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.data).toBe(Buffer.from('jpeg-80').toString('base64'))
  })

  it('decodes large managed images from trusted bytes instead of reopening the path', async () => {
    const bytes = Buffer.from('trusted-large-image')
    const readBytes = vi.fn(async () => bytes)

    const result = await buildImageContentData(
      join(root, 'missing-large.jpg'),
      'image/jpeg',
      3 * 1024 * 1024,
      readBytes
    )

    expect(sharpFactory).toHaveBeenCalledOnce()
    expect(sharpFactory).toHaveBeenCalledWith(bytes)
    expect(readBytes).toHaveBeenCalledOnce()
    expect(result.data).toBe(Buffer.from('jpeg-80').toString('base64'))
  })

  it('keeps PNG encoding for large PNGs to preserve transparency', async () => {
    fakeImage.hasAlpha = true
    const filePath = join(root, 'large.png')
    await writeFile(filePath, Buffer.from('ignored'))

    const result = await buildImageContentData(filePath, 'image/png', 3 * 1024 * 1024)

    expect(result.mimeType).toBe('image/png')
    expect(result.data).toBe(Buffer.from('png-bytes').toString('base64'))
  })

  it('rejects an oversized image that cannot be decoded instead of inlining raw bytes', async () => {
    fakeImage.isEmpty = () => true
    const filePath = join(root, 'broken.jpg')
    const bytes = Buffer.from('not-a-real-image-but-larger-than-threshold')
    await writeFile(filePath, bytes)

    await expect(
      buildImageContentData(filePath, 'image/jpeg', 3 * 1024 * 1024)
    ).rejects.toMatchObject({
      name: 'ImageContentError',
      code: 'IMAGE_DECODE_FAILED',
      sourceBytes: 3 * 1024 * 1024,
      limitBytes: MAX_IMAGE_PAYLOAD_BYTES
    })
  })

  it('reports image processing failures without falling back to the original file', async () => {
    sharpFactory.mockImplementationOnce(() => {
      throw new Error('decoder crashed')
    })
    const filePath = join(root, 'large.jpg')
    await writeFile(filePath, Buffer.from('must-not-be-inlined'))

    await expect(
      buildImageContentData(filePath, 'image/jpeg', 3 * 1024 * 1024)
    ).rejects.toMatchObject({
      name: 'ImageContentError',
      code: 'IMAGE_PROCESSING_FAILED',
      sourceBytes: 3 * 1024 * 1024,
      limitBytes: MAX_IMAGE_PAYLOAD_BYTES
    })
  })

  it('rejects an image that remains above the hard payload limit after compression', async () => {
    const oversizedOutput = Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES + 1)
    fakeImage.toPNG = () => oversizedOutput
    fakeImage.toJPEG = () => oversizedOutput
    const filePath = join(root, 'stubborn.png')
    await writeFile(filePath, Buffer.from('ignored'))

    await expect(
      buildImageContentData(filePath, 'image/png', 10 * 1024 * 1024)
    ).rejects.toMatchObject({
      name: 'ImageContentError',
      code: 'IMAGE_PAYLOAD_TOO_LARGE',
      sourceBytes: 10 * 1024 * 1024,
      payloadBytes: MAX_IMAGE_PAYLOAD_BYTES + 1,
      limitBytes: MAX_IMAGE_PAYLOAD_BYTES
    })
  })
})

describe('consumeInlineImageBudget', () => {
  const imageWithBase64Bytes = (bytes: number): ImageContentData => ({
    data: 'a'.repeat(bytes),
    mimeType: 'image/png'
  })

  it('accumulates actual base64 bytes and image count', () => {
    const first = consumeInlineImageBudget(
      { imageCount: 0, base64Bytes: 0 },
      imageWithBase64Bytes(1024)
    )
    const second = consumeInlineImageBudget(first, imageWithBase64Bytes(2048))

    expect(second).toEqual({ imageCount: 2, base64Bytes: 3072 })
  })

  it('rejects image data that exceeds the total inline request budget', () => {
    const current = {
      imageCount: 4,
      base64Bytes: MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES - 10
    }

    expect(() => consumeInlineImageBudget(current, imageWithBase64Bytes(11))).toThrowError(
      expect.objectContaining({
        code: 'IMAGE_TOTAL_BUDGET_EXCEEDED',
        payloadBytes: 11,
        usedBytes: MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES + 1,
        limitBytes: MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES,
        imageCount: 5
      }) as ImageContentError
    )
  })

  it('does not reuse the per-message composer cap as a cumulative replay cap', () => {
    let budget = { imageCount: 0, base64Bytes: 0 }
    for (let index = 0; index < 11; index += 1) {
      budget = consumeInlineImageBudget(budget, imageWithBase64Bytes(1))
    }

    expect(budget).toEqual({ imageCount: 11, base64Bytes: 11 })
  })
})

describe('extractPdfText', () => {
  it('reads PDF page count without extracting page text', async () => {
    const filePath = join(root, 'count.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    await expect(inspectPdfPageCount(filePath)).resolves.toBe(2)
  })

  it('loads an admitted PDF into pdfjs as a complete in-memory buffer', async () => {
    const filePath = join(root, 'admitted.pdf')
    const bytes = Buffer.alloc(32 * 1024, 0x25)
    await writeFile(filePath, bytes)

    await extractPdfText(filePath)

    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.any(Uint8Array)
      })
    )
    expect(getDocument.mock.calls[0]?.[0]?.data?.byteLength).toBe(bytes.byteLength)
  })

  it('does not inspect or read PDF sources above the automatic extraction limit', async () => {
    const filePath = join(root, 'huge.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4'))
    await truncate(filePath, MAX_AUTO_EXTRACT_PDF_BYTES + 1)

    await expect(inspectPdfPageCount(filePath)).rejects.toThrow(/automatic extraction limit/i)
    await expect(extractPdfText(filePath)).rejects.toThrow(/automatic extraction limit/i)
    expect(getDocument).not.toHaveBeenCalled()
  })

  it('joins per-page text with page markers', async () => {
    const filePath = join(root, 'doc.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    const result = await extractPdfText(filePath)

    expect(result.pageCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('--- Page 1 ---\nHello world\n\n--- Page 2 ---\nSecond page')
  })

  it('extracts managed PDFs from the trusted byte source instead of the path', async () => {
    const bytes = Buffer.from('%PDF-1.4 trusted')
    const readBytes = vi.fn(async () => bytes)

    const result = await extractPdfText(join(root, 'missing.pdf'), {
      size: bytes.byteLength,
      readBytes
    })

    expect(readBytes).toHaveBeenCalledOnce()
    expect(result.text).toContain('Hello world')
  })

  it('restores missing whitespace between adjacent PDF text items', async () => {
    fakePdf = {
      numPages: 1,
      pages: [
        [
          { str: 'The method', transform: [10, 0, 0, 10, 0, 20], width: 50, height: 10 },
          { str: 'uses retrieval', transform: [10, 0, 0, 10, 55, 20], width: 60, height: 10 }
        ]
      ]
    }
    const filePath = join(root, 'spacing.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    await expect(extractPdfText(filePath)).resolves.toMatchObject({
      text: '--- Page 1 ---\nThe method uses retrieval'
    })
  })

  it('does not split a word when PDF text is emitted as adjacent glyph runs', async () => {
    fakePdf = {
      numPages: 1,
      pages: [
        [
          { str: 'H', transform: [10, 0, 0, 10, 0, 20], width: 6, height: 10 },
          { str: 'e', transform: [10, 0, 0, 10, 6, 20], width: 5, height: 10 },
          { str: 'llo', transform: [10, 0, 0, 10, 11, 20], width: 12, height: 10 }
        ]
      ]
    }
    const filePath = join(root, 'glyph-runs.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    await expect(extractPdfText(filePath)).resolves.toMatchObject({
      text: '--- Page 1 ---\nHello'
    })
  })

  it('extracts only the requested PDF page', async () => {
    const filePath = join(root, 'page.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    const result = await extractPdfText(filePath, 2)

    expect(result.pageCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('--- Page 2 ---\nSecond page')
  })

  it('limits concurrent full PDF text extraction work', async () => {
    const paths = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_PDF_TEXT_EXTRACTIONS + 1 }, async (_, index) => {
        const filePath = join(root, `concurrent-${index}.pdf`)
        await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))
        return filePath
      })
    )
    let releaseReads: (() => void) | undefined
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    let startedReads = 0
    beforePdfPageRead = async () => {
      startedReads += 1
      await readGate
    }

    const extractions = paths.map((filePath) => extractPdfText(filePath))
    try {
      await vi.waitFor(() => expect(startedReads).toBe(MAX_CONCURRENT_PDF_TEXT_EXTRACTIONS))
      expect(getDocument).toHaveBeenCalledTimes(MAX_CONCURRENT_PDF_TEXT_EXTRACTIONS)
    } finally {
      releaseReads?.()
    }

    await expect(Promise.all(extractions)).resolves.toHaveLength(paths.length)
    expect(getDocument).toHaveBeenCalledTimes(paths.length)
  })

  it('returns empty text for a PDF with no extractable content', async () => {
    fakePdf = { numPages: 1, pages: [[]] }
    const filePath = join(root, 'scanned.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    const result = await extractPdfText(filePath)
    const targeted = await extractPdfTextPages(filePath, [1])

    expect(result.pageCount).toBe(1)
    expect(result.text).toBe('')
    expect(targeted).toEqual({
      pageCount: 1,
      pages: [{ pageNumber: 1, text: '' }],
      truncated: false
    })
  })

  it('extracts only explicitly targeted PDF pages', async () => {
    const filePath = join(root, 'targeted.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    const result = await extractPdfTextPages(filePath, [2])

    expect(result).toEqual({
      pageCount: 2,
      pages: [{ pageNumber: 2, text: 'Second page' }],
      truncated: false
    })
    expect(JSON.stringify(result)).not.toContain('Hello world')
  })
})

describe('canInlineImageInSession', () => {
  it('always inlines the first image of a session even if it is large', () => {
    expect(canInlineImageInSession(0, MAX_SESSION_INLINE_IMAGE_BYTES * 2, 10)).toBe(true)
  })

  it('inlines while the running total stays within budget', () => {
    expect(canInlineImageInSession(4, 6, 10)).toBe(true)
  })

  it('degrades once the running total would exceed the budget', () => {
    expect(canInlineImageInSession(6, 5, 10)).toBe(false)
  })

  it('defaults to the shared session budget when none is passed', () => {
    expect(canInlineImageInSession(MAX_SESSION_INLINE_IMAGE_BYTES, 1)).toBe(false)
    expect(canInlineImageInSession(MAX_SESSION_INLINE_IMAGE_BYTES - 1, 1)).toBe(true)
  })
})
