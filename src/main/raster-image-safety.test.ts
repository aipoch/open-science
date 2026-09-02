import { describe, expect, it } from 'vitest'

import { readRasterImageDimensions } from './raster-image-safety'

// APP1 EXIF segment carrying a single IFD0 orientation entry, followed by a SOF0 frame header.
const jpegWithExif = (
  width: number,
  height: number,
  orientation: number,
  littleEndian: boolean
): Buffer => {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4) // header + entry count + one entry + next-IFD pointer
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1')
  const writeU16 = (value: number, offset: number): void => {
    if (littleEndian) tiff.writeUInt16LE(value, offset)
    else tiff.writeUInt16BE(value, offset)
  }
  const writeU32 = (value: number, offset: number): void => {
    if (littleEndian) tiff.writeUInt32LE(value, offset)
    else tiff.writeUInt32BE(value, offset)
  }
  writeU16(42, 2)
  writeU32(8, 4) // IFD0 starts right after the header
  writeU16(1, 8) // one entry
  writeU16(0x0112, 10) // orientation tag
  writeU16(3, 12) // type SHORT
  writeU32(1, 14) // count
  writeU16(orientation, 18) // inline value
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.alloc(2 + payload.length)
  app1.writeUInt16BE(app1.length, 0)
  payload.copy(app1, 2)

  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(11, 0) // segment length includes its own two bytes
  sof[2] = 8 // sample precision
  sof.writeUInt16BE(height, 3)
  sof.writeUInt16BE(width, 5)
  sof[7] = 1 // component count
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    app1,
    Buffer.from([0xff, 0xc0]),
    sof
  ])
}

describe('readRasterImageDimensions', () => {
  it.each([5, 6, 7, 8])(
    'transposes JPEG dimensions when EXIF orientation %d rotates the display',
    (orientation) => {
      // Browsers apply EXIF orientation by default (image-orientation: from-image), so a rotated
      // phone photo displays with the SOF dimensions swapped.
      expect(
        readRasterImageDimensions(jpegWithExif(640, 400, orientation, true), 'image/jpeg')
      ).toEqual({ width: 400, height: 640 })
    }
  )

  it('honors big-endian EXIF headers', () => {
    expect(readRasterImageDimensions(jpegWithExif(640, 400, 8, false), 'image/jpeg')).toEqual({
      width: 400,
      height: 640
    })
  })

  it.each([1, 2, 3, 4])(
    'keeps SOF dimensions for non-transposing orientation %d',
    (orientation) => {
      expect(
        readRasterImageDimensions(jpegWithExif(640, 400, orientation, true), 'image/jpeg')
      ).toEqual({ width: 640, height: 400 })
    }
  )

  it('ignores a malformed EXIF segment instead of failing the parse', () => {
    const bytes = jpegWithExif(640, 400, 6, true)
    bytes[6] = 0x00 // corrupt the 'Exif\0\0' token
    expect(readRasterImageDimensions(bytes, 'image/jpeg')).toEqual({ width: 640, height: 400 })
  })
})
