import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousNativeMeshFigure } = await import(
  pathToFileURL(resolve('test/fixtures/mesh-pixel-figure.mjs')).href
)
const crop = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-mesh-scope.mjs')).href
)
const packets = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const observer = await import(
  pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href
)
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)

it('recovers a complete anonymous native mesh Form and excludes adjacent prose from actual PNG', async () => {
  const f = await anonymousNativeMeshFigure()
  try {
    const a = f.args,
      plan = crop.nativeMesh4PixelCrop(...a)
    expect(plan).toBeDefined()
    expect(plan.rect[2]).toBeLessThan(150)
    expect(plan.sourceItems).toBeUndefined()
    expect(packets.createNativeFigurePaintCertificate(a[0], a[4], a[5])).toBeUndefined()
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(crop.nativeMesh4PixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
    expect(crop.nativeMesh4PixelPngSafe({ ...plan }, png, plan.rect, a[0])).toBeUndefined()
    const forged = { ...a[5] }
    expect(observer.nativeMesh4RenderContextData(forged)).toBeUndefined()
    expect(crop.nativeMesh4PixelCrop(...a.slice(0, 5), forged, ...a.slice(6))).toBeUndefined()
    observer.bindNativeMesh4RenderContext(forged, a[5])
    expect(observer.nativeMesh4RenderContextData(forged)).toBeDefined()
    const withSymbol = { ...a[5], [Symbol('extra')]: true }
    observer.bindNativeMesh4RenderContext(withSymbol, a[5])
    expect(observer.nativeMesh4RenderContextData(withSymbol)).toBeUndefined()
    forged.sourceSha256 = 'b'.repeat(64)
    expect(observer.nativeMesh4RenderContextData(forged)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('declines when an external native prose fragment enters the owned mesh envelope', async () => {
  const f = await anonymousNativeMeshFigure(true)
  try {
    expect(crop.nativeMesh4PixelCrop(...f.args)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('withdraws live resource authority across actual native document cleanup', async () => {
  const f = await anonymousNativeMeshFigure()
  let disposed = false
  try {
    const a = f.args,
      plan = crop.nativeMesh4PixelCrop(...a),
      png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(crop.nativeMesh4PixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
    await f.cleanup()
    disposed = true
    expect(observer.nativeMesh4RenderContextData(a[5])).toBeUndefined()
    expect(crop.nativeMesh4PixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  } finally {
    if (!disposed) await f.cleanup()
  }
})

it('seals the complete native witness before normal document cleanup without granting Source', async () => {
  const f = await anonymousNativeMeshFigure()
  let disposed = false
  try {
    const a = f.args,
      plan = crop.nativeMesh4PixelCrop(...a),
      png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(observer.sealNativeMesh4RenderContext?.(f.snapshot, f.render)).toBe(true)
    expect(observer.sealNativeMesh4RenderContext(f.snapshot, f.render)).toBe(false)
    await f.cleanup()
    disposed = true
    expect(observer.nativeMesh4RenderContextData(a[5])).toBeDefined()
    expect(crop.nativeMesh4PixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
    expect(
      packets.nativeWholeCellInkPacket(a[0], a[4], a[5], {
        text: a[4].map((t: { text: string }) => t.text).join(''),
        sourceItems: a[4].map((t: { sourceItem: unknown }) => t.sourceItem),
        sourceRects: a[4].map((t: { rect: number[] }) => t.rect)
      })
    ).toBeUndefined()
  } finally {
    if (!disposed) await f.cleanup()
  }
})

it.each([
  'snapshot',
  'render',
  'unfinished',
  'store-method',
  'resource-replacement',
  'resource-bytes',
  'raw-stream'
])('refuses a forged or changed live witness before seal: %s', async (mode) => {
  const f = await anonymousNativeMeshFigure()
  try {
    let snapshot = f.snapshot,
      render = f.render
    const data = observer.nativeMesh4RenderContextData(f.args[5]),
      task = f.render._internalRenderTask
    if (mode === 'snapshot') snapshot = { ...snapshot }
    if (mode === 'render') render = { ...render }
    if (mode === 'unfinished') task.running = true
    if (mode === 'store-method')
      Object.defineProperty(f.nativePage.objs, 'get', {
        value: () => data.resources[0].ir,
        configurable: true
      })
    if (mode === 'resource-replacement')
      f.nativePage.objs.resolve(data.resources[0].id, structuredClone(data.resources[0].ir))
    if (mode === 'resource-bytes') data.resources[0].ir[2][0] += 1
    if (mode === 'raw-stream') task.operatorList.argsArray[0] = []
    expect(observer.sealNativeMesh4RenderContext(snapshot, render)).toBe(false)
  } finally {
    await f.cleanup()
  }
})

it.each(['resource-bytes', 'resource-descriptor', 'snapshot-stream', 'raw-stream', 'caption'])(
  'withdraws retained %s evidence after sealed normal cleanup',
  async (mode) => {
    const f = await anonymousNativeMeshFigure()
    let disposed = false
    try {
      const a = f.args,
        plan = crop.nativeMesh4PixelCrop(...a),
        png = await renderPdfCrop(f.nativePage, plan.rect),
        data = observer.nativeMesh4RenderContextData(a[5]),
        ir = data.resources[0].ir,
        raw = f.render._internalRenderTask.operatorList
      expect(observer.sealNativeMesh4RenderContext(f.snapshot, f.render)).toBe(true)
      await f.cleanup()
      disposed = true
      expect(crop.nativeMesh4PixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
      if (mode === 'resource-bytes') ir[2][0] += 1
      if (mode === 'resource-descriptor') Object.defineProperty(ir, '0', { writable: false })
      if (mode === 'snapshot-stream') a[5].operators.argsArray[0] = []
      if (mode === 'raw-stream') raw.argsArray[0] = []
      if (mode === 'caption') a[1].caption.lines[0] = 'Figure 2: Foreign caption.'
      expect(crop.nativeMesh4PixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
    } finally {
      if (!disposed) await f.cleanup()
    }
  }
)

it.each(['caption', 'table', 'resource', 'state', 'plan'])(
  'withdraws %s mutations at the original caller seam',
  async (mode) => {
    const f = await anonymousNativeMeshFigure()
    try {
      const a = f.args,
        plan = crop.nativeMesh4PixelCrop(...a)
      expect(plan).toBeDefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      if (mode === 'caption') a[1].caption.lines[0] = 'Figure 2: Other.'
      if (mode === 'table') a[3].push([...plan.rect])
      if (mode === 'resource')
        observer.nativeMesh4RenderContextData(a[5]).resources[0].ir[2][0] += 1
      if (mode === 'state') a[5].operators.argsArray[0] = []
      if (mode === 'plan') plan.rect[2] += 1
      expect(crop.nativeMesh4PixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)
