import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { buildImageContentData, prepareImageContentData } from './attachment-media'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const withExifOrientation = (jpeg: Buffer, orientation: number): Buffer => {
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00
  ])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const app1 = Buffer.alloc(payload.length + 4)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(payload.length + 2, 2)
  payload.copy(app1, 4)
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

describe('sharp image-processing adapter', () => {
  it('normalizes EXIF orientation before resolving crop coordinates', async () => {
    root = await mkdtemp(join(tmpdir(), 'attachment-media-sharp-'))
    const filePath = join(root, 'oriented.jpg')
    const source = await readFile(resolve(process.cwd(), 'docs/images/readme/skills.jpg'))
    await writeFile(filePath, withExifOrientation(source, 6))

    await expect(
      prepareImageContentData(filePath, {
        crop: { unit: 'pixels', left: 100, top: 200, right: 700, bottom: 1000 },
        maxSize: 400
      })
    ).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      originalSize: { width: 768, height: 1024 },
      crop: { left: 100, top: 200, right: 700, bottom: 1000 },
      outputSize: { width: 300, height: 400 }
    })
  })

  it('uses PNG only when the prepared pixels contain transparency', async () => {
    const opaque = resolve(
      process.cwd(),
      'e2e/visual-regression.spec.ts-snapshots/home-empty-darwin.png'
    )
    const transparent = resolve(process.cwd(), 'resources/tray.png')

    await expect(prepareImageContentData(opaque, { maxSize: 64 })).resolves.toMatchObject({
      mimeType: 'image/jpeg'
    })
    await expect(prepareImageContentData(transparent, { maxSize: 16 })).resolves.toMatchObject({
      mimeType: 'image/png'
    })
  })

  it('chooses the output format from transparency remaining after crop', async () => {
    root = await mkdtemp(join(tmpdir(), 'attachment-media-sharp-alpha-'))
    const filePath = join(root, 'mixed-alpha.png')
    const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0])
    await writeFile(
      filePath,
      await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } })
        .png()
        .toBuffer()
    )

    await expect(
      prepareImageContentData(filePath, {
        crop: { unit: 'pixels', left: 0, top: 0, right: 1, bottom: 1 }
      })
    ).resolves.toMatchObject({ mimeType: 'image/jpeg' })
    await expect(
      prepareImageContentData(filePath, {
        crop: { unit: 'pixels', left: 1, top: 0, right: 2, bottom: 1 }
      })
    ).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it('uses the same transparency-driven policy for oversized upload processing', async () => {
    const opaque = resolve(
      process.cwd(),
      'e2e/visual-regression.spec.ts-snapshots/home-empty-darwin.png'
    )
    const transparent = resolve(process.cwd(), 'resources/tray.png')

    await expect(
      buildImageContentData(opaque, 'image/png', 3 * 1024 * 1024)
    ).resolves.toMatchObject({ mimeType: 'image/jpeg' })
    await expect(
      buildImageContentData(transparent, 'image/png', 3 * 1024 * 1024)
    ).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it.each([
    ['GIF', 'gif', 'image/gif'],
    ['WebP', 'webp', 'image/webp'],
    ['AVIF', 'avif', 'image/avif'],
    ['TIFF', 'tiff', 'image/tiff']
  ] as const)('preserves oversized %s attachment processing', async (_label, format, mimeType) => {
    root = await mkdtemp(join(tmpdir(), 'attachment-media-sharp-format-'))
    const filePath = join(root, `source.${format}`)
    const source = sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    })
    await writeFile(filePath, await source.toFormat(format).toBuffer())

    await expect(buildImageContentData(filePath, mimeType, 3 * 1024 * 1024)).resolves.toMatchObject(
      { mimeType: 'image/jpeg' }
    )
  })
})

it.each(['jpeg', 'png', 'webp'] as const)(
  'removes EXIF from small %s without changing oriented pixels or original bytes',
  async (format) => {
    root = await mkdtemp(join(tmpdir(), 'model-image-privacy-'))
    const path = join(root, `image.${format}`)
    const original = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 4,
        background: { r: 20, g: 100, b: 200, alpha: 0.5 }
      }
    })
      .toFormat(format)
      .withExif({ IFD0: { Artist: 'PRIVATE_AUTHOR_CANARY' } })
      .withMetadata({ orientation: 6 })
      .toBuffer()
    await writeFile(path, original)
    expect((await sharp(original).metadata()).exif).toBeDefined()
    const result = await buildImageContentData(path, `image/${format}`, original.length)
    const output = Buffer.from(result.data, 'base64')
    expect((await sharp(output).metadata()).exif).toBeUndefined()
    expect((await sharp(output).metadata()).icc).toBeUndefined()
    expect(await sharp(output).ensureAlpha().raw().toBuffer()).toEqual(
      await sharp(original).autoOrient().ensureAlpha().raw().toBuffer()
    )
    expect(await readFile(path)).toEqual(original)
  }
)

it.each(['gif', 'webp'] as const)(
  'preserves small %s animation while removing metadata',
  async (format) => {
    root = await mkdtemp(join(tmpdir(), 'model-animation-privacy-'))
    const path = join(root, `image.${format}`)
    const original = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 }
    })
      .toFormat(format, { loop: 2, delay: [100, 200] })
      .toBuffer()
    await writeFile(path, original)
    const result = await buildImageContentData(path, `image/${format}`, original.length)
    const output = Buffer.from(result.data, 'base64')
    expect(await sharp(output, { animated: true }).metadata()).toMatchObject({
      pages: 2,
      loop: 2,
      delay: [100, 200]
    })
    expect(await sharp(output, { animated: true }).ensureAlpha().raw().toBuffer()).toEqual(
      await sharp(original, { animated: true }).ensureAlpha().raw().toBuffer()
    )
  }
)
