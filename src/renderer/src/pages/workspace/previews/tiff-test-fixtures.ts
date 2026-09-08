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

// Small real, uncompressed TIFFs for sample interpretation regression tests.
export const createSampleTiff = ({
  samples,
  components = 2,
  photometric = 1,
  floating = false,
  extraSample = 2
}: {
  samples: number[]
  components?: number
  photometric?: number
  floating?: boolean
  extraSample?: number
}): ArrayBuffer => {
  const pixelOffset = 192
  const sampleBytes = floating ? 4 : 1
  const data = new ArrayBuffer(pixelOffset + samples.length * sampleBytes)
  const view = new DataView(data)
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  const repeatedShort = (value: number, offset: number): number => {
    if (components === 1) return value
    if (components === 2) return value | (value << 16)
    for (let index = 0; index < components; index += 1) {
      view.setUint16(offset + index * 2, value, true)
    }
    return offset
  }
  const entries = [
    [256, 4, 1, samples.length / components],
    [257, 4, 1, 1],
    [258, 3, components, repeatedShort(floating ? 32 : 8, 160)],
    [259, 3, 1, 1],
    [262, 3, 1, photometric],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, components],
    [278, 4, 1, 1],
    [279, 4, 1, samples.length * sampleBytes],
    [284, 3, 1, 1],
    ...(components === 2 || components === 4 ? [[338, 3, 1, extraSample]] : []),
    [339, 3, components, repeatedShort(floating ? 3 : 1, 176)]
  ]
  view.setUint16(8, entries.length, true)
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12
    view.setUint16(offset, tag, true)
    view.setUint16(offset + 2, type, true)
    view.setUint32(offset + 4, count, true)
    view.setUint32(offset + 8, value, true)
  })
  samples.forEach((value, index) => {
    if (floating) view.setFloat32(pixelOffset + index * sampleBytes, value, true)
    else view.setUint8(pixelOffset + index, value)
  })
  return data
}

export const createUnsupportedFirstPageTiff = (): ArrayBuffer => {
  const data = decodeTiffFixture(LZW_MULTIPAGE_TIFF)
  const view = new DataView(data)
  const ifdOffset = view.getUint32(4, true)
  for (let index = 0; index < view.getUint16(ifdOffset, true); index += 1) {
    const offset = ifdOffset + 2 + index * 12
    const tag = view.getUint16(offset, true)
    if (tag === 259) view.setUint16(offset + 8, 32773, true)
    if (tag === 279) view.setUint32(offset + 8, 4, true)
  }
  // Valid PackBits literal run: three bytes encoding one red RGB pixel.
  new Uint8Array(data, 8, 4).set([2, 255, 0, 0])
  return data
}
