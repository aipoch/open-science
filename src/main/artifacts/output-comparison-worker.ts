import type { OutputComparisonPolicy, OutputComparisonReport } from '../../shared/output-comparison'

type Input = {
  expected: Uint8Array
  actual: Uint8Array
  filename: string
  policy: OutputComparisonPolicy
  preview?: boolean
}
type Result = Pick<
  OutputComparisonReport,
  'kind' | 'outcome' | 'reason' | 'image' | 'table' | 'scientific'
> & {
  differenceImage?: string
  originalImage?: string
  reproducedImage?: string
}

// This function is also the isolated worker entry. Keep runtime dependencies explicit so the
// packaged app does not depend on its launch directory or on the user's Python/R environment.
export const compareOutputContent = async (
  input: Input,
  sharp: typeof import('sharp').default,
  papa: typeof import('papaparse'),
  compareScientificTables: typeof import('./scientific-output-comparison').compareScientificTables
): Promise<Result> => {
  const before = Buffer.from(input.expected)
  const after = Buffer.from(input.actual)
  const isTiff = (b: Buffer): boolean =>
    ['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(b.subarray(0, 4).toString('hex'))
  const imageFormat = (b: Buffer): boolean =>
    b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    (b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    isTiff(b)
  if (imageFormat(before) && imageFormat(after)) {
    const decode = async (
      bytes: Buffer
    ): Promise<{
      data: Buffer | Uint16Array
      info: import('sharp').OutputInfo
      bitDepth: 8 | 16
    }> => {
      const source = sharp(bytes, {
        limitInputPixels: 4_000_000,
        failOn: 'warning',
        ignoreIcc: isTiff(bytes)
      }).timeout({ seconds: 15 })
      const metadata = await source.metadata()
      if (
        (metadata.pages && metadata.pages !== 1) ||
        metadata.subifds ||
        (metadata.levels?.length ?? 0) > 1
      )
        throw new Error('unsupported-format')
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > 16_384 ||
        metadata.height > 16_384
      )
        throw new Error('pixel limit')
      const bitDepth =
        metadata.depth === 'ushort' && isTiff(bytes) && ['grey16', 'rgb16'].includes(metadata.space)
          ? 16
          : 8
      // Never quantize signed/floating-point or unsupported scientific samples to display bytes.
      if (metadata.depth !== 'uchar' && bitDepth !== 16) throw new Error('unsupported-format')
      const decoded = await source
        .rotate()
        .toColourspace(bitDepth === 16 ? 'rgb16' : 'srgb')
        .ensureAlpha()
        .raw({ depth: bitDepth === 16 ? 'ushort' : 'uchar' })
        .toBuffer({ resolveWithObject: true })
      return {
        ...decoded,
        bitDepth,
        data:
          bitDepth === 16
            ? new Uint16Array(
                decoded.data.buffer,
                decoded.data.byteOffset,
                decoded.data.byteLength / 2
              )
            : decoded.data
      }
    }
    let a: Awaited<ReturnType<typeof decode>>
    let b: Awaited<ReturnType<typeof decode>>
    try {
      a = await decode(before)
      b = await decode(after)
    } catch (error) {
      const message = String(error)
      return {
        kind: 'image',
        outcome: 'unavailable',
        reason: message.includes('pixel limit')
          ? 'budget-exceeded'
          : message.includes('unsupported-format')
            ? 'unsupported-format'
            : 'invalid-content'
      }
    }
    if (a.info.width !== b.info.width || a.info.height !== b.info.height)
      return { kind: 'image', outcome: 'different', reason: 'shape-mismatch' }
    if (a.bitDepth !== b.bitDepth)
      return { kind: 'image', outcome: 'unavailable', reason: 'unsupported-format' }
    const { width, height } = a.info
    const sampleScale = a.bitDepth === 16 ? 257 : 1
    const pixels = width * height
    let changedPixels = 0,
      squared = 0,
      maxDifference = 0
    const heat = input.preview ? Buffer.alloc(pixels * 4) : undefined
    for (let p = 0; p < pixels; p++) {
      let changed = false,
        local = 0
      for (let c = 0; c < 4; c++) {
        const delta = Math.abs(a.data[p * 4 + c]! - b.data[p * 4 + c]!) / sampleScale
        squared += delta * delta
        changed ||= delta !== 0
        local = Math.max(local, delta)
      }
      if (changed) changedPixels++
      maxDifference = Math.max(maxDifference, local)
      if (heat) {
        heat[p * 4] = changed ? 220 : 245
        heat[p * 4 + 1] = changed ? 35 : 245
        heat[p * 4 + 2] = changed ? 35 : 245
        heat[p * 4 + 3] = 255
      }
    }
    // Sliding 7x7 SSIM in O(pixels), with seven rows of moments instead of full-image
    // integral arrays. SSIM is advisory; the acceptance rule also checks all RGBA channels.
    let ssim: number | undefined
    if (width >= 7 && height >= 7) {
      const sums = new Float64Array(width * 5)
      const ring = Array.from({ length: 7 }, () => new Float64Array(width * 5))
      let total = 0,
        windows = 0
      const gray = (data: Buffer | Uint16Array, index: number): number =>
        (0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!) /
        sampleScale
      for (let y = 0; y < height; y++) {
        const row = ring[y % 7]!
        for (let i = 0; i < row.length; i++) {
          sums[i] -= row[i]!
          row[i] = 0
        }
        const horizontal = [0, 0, 0, 0, 0]
        for (let x = 0; x < width; x++) {
          const av = gray(a.data, (y * width + x) * 4),
            bv = gray(b.data, (y * width + x) * 4)
          const values = [av, bv, av * av, bv * bv, av * bv]
          if (x >= 7) {
            const oldA = gray(a.data, (y * width + x - 7) * 4),
              oldB = gray(b.data, (y * width + x - 7) * 4)
            const old = [oldA, oldB, oldA * oldA, oldB * oldB, oldA * oldB]
            for (let k = 0; k < 5; k++) horizontal[k] -= old[k]!
          }
          for (let k = 0; k < 5; k++) {
            horizontal[k] += values[k]!
            row[x * 5 + k] = horizontal[k]!
            sums[x * 5 + k] += horizontal[k]!
          }
          if (x < 6 || y < 6) continue
          const ma = sums[x * 5]! / 49,
            mb = sums[x * 5 + 1]! / 49
          const va = Math.max(0, ((sums[x * 5 + 2]! / 49 - ma * ma) * 49) / 48)
          const vb = Math.max(0, ((sums[x * 5 + 3]! / 49 - mb * mb) * 49) / 48)
          const cov = ((sums[x * 5 + 4]! / 49 - ma * mb) * 49) / 48
          total +=
            ((2 * ma * mb + 6.5025) * (2 * cov + 58.5225)) /
            ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225))
          windows++
        }
      }
      ssim = Math.max(-1, Math.min(1, total / windows))
    }
    const rmse = Math.sqrt(squared / (pixels * 4)),
      ratio = changedPixels / pixels
    let differenceImage: string | undefined
    let originalImage: string | undefined
    let reproducedImage: string | undefined
    if (heat) {
      const png = await sharp(heat, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer()
      if (png.length <= 2 * 1024 * 1024)
        differenceImage = `data:image/png;base64,${png.toString('base64')}`
    }
    if (input.preview && (isTiff(before) || isTiff(after))) {
      // Browser previews are bounded display images; all metrics above use full-precision samples.
      const preview = async (decoded: typeof a): Promise<string | undefined> => {
        const png = await sharp(decoded.data, { raw: { width, height, channels: 4 } })
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer()
        return png.length <= 2 * 1024 * 1024
          ? `data:image/png;base64,${png.toString('base64')}`
          : undefined
      }
      originalImage = await preview(a)
      reproducedImage = await preview(b)
    }
    return {
      kind: 'image',
      outcome: !changedPixels
        ? 'equal'
        : rmse <= input.policy.image.maxRmse && ratio <= input.policy.image.maxChangedPixelRatio
          ? 'within-tolerance'
          : 'different',
      image: {
        width,
        height,
        ...(a.bitDepth === 16 ? { bitDepth: a.bitDepth } : {}),
        changedPixels,
        changedPixelRatio: ratio,
        rmse,
        maxDifference,
        ...(ssim === undefined ? {} : { ssim })
      },
      ...(differenceImage ? { differenceImage } : {}),
      ...(originalImage ? { originalImage } : {}),
      ...(reproducedImage ? { reproducedImage } : {})
    }
  }
  if (!/\.(csv|tsv)$/iu.test(input.filename))
    return { kind: 'unsupported', outcome: 'unavailable', reason: 'unsupported-format' }
  const delimiter = /\.tsv$/iu.test(input.filename) ? '\t' : ','
  const parse = (bytes: Buffer): string[][] => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const result = papa.parse<string[]>(text, {
      delimiter,
      skipEmptyLines: false,
      preview: 100_002
    })
    if (result.errors.length) throw new Error('invalid-content')
    const rows = result.data
    if (rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '' && /[\r\n]$/u.test(text)) rows.pop()
    if (result.meta.truncated || rows.length > 100_001) throw new Error('budget-exceeded')
    const header = rows[0]
    if (
      !header?.length ||
      header.some((v) => !v || v.length > 256) ||
      new Set(header).size !== header.length ||
      rows.some((r) => r.length !== header.length)
    )
      throw new Error('invalid-content')
    if (header.length > 256 || rows.length * header.length > 2_000_000)
      throw new Error('budget-exceeded')
    return rows
  }
  let a: string[][], b: string[][]
  try {
    a = parse(before)
    b = parse(after)
  } catch (error) {
    return {
      kind: 'table',
      outcome: 'unavailable',
      reason: String(error).includes('budget-exceeded') ? 'budget-exceeded' : 'invalid-content'
    }
  }
  const columns = a[0]!,
    actualColumns = b[0]!
  if (columns.length !== actualColumns.length || columns.some((c) => !actualColumns.includes(c)))
    return { kind: 'table', outcome: 'different', reason: 'schema-mismatch' }
  const policy = input.policy.table
  if ([...policy.keys, ...policy.numericColumns].some((c) => !columns.includes(c)))
    return { kind: 'table', outcome: 'unavailable', reason: 'missing-key' }
  const indexes = columns.map((c) => actualColumns.indexOf(c))
  const keys = policy.keys.map((c) => columns.indexOf(c))
  const rows = (data: string[][], reorder: boolean): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    for (let i = 1; i < data.length; i++) {
      const row = reorder ? indexes.map((index) => data[i]![index]!) : data[i]!
      if (keys.some((index) => row[index] === '')) throw new Error('missing-key')
      const key = keys.length ? JSON.stringify(keys.map((index) => row[index])) : String(i)
      if (map.has(key)) throw new Error('duplicate-key')
      map.set(key, row)
    }
    return map
  }
  let left: Map<string, string[]>, right: Map<string, string[]>
  try {
    left = rows(a, false)
    right = rows(b, true)
  } catch (error) {
    return {
      kind: 'table',
      outcome: 'unavailable',
      reason: String(error).includes('duplicate-key') ? 'duplicate-key' : 'missing-key'
    }
  }
  const number = (value: string): number | undefined =>
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) && Number.isFinite(Number(value))
      ? Number(value)
      : undefined
  const details: NonNullable<OutputComparisonReport['table']>['differences'] = []
  let changedCells = 0,
    outsideTolerance = 0,
    missingRows = 0,
    addedRows = 0,
    maxAbsoluteError = 0
  const numeric = new Set(policy.numericColumns)
  for (const [key, row] of left) {
    const actual = right.get(key)
    if (!actual) {
      missingRows++
      continue
    }
    for (let c = 0; c < columns.length; c++) {
      if (row[c] === actual[c]) continue
      changedCells++
      const av = numeric.has(columns[c]!) ? number(row[c]!) : undefined
      const bv = numeric.has(columns[c]!) ? number(actual[c]!) : undefined
      const delta = av !== undefined && bv !== undefined ? Math.abs(av - bv) : undefined
      const withinTolerance =
        delta !== undefined &&
        Number.isFinite(delta) &&
        delta <= policy.absoluteTolerance + policy.relativeTolerance * Math.abs(av!)
      if (!withinTolerance) outsideTolerance++
      if (delta !== undefined && Number.isFinite(delta))
        maxAbsoluteError = Math.max(maxAbsoluteError, delta)
      if (details.length < 100)
        details.push({
          row: key.slice(0, 512),
          column: columns[c]!,
          expected: row[c]!.slice(0, 512),
          actual: actual[c]!.slice(0, 512),
          withinTolerance
        })
    }
  }
  for (const key of right.keys()) if (!left.has(key)) addedRows++
  return {
    kind: 'table',
    ...(input.policy.scientific
      ? { scientific: compareScientificTables(a, b, input.policy.scientific) }
      : {}),
    outcome:
      missingRows || addedRows || outsideTolerance
        ? 'different'
        : changedCells
          ? 'within-tolerance'
          : 'equal',
    table: {
      expectedRows: left.size,
      actualRows: right.size,
      columns: columns.length,
      changedCells,
      outsideTolerance,
      missingRows,
      addedRows,
      maxAbsoluteError,
      differences: details,
      detailsTruncated: changedCells > details.length
    }
  }
}

export type { Input as OutputComparisonWorkerInput, Result as OutputComparisonWorkerResult }
