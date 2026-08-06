import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = process.env['WINDOWS_ICON_TEST_ROOT']
  ? resolve(process.env['WINDOWS_ICON_TEST_ROOT'])
  : resolve(__dirname, '../..')

type IcoEntry = {
  width: number
  height: number
  bitCount: number
  byteSize: number
  imageOffset: number
}

const APP_ICON_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const LIGHT_SMALL_FRAME_HASHES = {
  16: '0787e4735835ca5fbdb3e9dba6503b1be42ac158c9697b86a5eb453091c2f287',
  20: 'a53cf11df1e7f7415354d422da6f4833cbf0f87f18d88320777a188022ac12aa',
  24: 'ab9f6d540ac9a9bc39c61b20ae5de10e0ec700f2f0be7647e56fe40ed4bd8158'
}
const DARK_SMALL_FRAME_HASHES = {
  16: '14de66f924f41608a172ec4f9b47250b6d3b3eaa1adddf11a22f00bde222e417',
  20: 'bde25166f295f9a991ed876bb133a87a2b1d08dbfad3f30e5ea84611150edfe0',
  24: '3c7c65e7280b88c29c0964377061963e86615ff38ee3060f8ad481631a6ceb9f'
}
const ICON_ASSETS = [
  {
    relativePath: 'build/icon.ico',
    expectedSizes: APP_ICON_SIZES,
    expectedSha256: '751f333327cc0a19d5120cf85d10bc9b8efcfc270d6ae0e494814725237b5692'
  },
  {
    relativePath: 'resources/icon-light.ico',
    expectedSizes: APP_ICON_SIZES,
    expectedSha256: '751f333327cc0a19d5120cf85d10bc9b8efcfc270d6ae0e494814725237b5692'
  },
  {
    relativePath: 'resources/icon-dark.ico',
    expectedSizes: APP_ICON_SIZES,
    expectedSha256: '5e13ac218c0622eb232dfcb1d29f0330e1a261d35344776276dfc1f808bc115d'
  },
  {
    relativePath: 'resources/tray-light.ico',
    expectedSizes: TRAY_ICON_SIZES,
    expectedSha256: 'e74600b52ba9d6905a76ba256a75ad0266d2a6cdd23c0b79fc45ede6846f6dcb'
  },
  {
    relativePath: 'resources/tray-dark.ico',
    expectedSizes: TRAY_ICON_SIZES,
    expectedSha256: '5ddaa180a54d4f01738927da9546c0bb5f037b67420bbea93cf935c6bfda3180'
  }
]

const readIco = (
  relativePath: string
): { bytes: Buffer; reserved: number; type: number; entries: IcoEntry[] } => {
  const bytes = readFileSync(resolve(projectRoot, relativePath))
  const count = bytes.readUInt16LE(4)
  const entries = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16
    return {
      width: bytes[offset] || 256,
      height: bytes[offset + 1] || 256,
      bitCount: bytes.readUInt16LE(offset + 6),
      byteSize: bytes.readUInt32LE(offset + 8),
      imageOffset: bytes.readUInt32LE(offset + 12)
    }
  })

  return {
    bytes,
    reserved: bytes.readUInt16LE(0),
    type: bytes.readUInt16LE(2),
    entries
  }
}

describe('Windows icon assets', () => {
  it.each(ICON_ASSETS)('ships the approved multi-size ICO in $relativePath', (asset) => {
    const { bytes, reserved, type, entries } = readIco(asset.relativePath)
    const directoryEnd = 6 + entries.length * 16

    expect(reserved).toBe(0)
    expect(type).toBe(1)
    expect(entries.map(({ width }) => width).sort((a, b) => a - b)).toEqual(asset.expectedSizes)
    expect(entries.every(({ width, height }) => width === height)).toBe(true)
    expect(entries.every(({ bitCount }) => bitCount === 32)).toBe(true)
    expect(
      entries.every(
        ({ byteSize, imageOffset }) =>
          imageOffset >= directoryEnd && imageOffset + byteSize <= bytes.length
      )
    ).toBe(true)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.expectedSha256)
  })

  it('keeps the packaged default synchronized with the V3 light icon', () => {
    expect(readFileSync(resolve(projectRoot, 'build/icon.ico'))).toEqual(
      readFileSync(resolve(projectRoot, 'resources/icon-light.ico'))
    )
  })

  it.each([
    { relativePath: 'build/icon.ico', expectedHashes: LIGHT_SMALL_FRAME_HASHES },
    { relativePath: 'resources/icon-light.ico', expectedHashes: LIGHT_SMALL_FRAME_HASHES },
    { relativePath: 'resources/icon-dark.ico', expectedHashes: DARK_SMALL_FRAME_HASHES }
  ])('keeps the V3 ring recognizable in the small frames of $relativePath', (asset) => {
    const { bytes, entries } = readIco(asset.relativePath)
    const smallFrameHashes = Object.fromEntries(
      entries
        .filter(({ width }) => width in asset.expectedHashes)
        .map(({ width, byteSize, imageOffset }) => [
          width,
          createHash('sha256')
            .update(bytes.subarray(imageOffset, imageOffset + byteSize))
            .digest('hex')
        ])
    )

    expect(smallFrameHashes).toEqual(asset.expectedHashes)
  })
})
