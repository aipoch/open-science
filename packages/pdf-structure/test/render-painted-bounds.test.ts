import { createRequire } from 'node:module'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { expect, it } from 'vitest'

const { getDocument, OPS } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)
const { collectGraphicsBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { recordPaintedOperationBounds, recordNativeFigurePaths, captureNativeFigureRenderContext } =
  await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href)

function pdfBytes(content: string, grouped = false): Uint8Array {
  const form = grouped
    ? '1 1 1 rg -500 -500 1000 1000 re f 0 0 1 rg 70 90 20 20 re f 1 0 0 rg 300 300 10 10 re f'
    : '0 0 20 20 re 0 0 1 rg f'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R /Fm 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n00ff00>\nendstream',
    `<< /Type /XObject /Subtype /Form /BBox [${grouped ? '50 70 150 170' : '0 0 20 20'}] ${grouped ? '/Group << /S /Transparency /I false /K false >>' : ''} /Resources << >> /Length ${form.length} >>\nstream\n${form}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}

async function render(
  content: string,
  paintedOnly: boolean,
  grouped = false
): Promise<{
  geometry: { graphicsBounds: { normalizedRect: number[] }[]; invalidGraphicsBounds: number }
  pixels: Buffer
  rawPaths: number
  snapshotPaths: number
}> {
  const task = getDocument({
    data: pdfBytes(content, grouped),
    verbosity: 0,
    isEvalSupported: false
  })
  const canvas = createCanvas(300, 300)
  try {
    const page = await (await task.promise).getPage(1)
    const rendering = page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
    if (paintedOnly) recordPaintedOperationBounds(rendering)
    else recordNativeFigurePaths(rendering)
    await rendering.promise
    const geometry = collectGraphicsBounds(rendering, page.recordedBBoxes)
    const snapshot = captureNativeFigureRenderContext(
      rendering,
      1,
      await page.getTextContent(),
      page.getViewport({ scale: 1 }),
      geometry.graphicsBounds,
      '7'.repeat(64),
      page.commonObjs
    )
    return {
      geometry,
      rawPaths: rendering._internalRenderTask.operatorList.fnArray.filter(
        (op: number) => op === OPS.constructPath
      ).length,
      snapshotPaths:
        snapshot?.operators.fnArray.filter((op: number) => op === OPS.constructPath).length ?? -1,
      pixels: Buffer.from(canvas.getContext('2d').getImageData(0, 0, 300, 300).data)
    }
  } finally {
    canvas.width = canvas.height = 1
    await task.destroy()
  }
}

it.each([
  [
    'cumulative transforms',
    Array.from({ length: 100 }, () => '1 0 0 1 0.25 0.25 cm 0 0 10 10 re S').join('\n')
  ],
  [
    'nested clips and restores',
    'q 5 5 180 180 re W n q 1 0 0 1 10 20 cm 0 0 40 40 re W n 0 0 100 100 re f Q 60 60 40 40 re S Q 190 190 5 5 re f'
  ],
  ['reused form paths', 'q 1 0 0 1 10 20 cm /Fm Do Q q 2 0 0 2 60 70 cm /Fm Do Q'],
  [
    'optimized image groups',
    Array.from({ length: 5 }, (_, index) => `q 20 0 0 20 ${20 + index * 30} 100 cm /Im Do Q`).join(
      '\n'
    ) + '\nq 30 100 40 20 re W n 160 0 0 20 20 100 cm /Im Do Q'
  ]
])('preserves actual painted geometry and pixels with %s', async (_name, content) => {
  const baseline = await render(content, false)
  const optimized = await render(content, true)
  expect(baseline.geometry.graphicsBounds.length).toBeGreaterThan(0)
  expect(optimized.geometry).toEqual(baseline.geometry)
  expect(optimized.pixels.equals(baseline.pixels)).toBe(true)
})

it('rejects an unavailable operation tracker instead of silently losing bounds', () => {
  expect(() => recordPaintedOperationBounds({})).toThrow()
})

it('retains the complete renderer group clip when an opaque white background extends beyond it', async () => {
  const result = await render('/Fm Do', true, true)
  const rectangles = result.geometry.graphicsBounds.map(
    (g: { normalizedRect: number[] }) => g.normalizedRect
  )
  expect(rectangles.length).toBeGreaterThan(0)
  expect(
    rectangles.every((r) => r[0] >= 0.25 && r[1] >= 0.15 && r[2] <= 0.75 && r[3] <= 0.65)
  ).toBe(true)
  const plain = await render('/Fm Do', false, true)
  expect(result.pixels.equals(plain.pixels)).toBe(true)
  expect(result.rawPaths).toBeGreaterThan(result.geometry.graphicsBounds.length)
  expect(result.snapshotPaths).toBe(result.rawPaths)
})

type GroupPaintTestFixture = {
  group: { bbox: number[]; isolated: boolean; knockout: boolean; matrix: null; smask: null }
  operators: { fnArray: number[]; argsArray: unknown[][] }
  task: {
    _internalRenderTask: {
      operatorList: { fnArray: number[]; argsArray: unknown[][] }
      params: {
        viewport: {
          width: number
          height: number
          scale: number
          rotation: number
          transform: number[]
        }
      }
    }
    onContinue: ((resume: () => void) => void) | undefined
  }
  boxes: {
    isEmpty: () => boolean
    minX: () => number
    minY: () => number
    maxX: () => number
    maxY: () => number
  }
  observe: () => void
}

function groupBoundsFixture(): GroupPaintTestFixture {
  const group = {
    bbox: [50, 70, 150, 170],
    isolated: false,
    knockout: false,
    matrix: null,
    smask: null
  }
  const operators = {
    fnArray: [OPS.beginGroup, OPS.constructPath, OPS.endGroup],
    argsArray: [[group], [OPS.fill, [null], null], [group]]
  }
  const task = {
    _internalRenderTask: {
      operatorList: operators,
      params: {
        viewport: {
          width: 200,
          height: 200,
          scale: 1,
          rotation: 0,
          transform: [1, 0, 0, -1, 0, 200]
        }
      }
    },
    onContinue: undefined as ((resume: () => void) => void) | undefined
  }
  const boxes = { isEmpty: () => false, minX: () => 0, minY: () => 0, maxX: () => 1, maxY: () => 1 }
  const observe = (): void => {
    recordNativeFigurePaths(task)
    task.onContinue?.(() => {})
  }
  return { group, operators, task, boxes, observe }
}

it.each([false, true])(
  'intersects known isolated=%s group paint bounds without changing original paint',
  (isolated) => {
    const x = groupBoundsFixture()
    x.group.isolated = isolated
    x.observe()
    const before = JSON.stringify(x.operators)
    expect(collectGraphicsBounds(x.task, x.boxes).graphicsBounds[0].normalizedRect).toEqual([
      0.25, 0.15, 0.75, 0.65
    ])
    expect(JSON.stringify(x.operators)).toBe(before)
  }
)

it.each([
  'mask',
  'knockout',
  'matrix',
  'unknown',
  'hidden',
  'unbalanced',
  'accessor',
  'proxy',
  'late-identity'
])('retains old coarse geometry when the complete group %s contract is unavailable', (kind) => {
  const x = groupBoundsFixture()
  let reads = 0
  if (kind === 'mask') x.group.smask = {} as never
  if (kind === 'knockout') x.group.knockout = true
  if (kind === 'matrix') x.group.matrix = [1, 0, 0, 1, 2, 3] as never
  if (kind === 'unknown') Object.assign(x.group, { extra: 1 })
  if (kind === 'hidden') Object.defineProperty(x.group, 'extra', { value: 1 })
  if (kind === 'unbalanced') x.operators.fnArray.pop()
  if (kind === 'accessor')
    Object.defineProperty(x.group, 'bbox', {
      get() {
        reads++
        return [50, 70, 150, 170]
      },
      enumerable: true
    })
  if (kind === 'proxy')
    x.operators.argsArray[0][0] = new Proxy(x.group, {
      get(t, k) {
        reads++
        return Reflect.get(t, k)
      }
    }) as never
  if (kind === 'late-identity')
    x.boxes.maxY = () => {
      x.group.bbox = [...x.group.bbox]
      return 1
    }
  x.observe()
  expect(collectGraphicsBounds(x.task, x.boxes).graphicsBounds[0].normalizedRect).toEqual([
    0, 0, 1, 1
  ])
  expect(reads).toBe(0)
})

it.each(['bbox', 'matrix', 'opcode', 'slot'])(
  'withdraws a group envelope after late %s mutation',
  (kind) => {
    const x = groupBoundsFixture()
    x.observe()
    if (kind === 'bbox') x.group.bbox = [...x.group.bbox]
    if (kind === 'matrix') x.group.matrix = [1, 0, 0, 1, 0, 0] as never
    if (kind === 'opcode') x.operators.fnArray[2] = OPS.restore
    if (kind === 'slot') x.operators.argsArray[0] = [x.group]
    expect(collectGraphicsBounds(x.task, x.boxes).graphicsBounds[0].normalizedRect).toEqual([
      0, 0, 1, 1
    ])
  }
)

it('retains the original raw-path byte refusal even when the group clips that paint', () => {
  const x = groupBoundsFixture()
  x.operators.argsArray[1] = [OPS.fill, [new Float32Array(4_194_305)], null] as never
  x.observe()
  const geometry = collectGraphicsBounds(x.task, x.boxes)
  expect(geometry.graphicsBounds[0].normalizedRect).toEqual([0.25, 0.15, 0.75, 0.65])
  expect(
    captureNativeFigureRenderContext(
      x.task,
      1,
      { items: [], styles: {} },
      x.task._internalRenderTask.params.viewport,
      geometry.graphicsBounds,
      '7'.repeat(64),
      {}
    )
  ).toBeUndefined()
})

it.each(['dangling-begin', 'unmatched-end'])(
  'declines group metadata with %s text state',
  (kind) => {
    const x = groupBoundsFixture()
    x.operators.fnArray.push(kind === 'dangling-begin' ? OPS.beginText : OPS.endText)
    x.operators.argsArray.push(null as never)
    x.observe()
    expect(collectGraphicsBounds(x.task, x.boxes).graphicsBounds[0].normalizedRect).toEqual([
      0, 0, 1, 1
    ])
  }
)

it('does not resurrect a previously filtered duplicate mask after group clipping', () => {
  const x = groupBoundsFixture()
  x.operators.fnArray = [
    OPS.paintImageXObject,
    OPS.beginGroup,
    OPS.paintImageMaskXObject,
    OPS.endGroup
  ]
  x.operators.argsArray = [['image', 1, 1], [x.group], [{}], [x.group]] as never
  x.observe()
  const result = collectGraphicsBounds(x.task, x.boxes)
  expect(result.graphicsBounds).toHaveLength(1)
  expect(result.graphicsBounds[0].normalizedRect).toEqual([0, 0, 1, 1])
})
