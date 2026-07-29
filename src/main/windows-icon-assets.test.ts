import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { crc32, inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

const projectRoot = process.env['WINDOWS_ICON_TEST_ROOT']
  ? resolve(process.env['WINDOWS_ICON_TEST_ROOT'])
  : resolve(__dirname, '../..')
const require = createRequire(import.meta.url)
const { load: loadYaml } = require('js-yaml') as { load: (source: string) => unknown }

type IcoEntry = {
  width: number
  height: number
  bitCount: number
  byteSize: number
  imageOffset: number
}

type DecodedPng = {
  width: number
  height: number
  pixels: Buffer
}

const APP_ICON_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const SHELL_BACKGROUNDS = [24, 245]
const SMALL_FRAME_HASHES: Record<string, Record<number, string>> = {
  'resources/icon-light.ico': {
    16: 'e5daa94b736c7960eb97668481e9ae5ff13690f801d0c2ed077811307b226f75',
    20: 'a800b1b057255dd1231dff151d6138926f78141da3838a702d17c2d0df0b3210',
    24: '41b6018fe12cf9eeacaec84d836354e9fd10e5d622d683d250dc425f1b79a1b6'
  },
  'resources/icon-dark.ico': {
    16: 'cc39dde7cefe453cbbb141774848a11c53f69859bf5fea1b8431dd38fedac8cd',
    20: '451f20738064b0cf64d7aef47d23364f67fb5e8cf83e914486918e737aa7e32b',
    24: '532e646bb12b8dacde0c3e0e610ecde6cdc04e17c453e6bd0dc5d77673d3b5d2'
  },
  'resources/tray.ico': {
    16: 'cc39dde7cefe453cbbb141774848a11c53f69859bf5fea1b8431dd38fedac8cd',
    20: '451f20738064b0cf64d7aef47d23364f67fb5e8cf83e914486918e737aa7e32b',
    24: '532e646bb12b8dacde0c3e0e610ecde6cdc04e17c453e6bd0dc5d77673d3b5d2'
  }
}

const paethPredictor = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

// The generated ICO payloads are 8-bit RGBA PNGs. Decode their scanlines directly so the test checks
// real pixels without adding an image library to the application dependency graph.
const decodeRgbaPng = (payload: Buffer): DecodedPng => {
  expect(payload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

  let cursor = 8
  let width = 0
  let height = 0
  let sawIhdr = false
  let sawIend = false
  const compressed: Buffer[] = []
  while (cursor < payload.length) {
    if (cursor + 12 > payload.length) throw new Error('incomplete PNG chunk')
    const length = payload.readUInt32BE(cursor)
    const type = payload.toString('ascii', cursor + 4, cursor + 8)
    const dataEnd = cursor + 8 + length
    const chunkEnd = dataEnd + 4
    if (chunkEnd > payload.length) throw new Error(`incomplete PNG ${type} chunk`)

    const data = payload.subarray(cursor + 8, dataEnd)
    const expectedCrc = payload.readUInt32BE(dataEnd)
    const actualCrc = crc32(payload.subarray(cursor + 4, dataEnd)) >>> 0
    if (actualCrc !== expectedCrc) throw new Error(`invalid PNG chunk CRC for ${type}`)

    if (type === 'IHDR') {
      if (cursor !== 8 || sawIhdr || length !== 13) throw new Error('invalid PNG IHDR chunk')
      sawIhdr = true
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect(data[8]).toBe(8)
      expect(data[9]).toBe(6)
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('unsupported PNG IHDR encoding method')
      }
    } else if (type === 'IDAT') {
      compressed.push(data)
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('invalid PNG IEND chunk')
      sawIend = true
    }
    cursor = chunkEnd
    if (type === 'IEND') break
  }

  if (!sawIhdr) throw new Error('missing PNG IHDR chunk')
  if (!sawIend) throw new Error('missing PNG IEND chunk')
  if (cursor !== payload.length) throw new Error('unexpected data after PNG IEND chunk')
  if (compressed.length === 0) throw new Error('missing PNG IDAT chunk')

  const encoded = inflateSync(Buffer.concat(compressed))
  const stride = width * 4
  expect(encoded.length).toBe((stride + 1) * height)
  const pixels = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y += 1) {
    const filter = encoded[y * (stride + 1)]
    expect(filter).toBeLessThanOrEqual(4)
    const rowStart = y * stride
    const encodedStart = y * (stride + 1) + 1
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[encodedStart + x]
      const left = x >= 4 ? pixels[rowStart + x - 4] : 0
      const above = y > 0 ? pixels[rowStart - stride + x] : 0
      const upperLeft = y > 0 && x >= 4 ? pixels[rowStart - stride + x - 4] : 0
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upperLeft)
      pixels[rowStart + x] = (raw + prediction) & 0xff
    }
  }

  return { width, height, pixels }
}

// Parse the ICO directory itself so malformed offsets and missing DPI frames fail before packaging.
const readIcoEntries = (relativePath: string): IcoEntry[] => {
  const bytes = readFileSync(resolve(projectRoot, relativePath))
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)

  const count = bytes.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16
    const width = bytes[offset] || 256
    const height = bytes[offset + 1] || 256
    const byteSize = bytes.readUInt32LE(offset + 8)
    const imageOffset = bytes.readUInt32LE(offset + 12)

    expect(imageOffset + byteSize).toBeLessThanOrEqual(bytes.length)
    return {
      width,
      height,
      bitCount: bytes.readUInt16LE(offset + 6),
      byteSize,
      imageOffset
    }
  })
}

const readIcoFrame = (relativePath: string, size: number): DecodedPng => {
  const bytes = readFileSync(resolve(projectRoot, relativePath))
  const entry = readIcoEntries(relativePath).find(
    ({ width, height }) => width === size && height === size
  )
  expect(entry).toBeDefined()
  return decodeRgbaPng(bytes.subarray(entry!.imageOffset, entry!.imageOffset + entry!.byteSize))
}

const readIcoFramePayload = (relativePath: string, size: number): Buffer => {
  const bytes = readFileSync(resolve(projectRoot, relativePath))
  const entry = readIcoEntries(relativePath).find(
    ({ width, height }) => width === size && height === size
  )
  expect(entry).toBeDefined()
  return Buffer.from(bytes.subarray(entry!.imageOffset, entry!.imageOffset + entry!.byteSize))
}

const relativeLuminance = (red: number, green: number, blue: number): number => {
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue
}

const contrastRatio = (left: number, right: number): number =>
  (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)

const expectReadableOnShellBackgrounds = (
  relativePath: string,
  plateTone: 'dark' | 'light'
): void => {
  const bytes = readFileSync(resolve(projectRoot, relativePath))
  const entries = readIcoEntries(relativePath)
  const directoryEnd = 6 + entries.length * 16
  const sortedEntries = [...entries].sort((left, right) => left.imageOffset - right.imageOffset)

  for (const [index, entry] of sortedEntries.entries()) {
    expect(entry.imageOffset).toBeGreaterThanOrEqual(directoryEnd)
    const next = sortedEntries[index + 1]
    if (next) expect(entry.imageOffset + entry.byteSize).toBeLessThanOrEqual(next.imageOffset)

    const frame = decodeRgbaPng(
      bytes.subarray(entry.imageOffset, entry.imageOffset + entry.byteSize)
    )
    expect([frame.width, frame.height]).toEqual([entry.width, entry.height])

    let visible = 0
    let dark = 0
    let light = 0
    let minX = frame.width
    let minY = frame.height
    let maxX = -1
    let maxY = -1
    const contrastingPixels = new Map(SHELL_BACKGROUNDS.map((background) => [background, 0]))
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const offset = (y * frame.width + x) * 4
        const alpha = frame.pixels[offset + 3]
        const luminance =
          0.299 * frame.pixels[offset] +
          0.587 * frame.pixels[offset + 1] +
          0.114 * frame.pixels[offset + 2]
        for (const [background, count] of contrastingPixels) {
          const alphaRatio = alpha / 255
          const inverseAlpha = 1 - alphaRatio
          const composited = relativeLuminance(
            frame.pixels[offset] * alphaRatio + background * inverseAlpha,
            frame.pixels[offset + 1] * alphaRatio + background * inverseAlpha,
            frame.pixels[offset + 2] * alphaRatio + background * inverseAlpha
          )
          const shellLuminance = relativeLuminance(background, background, background)
          const contrast = contrastRatio(composited, shellLuminance)
          if (contrast >= 3) contrastingPixels.set(background, count + 1)
        }

        if (alpha < 128) continue

        visible += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        if (luminance < 80) dark += 1
        if (luminance > 200) light += 1
      }
    }

    expect(visible).toBeGreaterThan(0)
    expect((maxX - minX + 1) / frame.width).toBeGreaterThanOrEqual(0.75)
    expect((maxY - minY + 1) / frame.height).toBeGreaterThanOrEqual(0.75)
    const platePixels = plateTone === 'dark' ? dark : light
    const markPixels = plateTone === 'dark' ? light : dark
    expect(platePixels / visible).toBeGreaterThan(0.45)
    expect(markPixels / visible).toBeGreaterThan(0.03)
    if (frame.width <= 24) expect(markPixels).toBeGreaterThanOrEqual(12)
    for (const count of contrastingPixels.values()) {
      expect(count / (frame.width * frame.height)).toBeGreaterThan(0.02)
      if (frame.width <= 24) expect(count).toBeGreaterThanOrEqual(12)
    }

    const cornerAlpha = [
      frame.pixels[3],
      frame.pixels[(frame.width - 1) * 4 + 3],
      frame.pixels[(frame.height - 1) * frame.width * 4 + 3],
      frame.pixels[(frame.width * frame.height - 1) * 4 + 3]
    ]
    expect(cornerAlpha.every((alpha) => alpha < 16)).toBe(true)
  }
}

const expectSmallFrameHashes = (relativePath: string): void => {
  for (const [size, expected] of Object.entries(SMALL_FRAME_HASHES[relativePath])) {
    const frame = readIcoFrame(relativePath, Number(size))
    expect(createHash('sha256').update(frame.pixels).digest('hex')).toBe(expected)
  }
}

const rewriteIhdrCrc = (payload: Buffer): void => {
  const typeAndData = payload.subarray(12, 29)
  payload.writeUInt32BE(crc32(typeAndData) >>> 0, 29)
}

const pixelTone = (
  pixels: Buffer,
  offset: number
): 'dark' | 'light' | 'transparent' | undefined => {
  const alpha = pixels[offset + 3]
  if (alpha < 32) return 'transparent'
  if (alpha < 224) return undefined

  const luminance = 0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2]
  if (luminance < 80) return 'dark'
  if (luminance > 200) return 'light'
  return undefined
}

// The 256px Windows frame should remain recognizably derived from the matching V2 source PNG. Tone
// comparison ignores anti-aliased boundary pixels so optical tuning at smaller sizes stays unconstrained.
const expectMatchesV2Source = (icoPath: string, sourcePath: string): void => {
  const frame = readIcoFrame(icoPath, 256)
  const source = decodeRgbaPng(readFileSync(resolve(projectRoot, sourcePath)))
  let compared = 0
  let matched = 0

  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor(((x + 0.5) * source.width) / frame.width)
      )
      const sourceY = Math.min(
        source.height - 1,
        Math.floor(((y + 0.5) * source.height) / frame.height)
      )
      const sourceTone = pixelTone(source.pixels, (sourceY * source.width + sourceX) * 4)
      if (!sourceTone) continue

      compared += 1
      if (pixelTone(frame.pixels, (y * frame.width + x) * 4) === sourceTone) matched += 1
    }
  }

  expect(compared).toBeGreaterThan(frame.width * frame.height * 0.7)
  expect(matched / compared).toBeGreaterThan(0.95)
}

describe('Windows icon assets', () => {
  it('rejects ICO PNG frames with a corrupted chunk CRC', () => {
    const payload = readIcoFramePayload('resources/icon-light.ico', 16)
    payload.writeUInt32BE((payload.readUInt32BE(29) ^ 0xffffffff) >>> 0, 29)

    expect(() => decodeRgbaPng(payload)).toThrow(/CRC/)
  })

  it('rejects ICO PNG frames without a complete IEND chunk', () => {
    const payload = readIcoFramePayload('resources/icon-light.ico', 16)
    const iendOffset = payload.lastIndexOf(Buffer.from('IEND')) - 4

    expect(() => decodeRgbaPng(payload.subarray(0, iendOffset))).toThrow(/IEND/)
  })

  it.each([
    ['compression', 26],
    ['filter', 27]
  ])('rejects ICO PNG frames with an unsupported IHDR %s method', (_field, offset) => {
    const payload = readIcoFramePayload('resources/icon-light.ico', 16)
    payload[offset] = 1
    rewriteIhdrCrc(payload)

    expect(() => decodeRgbaPng(payload)).toThrow(/IHDR/)
  })

  it('configures the packaged Windows executable to use the multi-size application icon', () => {
    const config = loadYaml(readFileSync(resolve(projectRoot, 'electron-builder.yml'), 'utf8')) as {
      win?: { icon?: string }
    }

    expect(config.win?.icon).toBe('build/icon.ico')
  })

  it.each(['build/icon.ico', 'resources/icon-light.ico', 'resources/icon-dark.ico'])(
    'ships exact application-icon frames for Windows shell DPI scales in %s',
    (relativePath) => {
      const entries = readIcoEntries(relativePath)

      expect(entries.map(({ width }) => width).sort((a, b) => a - b)).toEqual(APP_ICON_SIZES)
      expect(entries.every(({ width, height }) => width === height)).toBe(true)
      expect(entries.every(({ bitCount }) => bitCount === 32)).toBe(true)
    }
  )

  it('keeps the packaged default synchronized with the V2 light icon', () => {
    expect(readFileSync(resolve(projectRoot, 'build/icon.ico'))).toEqual(
      readFileSync(resolve(projectRoot, 'resources/icon-light.ico'))
    )
  })

  it('keeps both V2 application variants readable and aligned with their source art', () => {
    expectReadableOnShellBackgrounds('resources/icon-light.ico', 'light')
    expectReadableOnShellBackgrounds('resources/icon-dark.ico', 'dark')
    expectMatchesV2Source('resources/icon-light.ico', 'resources/icon.png')
    expectMatchesV2Source('resources/icon-dark.ico', 'resources/icon-dark.png')
  })

  it.each(Object.keys(SMALL_FRAME_HASHES))(
    'preserves the approved 16/20/24px artwork in %s',
    expectSmallFrameHashes
  )

  it('ships a dedicated multi-size Windows tray icon', () => {
    const entries = readIcoEntries('resources/tray.ico')
    expect(entries.map(({ width }) => width).sort((a, b) => a - b)).toEqual(TRAY_ICON_SIZES)
    expect(entries.every(({ width, height }) => width === height)).toBe(true)
    expect(entries.every(({ bitCount }) => bitCount === 32)).toBe(true)
  })

  it('keeps tray frames large, transparent-cornered, and internally high contrast', () => {
    expectReadableOnShellBackgrounds('resources/tray.ico', 'dark')
  })
})
