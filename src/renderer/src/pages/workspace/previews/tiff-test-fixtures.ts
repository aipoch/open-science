// 2 × 2 RGB TIFF encoded with LZW. Pixels are red, green, blue, and white.
const LZW_RGB_TIFF =
  'SUkqABQAAACAP8AQOBQR/weAgAAKAAABAwABAAAAAgAAAAEBAwABAAAAAgAAAAIBAwADAAAAkgAAAAMBAwABAAAABQAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABUBAwABAAAAAwAAABYBAwABAAAAAgAAABcBBAABAAAACwAAABwBAwABAAAAAQAAAAAAAAAIAAgACAA='

// 2 x 2 RGB TIFF encoded with Adobe Deflate. Pixels match LZW_RGB_TIFF.
const DEFLATE_RGB_TIFF =
  'SUkqABoAAAB4nPvPwMDwH4T///8PAB3uBfsKAAABAwABAAAAAgAAAAEBAwABAAAAAgAAAAIBAwADAAAAmAAAAAMBAwABAAAACAAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABUBAwABAAAAAwAAABYBAwABAAAAAgAAABcBBAABAAAAEgAAABwBAwABAAAAAQAAAAAAAAAIAAgACAA='

// 2 × 2 16-bit grayscale LZW TIFF with values 0, 21845, 43690, and 65535.
const LZW_GRAYSCALE_16_TIFF =
  'SUkqABQAAACAAAAFUqqpVP9/wEAJAAABAwABAAAAAgAAAAEBAwABAAAAAgAAAAIBAwABAAAAEAAAAAMBAwABAAAABQAAAAYBAwABAAAAAQAAABEBBAABAAAACAAAABYBAwABAAAAAgAAABcBBAABAAAADAAAABwBAwABAAAAAQAAAAAAAAA='

// 2 × 2 Float32 grayscale LZW TIFF with values 0, 0.25, 0.5, and 1.
const LZW_GRAYSCALE_FLOAT32_TIFF =
  'SUkqABYAAACAACBQNAD6Bj+BIAfwEAoAAAEDAAEAAAACAAAAAQEDAAEAAAACAAAAAgEDAAEAAAAgAAAAAwEDAAEAAAAFAAAABgEDAAEAAAABAAAAEQEEAAEAAAAIAAAAFgEDAAEAAAACAAAAFwEEAAEAAAAOAAAAHAEDAAEAAAABAAAAUwEDAAEAAAADAAAAAAAAAA=='

// Two 1 × 1 RGB LZW pages: red followed by blue.
const LZW_MULTIPAGE_TIFF =
  'SUkqAA4AAACAP8AACAgKAAABAwABAAAAAQAAAAEBAwABAAAAAQAAAAIBAwADAAAAjAAAAAMBAwABAAAABQAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABUBAwABAAAAAwAAABYBAwABAAAAAQAAABcBBAABAAAABgAAABwBAwABAAAAAQAAAK4AAAAIAAgACAAAAAAAAAAAAAAAAAAAAElJKgAOAAAAgAAAD/gICgAAAQMAAQAAAAEAAAABAQMAAQAAAAEAAAACAQMAAwAAACwBAAADAQMAAQAAAAUAAAAGAQMAAQAAAAIAAAARAQQAAQAAAKgAAAAVAQMAAQAAAAMAAAAWAQMAAQAAAAEAAAAXAQQAAQAAAAYAAAAcAQMAAQAAAAEAAAAAAAAACAAIAAgAAAAAAAAAAAAAAAAAAAA='

// 2 × 1 palette-color TIFF. Palette indices resolve to red and blue.
const PALETTE_TIFF =
  'SUkqAAgAAAALAAABAwABAAAAAgAAAAEBAwABAAAAAQAAAAIBAwABAAAAAQAAAAMBAwABAAAAAQAAAAYBAwABAAAAAwAAABEBBAABAAAAngAAABUBAwABAAAAAQAAABYBBAABAAAAAQAAABcBBAABAAAAAQAAABwBAwABAAAAAQAAAEABAwAGAAAAkgAAAAAAAAD//wAAAAAAAAAA//9A'

// 1 × 2 uncompressed WhiteIsZero grayscale TIFF with unassociated alpha.
// Pixels are white at alpha 64 followed by black at alpha 192.
const createWhiteIsZeroGrayscaleAlphaTiff = (): ArrayBuffer => {
  const entryCount = 11
  const pixelOffset = 160
  const data = new ArrayBuffer(pixelOffset + 4)
  const view = new DataView(data)
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, entryCount, true)

  const entries: Array<[number, number, number, number]> = [
    [256, 4, 1, 1],
    [257, 4, 1, 2],
    [258, 3, 2, 0x00080008],
    [259, 3, 1, 1],
    [262, 3, 1, 0],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 2],
    [278, 4, 1, 2],
    [279, 4, 1, 4],
    [284, 3, 1, 1],
    [338, 3, 1, 2]
  ]
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12
    view.setUint16(offset, tag, true)
    view.setUint16(offset + 2, type, true)
    view.setUint32(offset + 4, count, true)
    view.setUint32(offset + 8, value, true)
  })
  view.setUint32(142, 0, true)
  new Uint8Array(data, pixelOffset).set([0, 64, 255, 192])
  return data
}

const decodeTiffFixture = (value: string): ArrayBuffer => {
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
  return bytes.buffer
}

export {
  createWhiteIsZeroGrayscaleAlphaTiff,
  DEFLATE_RGB_TIFF,
  decodeTiffFixture,
  LZW_GRAYSCALE_16_TIFF,
  LZW_GRAYSCALE_FLOAT32_TIFF,
  LZW_MULTIPAGE_TIFF,
  LZW_RGB_TIFF,
  PALETTE_TIFF
}
