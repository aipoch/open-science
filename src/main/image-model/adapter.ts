import { z } from 'zod'
import type { AcpTurnTokenUsage } from '../../shared/acp-usage-contract'
import type { ImageOperation, ImageOptionValue } from '../../shared/image-model-presets'
import type { ImageAdapterKind } from '../../shared/image-model-settings'
import type { ResolvedImageModel } from '../settings/image-model-owner'
import { ImageModelError, MAX_IMAGE_BYTES, type ImageRaster } from './contract'

const imageDataUrl = (image: ImageRaster): string =>
  `data:${image.mime};base64,${image.bytes.toString('base64')}`

export function encodeImageRequest(
  target: ResolvedImageModel,
  operation: ImageOperation,
  prompt: string,
  options: Record<string, ImageOptionValue>,
  source?: ImageRaster,
  guide?: ImageRaster
): { url: string; init: RequestInit; parameters: Record<string, ImageOptionValue> } {
  const generationEndpoint =
    operation === 'generate' || target.adapter === 'qwen-images' || target.adapter === 'seedream'
  const url = `${target.baseUrl.replace(/\/+$/, '')}/images/${generationEndpoint ? 'generations' : 'edits'}`
  const parameters: Record<string, ImageOptionValue> = {
    ...options,
    ...(target.adapter === 'seedream' ? {} : { n: 1 }),
    ...(target.adapter === 'qwen-images' || target.model.presetId === 'openai/gpt-image-2.6'
      ? {}
      : { response_format: 'b64_json' })
  }
  const headers: Record<string, string> = target.apiKey
    ? { Authorization: `Bearer ${target.apiKey}` }
    : {}
  if (operation === 'edit' && target.model.presetId === 'minimax-h3/sglang') {
    const body = new FormData()
    body.set('model', target.model.wireModelId)
    body.set('prompt', prompt)
    for (const [key, value] of Object.entries(parameters)) body.set(key, String(value))
    body.set(
      'image',
      new Blob([new Uint8Array(source!.bytes)], { type: 'image/png' }),
      'source.png'
    )
    return { url, init: { method: 'POST', headers, body }, parameters }
  }
  const body = JSON.stringify({
    model: target.model.wireModelId,
    prompt,
    ...parameters,
    ...(source
      ? target.adapter === 'qwen-images' || target.adapter === 'seedream'
        ? { image: imageDataUrl(source) }
        : {
            images: (guide ? [source, guide] : [source]).map((image) => ({
              image_url: imageDataUrl(image)
            }))
          }
      : {})
  })
  if (target.adapter === 'minimax' && Buffer.byteLength(body) > MAX_IMAGE_BYTES)
    throw new ImageModelError('UNSUPPORTED_OPTION', 'The encoded image request exceeds 64 MiB.')
  return {
    url,
    init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body },
    parameters
  }
}

const count = z.number().int().nonnegative().safe()
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  input_tokens_details: z.object({ cached_tokens: count.optional() }).optional()
})
export function readImageUsage(
  value: unknown,
  adapter?: ImageAdapterKind
): {
  usage?: AcpTurnTokenUsage
  generatedImages?: number
} {
  const envelope = z.object({ usage: z.unknown().optional() }).safeParse(value)
  if (!envelope.success) return {}
  let raw = envelope.data.usage
  if (adapter === 'seedream') {
    const seedream = z.object({ output_tokens: count, total_tokens: count }).safeParse(raw)
    if (seedream.success && seedream.data.output_tokens === seedream.data.total_tokens)
      raw = { ...seedream.data, input_tokens: 0, ...(raw && typeof raw === 'object' ? raw : {}) }
  }
  const generatedImages =
    z.object({ generated_images: count }).safeParse(raw).data?.generated_images ??
    (adapter === 'qwen-images'
      ? z.object({ output_image_count: count }).safeParse(raw).data?.output_image_count
      : undefined)
  const parsed = usageSchema.safeParse(raw)
  if (!parsed.success) return { generatedImages }
  const cacheTokens = parsed.data.input_tokens_details?.cached_tokens ?? 0
  if (
    cacheTokens > parsed.data.input_tokens ||
    !Number.isSafeInteger(parsed.data.input_tokens + parsed.data.output_tokens)
  )
    return { generatedImages }
  return {
    generatedImages,
    usage: {
      inputTokens: parsed.data.input_tokens - cacheTokens,
      cacheTokens,
      outputTokens: parsed.data.output_tokens,
      turnCount: 1
    }
  }
}

const responseSchema = z.object({
  data: z
    .array(
      z.object({
        b64_json: z.string().optional(),
        url: z.string().max(8192).optional(),
        error: z.unknown().optional()
      })
    )
    .length(1)
})
export function readImageResult(value: unknown): { bytes: Buffer } | { url: string } {
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid image response.')
  const image = parsed.data.data[0]
  if (image.error !== undefined)
    throw new ImageModelError('PROVIDER_ERROR', 'The image provider reported generation failure.')
  if (image.b64_json !== undefined && image.url === undefined) {
    const data = image.b64_json
    const tail = data.slice(-4)
    // Canonical base64 has zero unused bits in its last sextet.
    const invalidPadding = tail.endsWith('==')
      ? !'AQgw'.includes(tail.charAt(1))
      : tail.endsWith('=') && !'AEIMQUYcgkosw048'.includes(tail.charAt(2))
    if (
      !data.length ||
      data.length % 4 !== 0 ||
      data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      invalidPadding ||
      !/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/u.test(data)
    )
      throw new Error('Invalid image encoding.')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image byte limit exceeded.')
    return { bytes }
  }
  if (image.url && image.b64_json === undefined) return { url: image.url }
  throw new Error('Missing or ambiguous image result.')
}
