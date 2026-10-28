import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousRasterRoot } = await import(
  pathToFileURL(resolve('test/fixtures/isolated-form-figure.mjs')).href
)
const { nativeIsolatedRasterFigureCrop, nativeIsolatedRasterFigurePngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-isolated-raster.mjs')).href
)
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { nativeIsolatedRasterScopeData } = await import(
  pathToFileURL(resolve('resources/literature-pdf-isolated-raster-scope.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { createCanvas } = await import('@napi-rs/canvas')
type Fixture = ReturnType<typeof anonymousRasterRoot>
type Control = [string, (fixture: Fixture) => void]
const crop = (f: Fixture): ReturnType<typeof nativeIsolatedRasterFigureCrop> =>
  nativeIsolatedRasterFigureCrop(...f.args)
const group = (
  f: Fixture
): { isolated: boolean; knockout: boolean; matrix: unknown; smask: unknown; bbox: number[] } =>
  f.o.argsArray[f.o.fnArray.indexOf(OPS.beginGroup)][0]

it('owns the complete raster-only isolated root and rectangular child without changing the default packet', () => {
  const f = anonymousRasterRoot()
  expect(f.capture()).toBeTruthy()
  const out = crop(f)
  expect(out?.rect).toEqual([60, 70, 340, 260])
  expect(out?.graphicsCount).toBe(2)
  expect(out?.sourceItems).toEqual([])
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
})

it('hashes one real typed RGBA payload above the legacy limit without adding a global image hash', () => {
  const f = anonymousRasterRoot()
  f.image.width = 2001
  f.image.height = 2000
  f.image.data = new Uint8ClampedArray(2001 * 2000 * 4)
  f.image.data.fill(255)
  f.image.data.set([0, 0, 0, 128])
  f.o.argsArray[f.imageIndex][1] = 2001
  f.o.argsArray[f.imageIndex][2] = 2000
  delete f.context.graphicsBounds[0].imageHash
  expect(f.capture()).toBeTruthy()
  expect(crop(f)).toBeTruthy()
  expect(f.context.isolatedRasterScope.images[0].bytes).toBe(16_008_000)
  expect(f.context.isolatedRasterScope.images[0].sha256).toBe(
    createHash('sha256').update('2001:2000:3:').update(f.image.data).digest('hex')
  )
  expect(f.context.graphicsBounds[0].imageHash).toBeUndefined()
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
})

it('checks the complete encoded footprint, rejects forged certificates and preserves foreign exclusion', () => {
  const f = anonymousRasterRoot()
  expect(f.capture()).toBeTruthy()
  const out = crop(f),
    scale = Math.ceil(f.page.width * 1.5) / f.page.width,
    rect = out.rect.map(
      (value: number, axis: number) => value + (axis < 2 ? -2 / scale : 2 / scale)
    ),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeIsolatedRasterFigurePngSafe(png, rect, f.page, out)).toBe(true)
  expect(
    nativeIsolatedRasterFigurePngSafe(png, rect, f.page, {
      ...out,
      formCropRaster: structuredClone(out.formCropRaster)
    })
  ).toBe(false)
  expect(
    nativeIsolatedRasterFigurePngSafe(
      png,
      rect.map((value: number, axis: number) => value + (axis < 2 ? -1 : 1)),
      f.page,
      out
    )
  ).toBe(false)
  expect(
    nativeIsolatedRasterFigurePngSafe(createCanvas(1, 1).toBuffer('image/png'), rect, f.page, out)
  ).toBe(false)
  const corrupt = Buffer.from(png)
  corrupt[0] = 0
  expect(nativeIsolatedRasterFigurePngSafe(corrupt, rect, f.page, out)).toBe(false)
})

it('keeps the complete foreign native header when its navigation token is filtered', () => {
  const f = anonymousRasterRoot()
  expect(f.capture()).toBeTruthy()
  f.tokens.splice(0, 1)
  const out = crop(f)
  expect(out).toBeTruthy()
  expect(
    out.formCropRaster.foreignPaints.some(
      (paint: { rect: number[] }) => paint.rect[1] <= 25 && paint.rect[3] >= 35
    )
  ).toBe(true)
})

it('declines an isolated root unrelated to the detected figure', () => {
  const f = anonymousRasterRoot()
  f.figure.rect = [40, 270, 360, 295]
  expect(f.capture()).toBeTruthy()
  expect(crop(f)).toBeUndefined()
})

it.each([false, true])(
  'keeps a native companion in the complete body-to-caption lane: %s',
  (outsideSeed) => {
    const f = anonymousRasterRoot()
    f.figure.rect = outsideSeed ? [80, 20, 320, 265] : [40, 20, 360, 295]
    const show = f.o.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText && f.o.argsArray[i][0][0].unicode.startsWith('Figure 1:')
      ),
      at = show - 3
    f.o.fnArray.splice(at, 0, OPS.constructPath)
    f.o.argsArray.splice(at, 0, [
      OPS.fill,
      [[0, 40, 110, 1, 360, 110, 1, 360, 130, 1, 40, 130, 4]],
      [40, 110, 360, 130]
    ])
    f.context.graphicsBounds.push({
      operationIndex: at,
      kind: 'path',
      normalizedRect: [0.1, 0.675, 0.9, 0.725]
    })
    f.observed.scanned = f.o.fnArray.length
    f.observed.paths = new Map(
      f.o.fnArray.flatMap((op: number, i: number) =>
        op === OPS.constructPath ? [[i, f.o.argsArray[i]]] : []
      )
    )
    expect(f.capture()).toBeTruthy()
    expect(crop(f)).toBeUndefined()
  }
)
it('declines a complete native label in the caption lane even without a navigation token', () => {
  const f = anonymousRasterRoot(),
    header = f.context.content.items[0],
    show = f.o.fnArray.indexOf(OPS.showText)
  header.transform[5] = 120
  f.o.argsArray[show - 1][0][5] = 120
  f.tokens.splice(0, 1)
  expect(f.capture()).toBeTruthy()
  expect(crop(f)).toBeUndefined()
})

it.each(['table', 'caption'])('declines unresolved caption-lane ownership: %s', (mode) => {
  const f = anonymousRasterRoot()
  if (mode === 'table') f.args[3].push([80, 270, 160, 280])
  if (mode === 'caption')
    f.args[2].push({ page: 1, rect: [80, 270, 160, 282], lines: ['Figure 2: Other.'] })
  expect(f.capture()).toBeTruthy()
  expect(crop(f)).toBeUndefined()
})

const constructorControls: Control[] = [
  [
    'knockout',
    (f) => {
      group(f).knockout = true
    }
  ],
  [
    'nonisolated group',
    (f) => {
      group(f).isolated = false
    }
  ],
  [
    'active soft mask',
    (f) => {
      group(f).smask = { subtype: 'Alpha' }
    }
  ],
  [
    'group matrix',
    (f) => {
      group(f).matrix = [1, 0, 0, 1, 0, 0]
    }
  ],
  [
    'unsupported blend',
    (f) => {
      f.o.argsArray[f.o.fnArray.indexOf(OPS.setGState)][0][0][1] = 'multiply'
    }
  ],
  [
    'unknown pattern paint',
    (f) => {
      f.o.fnArray[f.imageIndex] = OPS.shadingFill
    }
  ],
  [
    'nonrectangular child',
    (f) => {
      const i = f.o.fnArray.indexOf(
        OPS.paintFormXObjectBegin,
        f.o.fnArray.indexOf(OPS.paintFormXObjectBegin) + 1
      )
      f.o.argsArray[i][1] = new Float32Array([0, 0, 0, 400])
    }
  ],
  [
    'unclosed child',
    (f) => {
      const i = f.o.fnArray.indexOf(OPS.paintFormXObjectEnd)
      f.o.fnArray.splice(i, 1)
      f.o.argsArray.splice(i, 1)
      f.observed.scanned--
    }
  ],
  [
    'text inside raster root',
    (f) => {
      f.o.fnArray[f.imageIndex] = OPS.showText
    }
  ],
  [
    'wrong decoded dimensions',
    (f) => {
      f.o.argsArray[f.imageIndex][1] = 101
    }
  ],
  [
    'missing decoded image',
    (f) => {
      f.images.clear()
    }
  ],
  [
    'bitmap-only image',
    (f) => {
      f.image.bitmap = {}
    }
  ],
  [
    'wrong byte count',
    (f) => {
      f.image.data = new Uint8Array(4)
    }
  ],
  [
    'unobserved stream tail',
    (f) => {
      f.observed.scanned--
    }
  ],
  [
    'native path overflow',
    (f) => {
      f.observed.overflow = true
    }
  ],
  [
    'nonfinite alpha',
    (f) => {
      const i = f.o.fnArray.findIndex(
        (op: number, index: number) =>
          op === OPS.setGState && f.o.argsArray[index][0][0][0] === 'CA'
      )
      f.o.argsArray[i][0][0][1] = NaN
    }
  ],
  [
    'unknown image mask',
    (f) => {
      f.o.fnArray[f.imageIndex] = OPS.paintImageMaskXObject
    }
  ],
  [
    'missing checksum',
    (f) => {
      delete f.context.sourceSha256
    }
  ],
  [
    'short checksum',
    (f) => {
      f.context.sourceSha256 = 'a'.repeat(63)
    }
  ],
  [
    'nonhex checksum',
    (f) => {
      f.context.sourceSha256 = 'z'.repeat(64)
    }
  ],
  [
    'missing page number',
    (f) => {
      delete f.context.pageNumber
    }
  ],
  [
    'zero page number',
    (f) => {
      f.context.pageNumber = 0
    }
  ],
  [
    'negative page number',
    (f) => {
      f.context.pageNumber = -1
    }
  ],
  [
    'fractional page number',
    (f) => {
      f.context.pageNumber = 1.5
    }
  ],
  [
    'nonfinite page number',
    (f) => {
      f.context.pageNumber = NaN
    }
  ],
  [
    'nonfinite viewport matrix',
    (f) => {
      f.context.viewport.transform[0] = NaN
    }
  ],
  [
    'wrong viewport matrix length',
    (f) => {
      f.context.viewport.transform.push(0)
    }
  ],
  [
    'nonfinite viewport width',
    (f) => {
      f.context.viewport.width = NaN
    }
  ],
  [
    'zero viewport height',
    (f) => {
      f.context.viewport.height = 0
    }
  ],
  [
    'inconsistent rendered width',
    (f) => {
      f.task._internalRenderTask.params.viewport.width++
    }
  ],
  [
    'inconsistent rendered matrix',
    (f) => {
      f.task._internalRenderTask.params.viewport.transform = [2.5, 0, 0, -1.5, 0, 600]
    }
  ]
]
it.each(constructorControls)('declines incomplete native factory evidence: %s', (_name, mutate) => {
  const f = anonymousRasterRoot()
  mutate(f)
  expect(f.capture()).toBeUndefined()
  expect(crop(f)).toBeUndefined()
})

const publicationControls: Control[] = [
  [
    'cloned opaque token',
    (f) => {
      f.context.isolatedRasterScope = structuredClone(f.context.isolatedRasterScope)
    }
  ],
  [
    'changed source checksum',
    (f) => {
      f.context.sourceSha256 = 'b'.repeat(64)
    }
  ],
  [
    'mutated live native pixels',
    (f) => {
      f.image.data[0] = 1
    }
  ],
  [
    'mutated operator stream',
    (f) => {
      group(f).bbox[0]--
    }
  ],
  [
    'cloned operator stream',
    (f) => {
      f.context.operators = structuredClone(f.o)
    }
  ],
  [
    'cloned recorded graphics',
    (f) => {
      f.context.graphicsBounds = structuredClone(f.context.graphicsBounds)
    }
  ],
  [
    'missing native source',
    (f) => {
      delete f.context.content.items[0].sourceItem
    }
  ],
  [
    'duplicate native source',
    (f) => {
      f.tokens.push({ ...f.tokens[0] })
    }
  ],
  [
    'missing native glyph ink',
    (f) => {
      f.context.glyphBounds = []
    }
  ],
  [
    'wrong page identity',
    (f) => {
      f.page.pageNumber = 2
    }
  ],
  [
    'overlapping table',
    (f) => {
      f.tables.push([80, 100, 200, 200])
    }
  ],
  [
    'ambiguous caption',
    (f) => {
      f.captions.push({ ...f.captions[0] })
    }
  ]
]
it.each(publicationControls)(
  'preserves fallback for incomplete publication evidence: %s',
  (_name, mutate) => {
    const f = anonymousRasterRoot()
    expect(f.capture()).toBeTruthy()
    expect(crop(f)).toBeTruthy()
    mutate(f)
    expect(crop(f)).toBeUndefined()
  }
)

it('retains the completed attestation after native cache release and rejects later source changes', () => {
  const f = anonymousRasterRoot()
  expect(f.capture()).toBeTruthy()
  const proof = nativeIsolatedRasterScopeData(f.page, f.context)
  f.images.clear()
  expect(nativeIsolatedRasterScopeData(f.page, f.context)).toBe(proof)
  expect(crop(f)).toBeTruthy()
  f.context.sourceSha256 = 'b'.repeat(64)
  expect(crop(f)).toBeUndefined()
})
