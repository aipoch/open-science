import { describe, expect, it } from 'vitest'

import { inspectTiffStructure, measureLzwOutput } from './tiff-preview-preflight'

const createBoundaryCrossingLzwStream = (): Uint8Array => {
  const bits: number[] = []
  let tableLength = 258
  let codeBits = 9

  const writeCode = (code: number): void => {
    for (let bit = codeBits - 1; bit >= 0; bit -= 1) bits.push((code >> bit) & 1)
  }

  writeCode(256)
  writeCode(0)
  const additionsThroughFinalSlot = 4_095 - tableLength + 1
  for (let index = 0; index < additionsThroughFinalSlot; index += 1) {
    writeCode(0)
    tableLength += 1
    if (tableLength === 511 || tableLength === 1_023 || tableLength === 2_047) codeBits += 1
  }
  writeCode(257)

  const data = new Uint8Array(Math.ceil(bits.length / 8))
  bits.forEach((bit, index) => {
    data[index >> 3] |= bit << (7 - (index & 7))
  })
  return data
}

const createClassicTiff = (
  writeDirectory: (view: DataView, littleEndian: boolean) => void
): ArrayBuffer => {
  const data = new ArrayBuffer(26)
  const view = new DataView(data)
  const littleEndian = true
  view.setUint16(0, 0x4949, littleEndian)
  view.setUint16(2, 42, littleEndian)
  view.setUint32(4, 8, littleEndian)
  writeDirectory(view, littleEndian)
  return data
}

describe('TIFF structure preflight', () => {
  it('accepts a legal LZW dictionary through every code-width boundary and slot 4095', () => {
    expect(measureLzwOutput(createBoundaryCrossingLzwStream(), 3_839)).toBe(3_839)
  })

  it('rejects oversized IFD value counts before the decoder can allocate them', () => {
    const data = createClassicTiff((view, littleEndian) => {
      view.setUint16(8, 1, littleEndian)
      view.setUint16(10, 270, littleEndian)
      view.setUint16(12, 1, littleEndian)
      view.setUint32(14, 0xffffffff, littleEndian)
      view.setUint32(18, 8, littleEndian)
      view.setUint32(22, 0, littleEndian)
    })

    expect(() => inspectTiffStructure(data)).toThrow('TIFF metadata is too large to preview safely')
  })

  it('rejects cyclic primary IFD chains', () => {
    const data = createClassicTiff((view, littleEndian) => {
      view.setUint16(8, 0, littleEndian)
      view.setUint32(10, 8, littleEndian)
    })

    expect(() => inspectTiffStructure(data)).toThrow('Invalid cyclic TIFF directory')
  })
})
