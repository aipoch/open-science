import { describe, expect, it } from 'vitest'

import {
  createWhiteIsZeroGrayscaleAlphaTiff,
  DEFLATE_RGB_TIFF,
  decodeTiffFixture,
  LZW_GRAYSCALE_16_TIFF,
  LZW_GRAYSCALE_FLOAT32_TIFF,
  LZW_RGB_TIFF,
  PALETTE_TIFF
} from './tiff-test-fixtures'
import { decodeTiffPage, resizeDecodedTiffPage } from './tiff-preview'

const setClassicTiffScalarTag = (data: ArrayBuffer, tag: number, value: number): ArrayBuffer => {
  const copy = data.slice(0)
  const view = new DataView(copy)
  const littleEndian = view.getUint16(0, true) === 0x4949
  const ifdOffset = view.getUint32(4, littleEndian)
  const entries = view.getUint16(ifdOffset, littleEndian)

  for (let index = 0; index < entries; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12
    if (view.getUint16(entryOffset, littleEndian) !== tag) continue
    const type = view.getUint16(entryOffset + 2, littleEndian)
    if (type === 3) view.setUint16(entryOffset + 8, value, littleEndian)
    else view.setUint32(entryOffset + 8, value, littleEndian)
    return copy
  }

  throw new Error(`Missing TIFF test tag ${tag}`)
}

const renameClassicTiffTag = (data: ArrayBuffer, tag: number, nextTag: number): ArrayBuffer => {
  const copy = data.slice(0)
  const view = new DataView(copy)
  const littleEndian = view.getUint16(0, true) === 0x4949
  const ifdOffset = view.getUint32(4, littleEndian)
  const entries = view.getUint16(ifdOffset, littleEndian)

  for (let index = 0; index < entries; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12
    if (view.getUint16(entryOffset, littleEndian) !== tag) continue
    view.setUint16(entryOffset, nextTag, littleEndian)
    return copy
  }

  throw new Error(`Missing TIFF test tag ${tag}`)
}

const createFloat32GrayscaleAlphaTiff = (): ArrayBuffer => {
  const entryCount = 12
  const pixelOffset = 160
  const data = new ArrayBuffer(pixelOffset + 8)
  const view = new DataView(data)
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, entryCount, true)

  const entries: Array<[number, number, number, number]> = [
    [256, 4, 1, 1],
    [257, 4, 1, 1],
    [258, 3, 2, 0x00200020],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 2],
    [278, 4, 1, 1],
    [279, 4, 1, 8],
    [284, 3, 1, 1],
    [338, 3, 1, 2],
    [339, 3, 2, 0x00030003]
  ]
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12
    view.setUint16(offset, tag, true)
    view.setUint16(offset + 2, type, true)
    view.setUint32(offset + 4, count, true)
    view.setUint32(offset + 8, value, true)
  })
  view.setUint32(154, 0, true)
  view.setFloat32(pixelOffset, 10, true)
  view.setFloat32(pixelOffset + 4, 1, true)
  return data
}

describe('TIFF preview decoding', () => {
  it('downsamples a decoded page before it leaves the worker', () => {
    const page = resizeDecodedTiffPage(
      {
        width: 4,
        height: 2,
        pageIndex: 0,
        pageCount: 1,
        rgba: Uint8ClampedArray.from([
          255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 64, 64,
          64, 255, 128, 128, 128, 255, 192, 192, 192, 255
        ])
      },
      2
    )

    expect(page).toMatchObject({ width: 2, height: 1, pageIndex: 0, pageCount: 1 })
    expect(Array.from(page.rgba)).toEqual([64, 64, 64, 255, 192, 192, 192, 255])
  })

  it('decodes a Deflate-compressed RGB page into display-ready RGBA pixels', () => {
    const page = decodeTiffPage(decodeTiffFixture(DEFLATE_RGB_TIFF), 0)

    expect(page).toMatchObject({ width: 2, height: 2, pageIndex: 0, pageCount: 1 })
    expect(Array.from(page.rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
    ])
  })

  it('decodes legacy Deflate compression tag 32946', () => {
    const legacyDeflate = setClassicTiffScalarTag(decodeTiffFixture(DEFLATE_RGB_TIFF), 259, 32946)

    expect(Array.from(decodeTiffPage(legacyDeflate, 0).rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
    ])
  })

  it('decodes an LZW-compressed RGB page into display-ready RGBA pixels', () => {
    const page = decodeTiffPage(decodeTiffFixture(LZW_RGB_TIFF), 0)

    expect(page).toMatchObject({ width: 2, height: 2, pageIndex: 0, pageCount: 1 })
    expect(Array.from(page.rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
    ])
  })

  it('rejects a TIFF that exceeds the admitted compressed-file size', () => {
    expect(() =>
      decodeTiffPage(decodeTiffFixture(LZW_RGB_TIFF), 0, {
        maxFileBytes: 151,
        maxPixels: 4,
        maxDecodedBytes: 1024
      })
    ).toThrow('TIFF file is too large to preview safely')
  })

  it('normalizes a 16-bit grayscale LZW page for display', () => {
    const page = decodeTiffPage(decodeTiffFixture(LZW_GRAYSCALE_16_TIFF), 0)

    expect(Array.from(page.rgba)).toEqual([
      0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255
    ])
  })

  it('inverts WhiteIsZero grayscale samples', () => {
    const whiteIsZero = setClassicTiffScalarTag(decodeTiffFixture(LZW_GRAYSCALE_16_TIFF), 262, 0)
    const page = decodeTiffPage(whiteIsZero, 0)

    expect(Array.from(page.rgba)).toEqual([
      255, 255, 255, 255, 170, 170, 170, 255, 85, 85, 85, 255, 0, 0, 0, 255
    ])
  })

  it('preserves unassociated alpha when decoding WhiteIsZero grayscale samples', () => {
    const page = decodeTiffPage(createWhiteIsZeroGrayscaleAlphaTiff(), 0)

    expect(Array.from(page.rgba)).toEqual([255, 255, 255, 64, 0, 0, 0, 192])
  })

  it('normalizes Float32 grayscale samples using their finite sample range', () => {
    const page = decodeTiffPage(decodeTiffFixture(LZW_GRAYSCALE_FLOAT32_TIFF), 0)

    expect(Array.from(page.rgba)).toEqual([
      0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255
    ])
  })

  it('normalizes Float32 alpha independently from grayscale intensity', () => {
    const page = decodeTiffPage(createFloat32GrayscaleAlphaTiff(), 0)

    expect(Array.from(page.rgba)).toEqual([255, 255, 255, 255])
  })

  it('rejects Float32 WhiteIsZero before the decoder can corrupt its samples', () => {
    const whiteIsZero = setClassicTiffScalarTag(createFloat32GrayscaleAlphaTiff(), 262, 0)

    expect(() => decodeTiffPage(whiteIsZero, 0)).toThrow(
      'Unsupported TIFF floating-point WhiteIsZero layout'
    )
  })

  it('resolves palette-color samples into display colors', () => {
    const page = decodeTiffPage(decodeTiffFixture(PALETTE_TIFF), 0)

    expect(Array.from(page.rgba)).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  })

  it('rejects a page whose decoded pixel buffer would exceed the preview limit', () => {
    expect(() =>
      decodeTiffPage(decodeTiffFixture(LZW_RGB_TIFF), 0, {
        maxFileBytes: 1024,
        maxPixels: 3,
        maxDecodedBytes: 1024
      })
    ).toThrow('TIFF page is too large to preview safely')
  })

  it('rejects a page whose estimated decoded memory exceeds the preview budget', () => {
    expect(() =>
      decodeTiffPage(decodeTiffFixture(LZW_RGB_TIFF), 0, {
        maxFileBytes: 1024,
        maxPixels: 4,
        maxDecodedBytes: 79
      })
    ).toThrow('TIFF page needs too much memory to preview safely')
  })

  it('rejects a compressed strip that expands beyond its declared image buffer', () => {
    const onePixelWide = setClassicTiffScalarTag(decodeTiffFixture(LZW_RGB_TIFF), 256, 1)
    const onePixel = setClassicTiffScalarTag(onePixelWide, 257, 1)

    expect(() => decodeTiffPage(onePixel, 0)).toThrow(
      'TIFF compressed strip exceeds its declared size'
    )
  })

  it('rejects a Deflate strip that expands beyond its declared image buffer', () => {
    const onePixelWide = setClassicTiffScalarTag(decodeTiffFixture(DEFLATE_RGB_TIFF), 256, 1)
    const onePixel = setClassicTiffScalarTag(onePixelWide, 257, 1)

    expect(() => decodeTiffPage(onePixel, 0)).toThrow(
      'TIFF compressed strip exceeds its declared size'
    )
  })

  it('rejects a page dimension that exceeds the reliable canvas limit', () => {
    const tooWide = setClassicTiffScalarTag(decodeTiffFixture(LZW_RGB_TIFF), 256, 16_385)

    expect(() => decodeTiffPage(tooWide, 0)).toThrow(
      'TIFF page dimensions are too large to preview safely'
    )
  })

  it('rejects unsupported compression before decoding image samples', () => {
    const packBits = setClassicTiffScalarTag(decodeTiffFixture(LZW_RGB_TIFF), 259, 32_773)

    expect(() => decodeTiffPage(packBits, 0)).toThrow('Unsupported TIFF compression: 32773')
  })

  it('rejects tiled TIFF pages before decoding image samples', () => {
    let tiled = decodeTiffFixture(LZW_RGB_TIFF)
    tiled = renameClassicTiffTag(tiled, 273, 324)
    tiled = renameClassicTiffTag(tiled, 278, 323)
    tiled = renameClassicTiffTag(tiled, 279, 325)
    tiled = renameClassicTiffTag(tiled, 284, 322)

    expect(() => decodeTiffPage(tiled, 0)).toThrow('Unsupported TIFF tiled layout')
  })

  it('rejects BigTIFF headers before metadata traversal', () => {
    const bigTiff = decodeTiffFixture(LZW_RGB_TIFF)
    new DataView(bigTiff).setUint16(2, 43, true)

    expect(() => decodeTiffPage(bigTiff, 0)).toThrow('Invalid TIFF header')
  })
})
