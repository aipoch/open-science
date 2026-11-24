import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { IMAGE_MODEL_PRESET_ADAPTERS } from '../../shared/image-model-settings'
import type { ImageModelPresetId } from '../../shared/image-model-settings'
import type { ResolvedImageModel } from './contract'
import { testImageModel } from './probe'

const target: ResolvedImageModel = {
  serviceId: 'test',
  adapter: 'openai-images',
  baseUrl: 'https://images.example/v1',
  apiKey: 'secret',
  model: { id: 'image', wireModelId: 'image', presetId: 'openai-images/generic' }
}
const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
  .png()
  .toBuffer()

it.each(Object.keys(IMAGE_MODEL_PRESET_ADAPTERS) as ImageModelPresetId[])(
  'tests the %s generation contract with one decoded image and returns no content',
  async (presetId) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: [{ b64_json: image.toString('base64') }] })
    )
    expect(
      await testImageModel(
        {
          ...target,
          adapter: IMAGE_MODEL_PRESET_ADAPTERS[presetId],
          model: { ...target.model, presetId }
        },
        { fetch }
      )
    ).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://images.example/v1/images/generations')
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('image')
    if (presetId !== 'seedream/5.5') expect(body.n).toBe(1)
    if (presetId === 'openai-images/generic') expect(body).not.toHaveProperty('size')
    else expect(body.size).toBe('1024x1024')
  }
)

it('downloads URL results with the existing destination protections before accepting them', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ data: [{ url: 'https://cdn.example/image' }] })
  )
  const download = vi.fn(async () => image)
  expect(await testImageModel(target, { fetch, download })).toEqual({ ok: true })
  expect(download).toHaveBeenCalledWith(
    'https://cdn.example/image',
    expect.any(AbortSignal),
    expect.objectContaining({ providerUrl: 'https://images.example/v1/images/generations' })
  )
})

it('reports provider failures without reflecting provider prose or retrying', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ error: { code: 'invalid_api_key', message: 'secret' } }, { status: 401 })
  )
  expect(await testImageModel(target, { fetch })).toEqual({
    ok: false,
    error: { code: 'AUTHENTICATION_FAILED', httpStatus: 401, providerCode: 'invalid_api_key' }
  })
  expect(fetch).toHaveBeenCalledOnce()
})

it.each(['invalid-image', 'network', 'timeout'])(
  'reports an unconfirmed result after %s without retrying',
  async (failure) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (failure === 'network') throw new Error('secret transport detail')
      if (failure === 'timeout')
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      return Response.json({ data: [{ b64_json: Buffer.from('not a raster').toString('base64') }] })
    })
    expect(await testImageModel(target, { fetch, timeoutMs: 20 })).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' }
    })
    expect(fetch).toHaveBeenCalledOnce()
  }
)
