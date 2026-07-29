import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

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
  const compressed: Buffer[] = []
  while (cursor < payload.length) {
    const length = payload.readUInt32BE(cursor)
    const type = payload.toString('ascii', cursor + 4, cursor + 8)
    const data = payload.subarray(cursor + 8, cursor + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect(data[8]).toBe(8)
      expect(data[9]).toBe(6)
      expect(data[12]).toBe(0)
    } else if (type === 'IDAT') {
      compressed.push(data)
    }
    cursor += 12 + length
    if (type === 'IEND') break
  }

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
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const offset = (y * frame.width + x) * 4
        const alpha = frame.pixels[offset + 3]
        if (alpha < 128) continue

        visible += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        const luminance =
          0.299 * frame.pixels[offset] +
          0.587 * frame.pixels[offset + 1] +
          0.114 * frame.pixels[offset + 2]
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

    const cornerAlpha = [
      frame.pixels[3],
      frame.pixels[(frame.width - 1) * 4 + 3],
      frame.pixels[(frame.height - 1) * frame.width * 4 + 3],
      frame.pixels[(frame.width * frame.height - 1) * 4 + 3]
    ]
    expect(cornerAlpha.every((alpha) => alpha < 16)).toBe(true)
  }
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

  it('ships a dedicated multi-size Windows tray icon', () => {
    const entries = readIcoEntries('resources/tray.ico')
    expect(entries.map(({ width }) => width).sort((a, b) => a - b)).toEqual(TRAY_ICON_SIZES)
    expect(entries.every(({ width, height }) => width === height)).toBe(true)
    expect(entries.every(({ bitCount }) => bitCount === 32)).toBe(true)
  })

  it('keeps tray frames large, transparent-cornered, and internally high contrast', () => {
    expectReadableOnShellBackgrounds('resources/tray.ico', 'light')
  })
})
