import { beforeEach, describe, expect, it, vi } from 'vitest'

const pipeline = vi.hoisted(() => ({
  metadata: vi.fn(),
  autoOrient: vi.fn(),
  resize: vi.fn(),
  png: vi.fn(),
  timeout: vi.fn(),
  toBuffer: vi.fn(),
  destroy: vi.fn()
}))
vi.mock('sharp', () => ({ default: vi.fn(() => pipeline) }))

describe('bounded image preview conversion', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    for (const method of ['autoOrient', 'resize', 'png', 'timeout'] as const) {
      pipeline[method].mockReturnValue(pipeline)
    }
    pipeline.metadata.mockResolvedValue({ autoOrient: { width: 8000, height: 4000 } })
    pipeline.toBuffer.mockResolvedValue({
      data: Buffer.from('preview'),
      info: { width: 5656, height: 2828 }
    })
  })

  it('bounds the decode input, processing time and oriented output geometry', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    const { default: sharp } = await import('sharp')
    const source = Buffer.from('source')
    const preview = await resizeImagePreview(source.length, async () => source)
    expect(sharp).toHaveBeenCalledWith(source, {
      failOn: 'warning',
      limitInputPixels: 64_000_000,
      sequentialRead: true
    })
    expect(pipeline.timeout).toHaveBeenCalledWith({ seconds: 30 })
    expect(pipeline.resize).toHaveBeenCalledWith(5656, 2828, {
      fit: 'inside',
      withoutEnlargement: true
    })
    expect(pipeline.autoOrient).toHaveBeenCalledOnce()
    expect(preview.width * preview.height).toBeLessThanOrEqual(16_000_000)
    expect(pipeline.destroy).toHaveBeenCalledOnce()
    preview.release()
  })

  it('serializes source reads and continues after a failed conversion', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    let reject!: (error: Error) => void
    const first = resizeImagePreview(
      1,
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const secondRead = vi.fn(async () => Buffer.from('b'))
    const second = resizeImagePreview(1, secondRead)
    await Promise.resolve()
    expect(secondRead).not.toHaveBeenCalled()
    const failure = expect(first).rejects.toThrow('source changed')
    reject(new Error('source changed'))
    await failure
    const preview = await second
    expect(secondRead).toHaveBeenCalledOnce()
    preview.release()
  })

  it('bounds pending work without reading rejected inputs', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    let finish!: (value: Buffer) => void
    const first = resizeImagePreview(
      1,
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const waiting = Array.from({ length: 8 }, () =>
      resizeImagePreview(1, async () => Buffer.from('a'))
    )
    const rejectedRead = vi.fn()
    await expect(resizeImagePreview(1, rejectedRead)).rejects.toThrow(/capacity is busy/)
    expect(rejectedRead).not.toHaveBeenCalled()
    finish(Buffer.from('a'))
    for (const preview of await Promise.all([first, ...waiting])) preview.release()
  })

  it('keeps buffer reservations until release and releases them exactly once', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    pipeline.toBuffer.mockResolvedValue({
      data: Buffer.alloc(64 * 1024 * 1024),
      info: { width: 4000, height: 4000 }
    })
    const read = vi.fn(async () => Buffer.from('a'))
    const first = await resizeImagePreview(1, read)
    const second = await resizeImagePreview(1, read)
    await expect(resizeImagePreview(1, read)).rejects.toThrow(/capacity is busy/)
    expect(read).toHaveBeenCalledTimes(2)
    first.release()
    first.release()
    const third = await resizeImagePreview(1, read)
    await expect(resizeImagePreview(1, read)).rejects.toThrow(/capacity is busy/)
    second.release()
    third.release()
  })

  it('rejects animated input without silently extracting its first frame', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    pipeline.metadata.mockResolvedValue({ pages: 2, autoOrient: { width: 8000, height: 4000 } })
    await expect(resizeImagePreview(1, async () => Buffer.from('a'))).rejects.toThrow(/Animated/)
    expect(pipeline.toBuffer).not.toHaveBeenCalled()
    expect(pipeline.destroy).toHaveBeenCalledOnce()
  })

  it('rejects APNG before the decoder can discard animation metadata', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    const source = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from([0, 0, 0, 8]),
      Buffer.from('acTL'),
      Buffer.alloc(12)
    ])
    await expect(resizeImagePreview(source.length, async () => source)).rejects.toThrow(/Animated/)
    expect(pipeline.metadata).not.toHaveBeenCalled()
  })

  it('rejects oversized encoded sources before reading them', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    const read = vi.fn()
    await expect(resizeImagePreview(50 * 1024 * 1024 + 1, read)).rejects.toThrow(/50 MiB/)
    expect(read).not.toHaveBeenCalled()
  })

  it('fails closed if output geometry exceeds the browser budget', async () => {
    const { resizeImagePreview } = await import('./image-preview-resize')
    pipeline.toBuffer.mockResolvedValue({
      data: Buffer.from('preview'),
      info: { width: 4001, height: 4000 }
    })
    await expect(resizeImagePreview(1, async () => Buffer.from('a'))).rejects.toThrow(
      /output exceeds/
    )
  })
})
