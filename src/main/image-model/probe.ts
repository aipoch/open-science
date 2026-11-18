import { fetchProviderRequest, readBoundedResponseText } from '@aipoch/providers/transport'
import { tunnelThroughProxy } from '@aipoch/notebook-network-sandbox'
import type { ImageModelTestResult } from '../../shared/image-model-settings'
import { validateImageModelOptions } from '../../shared/image-model-presets'
import type { ResolvedImageModel } from './contract'
import { netFetchWithManualRedirect } from '../network-fetch'
import { runtimeNetwork } from '../runtime-network'
import { parseSystemProxyRules } from '../settings/system-proxy'
import { encodeImageRequest, readImageResult } from './adapter'
import { ImageModelError, MAX_IMAGE_RESPONSE_BYTES } from './contract'
import { downloadImageResult } from './download'
import { readImageHttpError, readImageProviderError } from './provider-error'
import { readImageRaster } from './raster'

// A Settings probe is transient: it publishes neither an artifact nor a conversation usage record.
// Always test the actual generation contract; an HTTP ping cannot establish model access.
export async function testImageModel(
  target: ResolvedImageModel,
  dependencies: {
    fetch?: typeof fetch
    download?: typeof downloadImageResult
    timeoutMs?: number
  } = {}
): Promise<ImageModelTestResult> {
  const signal = AbortSignal.timeout(dependencies.timeoutMs ?? 120_000)
  let submitted = false
  try {
    const preset = target.model.presetId
    const options = validateImageModelOptions(preset, 'generate', {
      ...(preset === 'openai-images/generic' ? {} : { size: '1024x1024' }),
      ...(preset === 'openai/gpt-image-2.6' ? { quality: 'low', complexity: 'low' } : {})
    })
    if (!options.ok) return { ok: false, error: { code: 'UNSUPPORTED_OPTION' } }
    const request = encodeImageRequest(
      target,
      'generate',
      'A simple blue circle on a white background.',
      options.options
    )
    submitted = true
    const response = await fetchProviderRequest(
      dependencies.fetch ?? netFetchWithManualRedirect,
      request.url,
      {
        ...request.init,
        signal
      }
    )
    if (!response.ok) throw await readImageHttpError(response, target.adapter, signal)
    const value: unknown = JSON.parse(
      await readBoundedResponseText(
        response,
        MAX_IMAGE_RESPONSE_BYTES,
        'Image test response',
        undefined,
        signal
      )
    )
    const failure = readImageProviderError(value, target.adapter, response.status, response.headers)
    if (failure) throw failure
    const image = readImageResult(value)
    const bytes =
      'bytes' in image
        ? image.bytes
        : await (dependencies.download ?? downloadImageResult)(image.url, signal, {
            providerUrl: request.url,
            resolveProxy: async (url) => {
              const proxy = parseSystemProxyRules(await runtimeNetwork().resolveProxy(url))
              return proxy.HTTPS_PROXY ?? proxy.ALL_PROXY
            },
            tunnel: (proxy, address, port, signal) =>
              tunnelThroughProxy(proxy, address, port, undefined, signal)
          })
    await readImageRaster(bytes, false)
    return { ok: true }
  } catch (error) {
    // No upstream prose, secrets or image bytes cross the Settings response boundary.
    return {
      ok: false,
      error:
        error instanceof ImageModelError
          ? error.detail
          : { code: submitted ? 'OUTCOME_UNKNOWN' : 'INVALID_REQUEST' }
    }
  }
}
