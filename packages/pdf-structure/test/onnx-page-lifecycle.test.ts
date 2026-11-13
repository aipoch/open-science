import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const source = await readFile(
  new URL('../resources/literature-pdf-onnx.mjs', import.meta.url),
  'utf8'
)
const declaration = source.slice(
  source.indexOf('async function preparePage('),
  source.indexOf('\ntry {\n  await mkdir(outputDirectory')
)
type Prepared = {
  png: Uint8Array
  width: number
  height: number
  rotation: number
  rules: number[][]
  textItems: { text: string; x: number; baseline: number; width: number; height: number }[]
  canvas?: { width: number; height: number }
}
function fixture(
  options: {
    single?: boolean
    debug?: boolean
    failure?: string
    destroy?: Promise<void>
    mutateSource?: boolean
  } = {}
): {
  run: () => Promise<Prepared>
  events: string[]
  canvas: { width: number; height: number }
  destroy: ReturnType<typeof vi.fn>
} {
  const events: string[] = []
  const point = (name: string): void => {
    events.push(name)
    if (options.failure === name) throw Error(name)
  }
  const canvas = {
    width: 900,
    height: 1200,
    getContext: (): object => ({}),
    encode: async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3])
  }
  const rules = [[10, 20, 40, 50]]
  const content = {
    items: [{ str: 'value', transform: [1, 0, 0, 1, 10, 20], width: 30, height: 8 }]
  }
  const page = {
    getTextContent: async (): Promise<typeof content> => content,
    getViewport: (): object => ({
      width: 900,
      height: 1200,
      convertToViewportPoint: (x: number, y: number): number[] => [x, y]
    }),
    render: (): object => ({ promise: Promise.resolve().then(() => point('render')) }),
    getOperatorList: async (): Promise<object> => {
      point('operators')
      return {}
    },
    cleanup: (): void => point('page cleanup')
  }
  const document = {
    numPages: 2,
    getPage: async (): Promise<typeof page> => page,
    cleanup: async (): Promise<void> => point('document cleanup')
  }
  const destroy = vi.fn(async (): Promise<void> => {
    point('destroy')
    await options.destroy
    if (options.mutateSource) {
      content.items[0].str = 'released source'
      content.items[0].transform[4] = 999
      rules[0][0] = 999
    }
  })
  const run = runInNewContext(`${declaration}\n() => preparePage(document, 1)`, {
    document,
    assert,
    mode: options.debug ? 'diagnostic' : 'production',
    pages: options.single === false ? [1, 2] : [1],
    createCanvas: (): typeof canvas => canvas,
    repairPdfSymbolText: async (_page: unknown, value: unknown): Promise<unknown> => value,
    readingRotation: (): number => 0,
    infer: async (): Promise<object> => {
      point('detection')
      return { objects: [] }
    },
    sessions: { afterDetection: async (): Promise<void> => point('release detection') },
    phase: (): void => undefined,
    deduplicateTableDetections: (objects: unknown): unknown => objects,
    isUprightText: (): boolean => true,
    collectTableRules: (): number[][] => rules,
    findCaptionedNumericTableRegions: (): number[][] => [[10, 20, 40, 50]],
    destroyPdf: destroy
  }) as () => Promise<Prepared>
  return { run, events, canvas, destroy }
}

it('closes single-page PDF and raster owners before detached inputs permit detection work', async () => {
  let finish!: () => void
  const f = fixture({
    destroy: new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  const done = vi.fn()
  const pending = f.run().then((value) => {
    done()
    return value
  })
  await vi.waitFor(() => expect(f.destroy).toHaveBeenCalledOnce())
  expect(done).not.toHaveBeenCalled()
  expect(f.events).not.toContain('detection')
  expect(f.canvas).toMatchObject({ width: 1, height: 1 })
  finish()
  const value = await pending
  expect(f.events).toEqual(['render', 'operators', 'page cleanup', 'document cleanup', 'destroy'])
  expect(value).toMatchObject({
    width: 900,
    height: 1200,
    rotation: 0,
    textItems: [{ text: 'value', x: 10, baseline: 20, width: 45, height: 12 }],
    rules: [[10, 20, 40, 50]]
  })
  expect(f.events).not.toContain('detection')
  expect(Object.keys(value).sort()).toEqual([
    'height',
    'png',
    'rotation',
    'rules',
    'textItems',
    'width'
  ])
})

it.each(['render', 'operators', 'page cleanup', 'document cleanup', 'destroy'])(
  'keeps cleanup fail-closed before structure after %s fails',
  async (failure) => {
    const f = fixture({ failure, debug: true })
    await expect(f.run()).rejects.toThrow(failure)
    expect(f.destroy).toHaveBeenCalledOnce()
    expect(f.canvas).toMatchObject({ width: 1, height: 1 })
  }
)

it('releases a multi-page raster without destroying the document needed by the next page', async () => {
  const f = fixture({ single: false })
  await f.run()
  expect(f.destroy).not.toHaveBeenCalled()
  expect(f.events).toContain('document cleanup')
  expect(f.canvas).toMatchObject({ width: 1, height: 1 })
})

it('transfers only a completed diagnostic canvas to the existing annotation owner', async () => {
  const f = fixture({ debug: true })
  const value = await f.run()
  expect(value.canvas).toBe(f.canvas)
  expect(f.canvas.width).toBe(900)
  expect(f.destroy).toHaveBeenCalledOnce()
})

it('keeps only detached text and rule coordinates after the PDF owner releases its storage', async () => {
  const f = fixture({ mutateSource: true })
  const value = await f.run()
  expect(value.textItems).toEqual([
    { text: 'value', x: 10, baseline: 20, width: 45, height: 12, horizontal: true }
  ])
  expect(value.rules).toEqual([[10, 20, 40, 50]])
  expect(f.events).not.toContain('detection')
})
