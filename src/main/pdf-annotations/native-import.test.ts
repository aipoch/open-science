import { describe, expect, it, vi } from 'vitest'

const getDocument = vi.fn()

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument }))

const page = (
  annotations: readonly Record<string, unknown>[],
  items = ['Imported text']
): Readonly<Record<string, unknown>> => ({
  view: [0, 0, 600, 800],
  rotate: 90,
  getAnnotations: vi.fn(async () =>
    annotations.map((annotation, i) => ({ id: `${i + 1}R`, ...annotation }))
  ),
  getTextContent: vi.fn(async () => ({
    items: items.map((str) => ({
      str,
      width: 150,
      height: 12,
      transform: [12, 0, 0, 12, 60, 720]
    }))
  }))
})

describe('parseNativePdfAnnotations', () => {
  it('normalizes native markups and sticky notes into PDF annotations', async () => {
    const pages = [
      page([
        {
          subtype: 'Highlight',
          id: '1R',
          rect: [50, 690, 240, 735],
          quadPoints: [60, 732, 220, 732, 60, 708, 220, 708],
          color: [255, 214, 41],
          contentsObj: { str: 'Review this' }
        },
        {
          subtype: 'Highlight',
          id: '2R',
          rect: [50, 690, 240, 735],
          quadPoints: [60, 732, 220, 732, 60, 708, 220, 708],
          color: [255, 214, 41],
          contentsObj: { str: 'Review this' }
        },
        {
          subtype: 'Text',
          id: '3R',
          rect: [300, 500, 320, 520],
          color: [163, 107, 240],
          contentsObj: { str: 'A useful note' }
        },
        { subtype: 'Square', rect: [10, 10, 100, 100] },
        { subtype: 'Widget', rect: [10, 10, 100, 100] },
        { subtype: 'Popup', rect: [0, 0, 1, 1] }
      ])
    ]
    const destroy = vi.fn()
    getDocument.mockReturnValueOnce({
      promise: Promise.resolve({ numPages: 1, getPage: async () => pages[0], destroy })
    })

    const { parseNativePdfAnnotations } = await import('./native-import')
    const result = await parseNativePdfAnnotations('/tmp/input.pdf', {
      execution: 'current-thread'
    })

    expect(result.annotations).toHaveLength(4)
    expect(result.annotations[0]).toMatchObject({
      kind: 'highlight',
      color: 'yellow',
      note: 'Review this'
    })
    expect(result.annotations[0]?.selector).toMatchObject({
      kind: 'text',
      pageNumber: 1,
      pageRotation: 90
    })
    expect(result.annotations[1]).toMatchObject({
      kind: 'highlight',
      color: 'yellow',
      note: 'Review this'
    })
    expect(result.annotations[2]).toMatchObject({
      kind: 'area',
      color: 'purple',
      note: 'A useful note'
    })
    expect(result.annotations[3]).toMatchObject({ kind: 'area', subtype: 'Square' })
    expect(result.unsupportedCount).toBe(0)
    expect(result.truncated).toBe(false)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('falls back to an area mark when a markup has no selectable text', async () => {
    const pages = [
      page(
        [
          {
            subtype: 'Underline',
            rect: [50, 690, 240, 735],
            quadPoints: [60, 732, 220, 732, 60, 708, 220, 708],
            color: [64, 140, 255]
          }
        ],
        []
      )
    ]
    getDocument.mockReturnValueOnce({
      promise: Promise.resolve({ numPages: 1, getPage: async () => pages[0], destroy: vi.fn() })
    })

    const { parseNativePdfAnnotations } = await import('./native-import')
    const result = await parseNativePdfAnnotations('/tmp/input.pdf', {
      execution: 'current-thread'
    })

    expect(result.annotations[0]).toMatchObject({ kind: 'area', color: 'blue' })
    expect(result.annotations[0]?.selector.kind).toBe('region')
  })
})

it('reports unsupported annotations and frees page caches without extracting text for notes', async () => {
  const nativePage = {
    ...page([{ subtype: 'Sound' }, { subtype: 'Text', rect: [0, 0, 10, 10] }]),
    cleanup: vi.fn()
  }
  getDocument.mockReturnValueOnce({
    promise: Promise.resolve({ numPages: 1, getPage: async () => nativePage, destroy: vi.fn() })
  })
  const { parseNativePdfAnnotations } = await import('./native-import')
  const progress = vi.fn()
  const result = await parseNativePdfAnnotations('/tmp/input.pdf', {
    onProgress: progress,
    execution: 'current-thread'
  })
  expect(result.unsupportedCount).toBe(1)
  expect(progress).toHaveBeenLastCalledWith({
    pagesProcessed: 1,
    pageCount: 1,
    annotationsFound: 1,
    unsupportedCount: 1
  })
  expect((nativePage as Record<string, unknown>).getTextContent).not.toHaveBeenCalled()
  expect(nativePage.cleanup).toHaveBeenCalledOnce()
})

it.each([0, 1])(
  'rejects a worker that exits with code %i before returning a result',
  async (code) => {
    const { EventEmitter } = await import('node:events')
    const { parseNativePdfAnnotations } = await import('./native-import')
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(code) })
    const parsing = parseNativePdfAnnotations('/tmp/input.pdf', {
      createWorker: () => worker as unknown as import('node:worker_threads').Worker
    })
    await vi.waitFor(() => expect(worker.listenerCount('exit')).toBe(1))
    worker.emit('exit', code)
    await expect(parsing).rejects.toThrow('before returning a result')
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.listenerCount('message')).toBe(0)
  }
)

it('joins a cancelled worker before releasing the parsing promise', async () => {
  const { EventEmitter } = await import('node:events')
  const { parseNativePdfAnnotations } = await import('./native-import')
  let finishTermination!: (code: number) => void
  const worker = Object.assign(new EventEmitter(), {
    terminate: vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishTermination = resolve
        })
    )
  })
  const controller = new AbortController()
  const progress = vi.fn()
  const settled = vi.fn()
  const parsing = parseNativePdfAnnotations('/tmp/input.pdf', {
    signal: controller.signal,
    onProgress: progress,
    createWorker: () => worker as unknown as import('node:worker_threads').Worker
  })
  const outcome = parsing.catch((error) => {
    settled()
    return error
  })
  await vi.waitFor(() => expect(worker.listenerCount('exit')).toBe(1))
  controller.abort(new Error('Cancelled'))
  worker.emit('message', { kind: 'progress', progress: { pagesProcessed: 1 } })
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  expect(progress).not.toHaveBeenCalled()
  finishTermination(1)
  expect(await outcome).toMatchObject({ message: 'Cancelled' })
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('serializes workers across callers and cancels queued work without starting it', async () => {
  const { EventEmitter } = await import('node:events')
  const { parseNativePdfAnnotations } = await import('./native-import')
  const makeWorker = (): InstanceType<typeof EventEmitter> & {
    terminate: ReturnType<typeof vi.fn>
  } => Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(0) })
  const first = makeWorker(),
    last = makeWorker()
  const createFirst = vi.fn(() => first as unknown as import('node:worker_threads').Worker)
  const createCancelled = vi.fn()
  const createLast = vi.fn(() => last as unknown as import('node:worker_threads').Worker)
  const one = parseNativePdfAnnotations('/first.pdf', { createWorker: createFirst })
  const controller = new AbortController()
  const cancelled = parseNativePdfAnnotations('/cancelled.pdf', {
    signal: controller.signal,
    createWorker: createCancelled
  }).catch((e) => e)
  const three = parseNativePdfAnnotations('/last.pdf', { createWorker: createLast })
  await vi.waitFor(() => expect(createFirst).toHaveBeenCalledOnce())
  controller.abort(new Error('cancel queued'))
  expect(await cancelled).toMatchObject({ message: 'cancel queued' })
  expect(createCancelled).not.toHaveBeenCalled()
  expect(createLast).not.toHaveBeenCalled()
  const result = { pageCount: 1, annotations: [], unsupportedCount: 0, truncated: false }
  first.emit('message', { kind: 'result', result })
  await one
  await vi.waitFor(() => expect(createLast).toHaveBeenCalledOnce())
  last.emit('message', { kind: 'result', result })
  await expect(three).resolves.toEqual(result)
})
