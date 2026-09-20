import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { compareReproducedContent, validOutputComparisonReport } from './output-comparison'
import { DEFAULT_OUTPUT_COMPARISON_POLICY } from '../../shared/output-comparison'

const table = (
  expected: string,
  actual: string,
  policy = DEFAULT_OUTPUT_COMPARISON_POLICY
): ReturnType<typeof compareReproducedContent> =>
  compareReproducedContent({
    filename: 'counts.csv',
    expected: Buffer.from(expected),
    actual: Buffer.from(actual),
    policy
  })

// Uncompressed unsigned 16-bit grayscale TIFF: exact samples, independent of display encoders.
const tiff16 = (samples: number[], bigEndian = false): Buffer => {
  const pixelsOffset = 8 + 2 + 10 * 12 + 4
  const bytes = Buffer.alloc(pixelsOffset + samples.length * 2)
  const short = (value: number, offset: number): void => {
    if (bigEndian) bytes.writeUInt16BE(value, offset)
    else bytes.writeUInt16LE(value, offset)
  }
  const long = (value: number, offset: number): void => {
    if (bigEndian) bytes.writeUInt32BE(value, offset)
    else bytes.writeUInt32LE(value, offset)
  }
  bytes.write(bigEndian ? 'MM' : 'II')
  short(42, 2)
  long(8, 4)
  short(10, 8)
  const entries = [
    [256, 4, samples.length],
    [257, 4, 1],
    [258, 3, 16],
    [259, 3, 1],
    [262, 3, 1],
    [273, 4, pixelsOffset],
    [277, 3, 1],
    [278, 4, 1],
    [279, 4, samples.length * 2],
    [339, 3, 1]
  ]
  entries.forEach(([tag, type, value], index) => {
    const offset = 10 + index * 12
    short(tag!, offset)
    short(type!, offset + 2)
    long(1, offset + 4)
    ;(type === 3 ? short : long)(value!, offset + 8)
  })
  samples.forEach((sample, index) => short(sample, pixelsOffset + index * 2))
  return bytes
}

describe('reproduced content comparison', () => {
  it('compares TIFF pixels across compression encodings and supplies browser previews', async () => {
    const raw = Buffer.alloc(10 * 10 * 3, 100)
    const encode = (compression: 'none' | 'lzw'): Promise<Buffer> =>
      sharp(raw, { raw: { width: 10, height: 10, channels: 3 } })
        .tiff({ compression })
        .toBuffer()
    const expected = await encode('none')
    const actual = await encode('lzw')
    const equal = await compareReproducedContent({ filename: 'plot.TIFF', expected, actual })
    expect(equal.report.outcome).toBe('equal')
    expect(equal.report.expectedChecksum).not.toBe(equal.report.actualChecksum)
    raw[0] = 101
    const result = await compareReproducedContent({
      filename: 'plot.tif',
      expected,
      actual: await encode('lzw'),
      preview: true
    })
    expect(result.report.image).toMatchObject({ changedPixels: 1, maxDifference: 1 })
    expect(result.report.outcome).toBe('different')
    expect(result.originalImage).toMatch(/^data:image\/png;base64,/u)
    expect(result.reproducedImage).toMatch(/^data:image\/png;base64,/u)
    expect(result.differenceImage).toMatch(/^data:image\/png;base64,/u)
    expect(
      validOutputComparisonReport(
        result.report,
        result.report.expectedChecksum,
        result.report.actualChecksum
      )
    ).toBe(true)
  })

  it('preserves one-level 16-bit TIFF differences across byte orders and tolerance checks', async () => {
    const expected = tiff16([1000, 65535])
    const same = await compareReproducedContent({
      filename: 'samples.tif',
      expected,
      actual: tiff16([1000, 65535], true)
    })
    expect(same.report.outcome).toBe('equal')
    const actual = tiff16([1001, 65535], true)
    const different = await compareReproducedContent({
      filename: 'samples.tif',
      expected,
      actual,
      preview: true
    })
    expect(different.report.outcome).toBe('different')
    expect(different.report.image).toMatchObject({ bitDepth: 16, changedPixels: 1 })
    expect(different.report.image?.maxDifference).toBeCloseTo(1 / 257, 10)
    expect(different.report.image?.rmse).toBeGreaterThan(0)
    expect(
      validOutputComparisonReport(
        different.report,
        different.report.expectedChecksum,
        different.report.actualChecksum
      )
    ).toBe(true)
    const policy = structuredClone(DEFAULT_OUTPUT_COMPARISON_POLICY)
    policy.image = { maxRmse: 0.004, maxChangedPixelRatio: 0.5 }
    expect(
      (await compareReproducedContent({ filename: 'samples.tif', expected, actual, policy })).report
        .outcome
    ).toBe('within-tolerance')
    const preview = Buffer.from(different.originalImage!.split(',')[1]!, 'base64')
    expect((await sharp(preview).metadata()).format).toBe('png')
    const display = await sharp(preview).ensureAlpha().raw().toBuffer()
    expect(Math.abs(display[0]! - 1000 / 257)).toBeLessThan(1)
    expect(display[4]).toBe(255)
  })

  it('does not coerce signed TIFF samples or mixed bit depths into equal pixels', async () => {
    const signed = tiff16([1000])
    signed.writeUInt16LE(2, 10 + 9 * 12 + 8)
    expect((await sharp(signed).metadata()).depth).toBe('short')
    expect(
      (await compareReproducedContent({ filename: 'signed.tif', expected: signed, actual: signed }))
        .report
    ).toMatchObject({ outcome: 'unavailable', reason: 'unsupported-format' })
    const byte = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } })
      .tiff()
      .toBuffer()
    expect(
      (
        await compareReproducedContent({
          filename: 'mixed.tif',
          expected: tiff16([65535]),
          actual: byte
        })
      ).report
    ).toMatchObject({ outcome: 'unavailable', reason: 'unsupported-format' })
  })

  it('rejects multi-page TIFF rather than comparing only the first page', async () => {
    const expected = await sharp(Buffer.alloc(2 * 4 * 3, 100), {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 }
    })
      .tiff()
      .toBuffer()
    expect((await sharp(expected).metadata()).pages).toBe(2)
    expect(
      (await compareReproducedContent({ filename: 'stack.tiff', expected, actual: expected }))
        .report
    ).toMatchObject({ outcome: 'unavailable', reason: 'unsupported-format' })
  })

  it('rejects oversized TIFF headers before decoding and reports corrupt TIFF', async () => {
    const expected = tiff16([1])
    expected.writeUInt32LE(4_000_001, 18)
    expect(
      (await compareReproducedContent({ filename: 'large.tif', expected, actual: expected })).report
    ).toMatchObject({ outcome: 'unavailable', reason: 'budget-exceeded' })
    const invalid = Buffer.from('49492a00', 'hex')
    expect(
      (await compareReproducedContent({ filename: 'bad.tif', expected: invalid, actual: invalid }))
        .report
    ).toMatchObject({ outcome: 'unavailable', reason: 'invalid-content' })
  })
  it('compares decoded CSV with strict identities and handles reordered columns', async () => {
    const { report } = await table('sample,count\r\n"001",33\r\n', 'count,sample\n33,001\n')
    expect(report.outcome).toBe('equal')
    expect(report.expectedChecksum).not.toBe(report.actualChecksum)
    expect(
      validOutputComparisonReport(report, report.expectedChecksum, report.actualChecksum)
    ).toBe(true)
    expect((await table('id\n001\n', 'id\n1\n')).report.outcome).toBe('different')
  })
  it('applies explicitly selected numeric tolerances after key alignment', async () => {
    const policy = structuredClone(DEFAULT_OUTPUT_COMPARISON_POLICY)
    policy.table = {
      keys: ['id'],
      numericColumns: ['value'],
      absoluteTolerance: 0.01,
      relativeTolerance: 0
    }
    const { report } = await table('id,value\na,33\nb,0\n', 'id,value\nb,0.005\na,33.001\n', policy)
    expect(report.outcome).toBe('within-tolerance')
    expect(report.table).toMatchObject({ changedCells: 2, outsideTolerance: 0, missingRows: 0 })
    expect((await table('id,value\na,33\n', 'id,value\na,35\n', policy)).report.outcome).toBe(
      'different'
    )
  })
  it('never silently discards missing rows, duplicate identities or missing selected columns', async () => {
    const policy = structuredClone(DEFAULT_OUTPUT_COMPARISON_POLICY)
    policy.table.keys = ['id']
    expect((await table('id\na\nb\n', 'id\na\n', policy)).report.table?.missingRows).toBe(1)
    expect((await table('id\na\na\n', 'id\na\n', policy)).report.reason).toBe('duplicate-key')
    expect((await table('x\na\n', 'x\na\n', policy)).report.reason).toBe('missing-key')
  })
  it('does not coerce missing values or parse malformed CSV as equal', async () => {
    expect((await table('x\n"bad\n', 'x\n"bad\n')).report.outcome).toBe('unavailable')
    const policy = structuredClone(DEFAULT_OUTPUT_COMPARISON_POLICY)
    policy.table.numericColumns = ['x']
    policy.table.absoluteTolerance = 10
    expect((await table('id,x\na,\n', 'id,x\na,0\n', policy)).report.outcome).toBe('different')
  })
  it('compares every cell while bounding the detail list', async () => {
    const { report } = await table('x\n' + '1\n'.repeat(130), 'x\n' + '2\n'.repeat(130))
    expect(report.table).toMatchObject({
      changedCells: 130,
      outsideTolerance: 130,
      detailsTruncated: true
    })
    expect(report.table?.differences).toHaveLength(100)
  })
  it('distinguishes PNG encoding from pixel changes and produces a difference image', async () => {
    const raw = Buffer.alloc(10 * 10 * 3, 100)
    const expected = await sharp(raw, { raw: { width: 10, height: 10, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer()
    const actual = await sharp(raw, { raw: { width: 10, height: 10, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toBuffer()
    const equal = await compareReproducedContent({ filename: 'plot.png', expected, actual })
    expect(equal.report.outcome).toBe('equal')
    expect(equal.report.image?.ssim).toBeCloseTo(1)
    raw[0] = 200
    const different = await sharp(raw, { raw: { width: 10, height: 10, channels: 3 } })
      .png()
      .toBuffer()
    const result = await compareReproducedContent({
      filename: 'plot.png',
      expected,
      actual: different,
      preview: true
    })
    expect(result.report.outcome).toBe('different')
    expect(result.report.image?.changedPixels).toBe(1)
    expect(result.differenceImage).toMatch(/^data:image\/png;base64,/u)
    const policy = structuredClone(DEFAULT_OUTPUT_COMPARISON_POLICY)
    policy.image = { maxRmse: 6, maxChangedPixelRatio: 0.01 }
    expect(
      (
        await compareReproducedContent({
          filename: 'plot.png',
          expected,
          actual: different,
          policy
        })
      ).report.outcome
    ).toBe('within-tolerance')
  })
  it('does not resize images or treat unsupported data as a match', async () => {
    const expected = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'white' }
    })
      .png()
      .toBuffer()
    const actual = await sharp(expected).resize(3, 3).png().toBuffer()
    expect(
      (await compareReproducedContent({ filename: 'plot.png', expected, actual })).report.reason
    ).toBe('shape-mismatch')
    expect(
      (
        await compareReproducedContent({
          filename: 'data.rds',
          expected: Buffer.from('a'),
          actual: Buffer.from('b')
        })
      ).report.outcome
    ).toBe('unavailable')
  })
  it('rejects invalid policies and cancelled work', async () => {
    const policy = structuredClone(DEFAULT_OUTPUT_COMPARISON_POLICY)
    policy.image.maxRmse = NaN
    await expect(table('x\n1', 'x\n2', policy)).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    await expect(
      compareReproducedContent({
        filename: 'x.csv',
        expected: Buffer.from('x'),
        actual: Buffer.from('x'),
        signal: controller.signal
      })
    ).rejects.toThrow()
  })
})
