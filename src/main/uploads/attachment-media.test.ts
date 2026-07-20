import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildImageContentData,
  canInlineImageInSession,
  consumeInlineImageBudget,
  extractPdfText,
  ImageContentError,
  MAX_IMAGE_PAYLOAD_BYTES,
  MAX_INLINE_IMAGE_TOTAL_BASE64_BYTES,
  MAX_SESSION_INLINE_IMAGE_BYTES,
  type ImageContentData
} from './attachment-media'

// A configurable fake nativeImage so the >2MB compression path is exercised without an Electron runtime.
type FakeImage = {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: ReturnType<typeof vi.fn>
  toJPEG: (quality: number) => Buffer
  toPNG: () => Buffer
}

let fakeImage: FakeImage
// The wrapper ignores the path arg at runtime; the spy just records that a decode was attempted.
const createFromPath = vi.fn(() => fakeImage)

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: () => createFromPath()
  }
}))

// A fake pdfjs document so text extraction is deterministic and does not parse a real PDF.
let fakePdf: { numPages: number; pages: string[][] }
const getDocument = vi.fn(() => ({
  promise: Promise.resolve({
    numPages: fakePdf.numPages,
    getPage: async (pageNumber: number) => ({
      getTextContent: async () => ({
        items: (fakePdf.pages[pageNumber - 1] ?? []).map((str) => ({ str }))
      }),
      cleanup: () => {}
    }),
    destroy: async () => {}
  })
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: () => getDocument() }))

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'attachment-media-'))
  createFromPath.mockClear()
  getDocument.mockClear()
  fakeImage = {
    isEmpty: () => false,
    getSize: () => ({ width: 4000, height: 2000 }),
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
  it('passes small images through untouched as raw base64', async () => {
    const filePath = join(root, 'small.png')
    const bytes = Buffer.from('tiny-image-bytes')
    await writeFile(filePath, bytes)

    const result = await buildImageContentData(filePath, 'image/png', bytes.byteLength)

    expect(result).toEqual({ data: bytes.toString('base64'), mimeType: 'image/png' })
    expect(createFromPath).not.toHaveBeenCalled()
  })

  it('downscales large images to the long-edge cap and re-encodes to JPEG', async () => {
    const filePath = join(root, 'large.jpg')
    await writeFile(filePath, Buffer.from('ignored-because-nativeimage-is-mocked'))

    const result = await buildImageContentData(filePath, 'image/jpeg', 3 * 1024 * 1024)

    // 4000px long edge is scaled to the 1568 cap while preserving aspect ratio.
    expect(fakeImage.resize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1568, height: 784 })
    )
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.data).toBe(Buffer.from('jpeg-80').toString('base64'))
  })

  it('keeps PNG encoding for large PNGs to preserve transparency', async () => {
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
    createFromPath.mockImplementationOnce(() => {
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
  it('joins per-page text with page markers', async () => {
    const filePath = join(root, 'doc.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    const result = await extractPdfText(filePath)

    expect(result.pageCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('--- Page 1 ---\nHello world\n\n--- Page 2 ---\nSecond page')
  })

  it('returns empty text for a PDF with no extractable content', async () => {
    fakePdf = { numPages: 1, pages: [[]] }
    const filePath = join(root, 'scanned.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'))

    const result = await extractPdfText(filePath)

    expect(result.pageCount).toBe(1)
    expect(result.text).toBe('')
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
