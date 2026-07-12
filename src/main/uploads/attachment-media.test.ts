import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildImageContentData, extractPdfText } from './attachment-media'

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

  it('falls back to raw bytes when the image cannot be decoded', async () => {
    fakeImage.isEmpty = () => true
    const filePath = join(root, 'broken.jpg')
    const bytes = Buffer.from('not-a-real-image-but-larger-than-threshold')
    await writeFile(filePath, bytes)

    const result = await buildImageContentData(filePath, 'image/jpeg', 3 * 1024 * 1024)

    expect(result).toEqual({ data: bytes.toString('base64'), mimeType: 'image/jpeg' })
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
