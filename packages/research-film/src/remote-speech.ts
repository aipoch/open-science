import { createHash } from 'node:crypto'
import type { SpeechSynthesizer } from './narration.js'

/**
 * Wire shape of the remote speech endpoint.
 *
 * - `audio-speech`: OpenAI-compatible synthesis endpoint receiving
 *   `{ model, input, voice, response_format }` and returning raw WAV bytes.
 * - `chat-completions`: OpenAI-compatible chat endpoint carrying the spoken text in an
 *   `assistant` message with `audio: { format, voice }`, returning JSON whose
 *   `choices[0].message.audio.data` holds base64 WAV (the Xiaomi MiMo TTS shape).
 */
export type RemoteSpeechStyle = 'audio-speech' | 'chat-completions'

export type RemoteSpeechConfig = {
  kind: 'remote-http'
  style: RemoteSpeechStyle
  /** Full request URL. Credentials must travel in headers, never in the URL. */
  endpoint: string
  model: string
  /**
   * Passed through verbatim: a provider voice ID, or a base64 reference sample for
   * providers that clone from a recording. Never embedded in the synthesizer identity.
   */
  voice?: string
  apiKey?: string
  /** Per-request timeout; defaults to 60 seconds. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_WAV_BYTES = 64 * 1024 * 1024

/**
 * Stable cache and checkpoint identity for a remote backend. Excludes the API key and
 * hashes the voice so a base64 reference sample never reaches `timings.json` or the
 * narration cache key.
 */
export const remoteSpeechIdentity = (config: RemoteSpeechConfig): string => {
  const url = new URL(config.endpoint)
  const voice = config.voice
    ? createHash('sha256').update(config.voice).digest('hex').slice(0, 12)
    : 'default'
  return `remote-http/${config.style}/${url.host}${url.pathname}/${config.model}/${voice}`
}

const readTag = (view: DataView, offset: number): string =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  )

/** Decode a RIFF/WAVE payload (PCM 16/24/32-bit or IEEE float32, any channel count) to mono. */
export const decodeWav = (bytes: Uint8Array): { samples: Float32Array; sampleRate: number } => {
  if (bytes.byteLength > MAX_WAV_BYTES) throw new Error('Remote speech audio is too large')
  if (bytes.byteLength < 12)
    throw new Error('Remote speech response is not a WAV file: missing RIFF header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE')
    throw new Error('Remote speech response is not a WAV file')
  let offset = 12
  let format = 0,
    channels = 0,
    sampleRate = 0,
    bits = 0,
    dataOffset = -1,
    dataLength = 0
  while (offset + 8 <= bytes.byteLength) {
    const tag = readTag(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > bytes.byteLength) throw new Error('Remote speech WAV chunk is truncated')
    if (tag === 'fmt ') {
      if (size < 16) throw new Error('Remote speech WAV format chunk is invalid')
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (tag === 'data') {
      dataOffset = body
      dataLength = size
      break
    }
    offset = body + size + (size & 1)
  }
  if (dataOffset < 0) throw new Error('Remote speech WAV is missing its data chunk')
  if (channels < 1 || sampleRate < 1) throw new Error('Remote speech WAV format is invalid')
  const bytesPerSample = bits / 8
  const frameBytes = channels * bytesPerSample
  if (
    !Number.isInteger(bytesPerSample) ||
    bytesPerSample < 1 ||
    (format !== 1 && format !== 3) ||
    (format === 1 && bits !== 16 && bits !== 24 && bits !== 32) ||
    (format === 3 && bits !== 32)
  )
    throw new Error(
      `Remote speech WAV encoding (format ${format}, ${bits}-bit) is not supported; request wav output`
    )
  const frames = Math.floor(dataLength / frameBytes)
  if (frames < 1) throw new Error('Remote speech WAV contains no audio frames')
  const sample = (index: number): number => {
    const at = dataOffset + index * bytesPerSample
    if (format === 3) return view.getFloat32(at, true)
    if (bits === 16) return view.getInt16(at, true) / 32768
    if (bits === 32) return view.getInt32(at, true) / 2147483648
    const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
    return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608
  }
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) sum += sample(frame * channels + channel)
    samples[frame] = sum / channels
  }
  return { samples, sampleRate }
}

const buildRequest = (
  config: RemoteSpeechConfig,
  text: string
): { url: string; init: RequestInit } => {
  const body =
    config.style === 'audio-speech'
      ? {
          model: config.model,
          input: text,
          ...(config.voice ? { voice: config.voice } : {}),
          response_format: 'wav'
        }
      : {
          model: config.model,
          messages: [{ role: 'assistant', content: text }],
          audio: { format: 'wav', ...(config.voice ? { voice: config.voice } : {}) }
        }
  return {
    url: config.endpoint,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    }
  }
}

/**
 * `SpeechSynthesizer` over an HTTP TTS endpoint. Word boundaries use a character-proportional
 * estimate calibrated from the most recent full synthesis, so alignment never issues extra
 * billed requests; exact timing remains the local engine's advantage.
 */
export const createRemoteSpeechSynthesizer = (config: RemoteSpeechConfig): SpeechSynthesizer => {
  // Validate eagerly so a malformed endpoint fails before any narration work starts.
  new URL(config.endpoint)
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  )
    throw new Error('Remote speech timeout must be a positive number of milliseconds')
  const identity = remoteSpeechIdentity(config)
  let reference: { text: string; duration: number } | undefined

  const request = async (text: string): Promise<{ samples: Float32Array; sampleRate: number }> => {
    const { url, init } = buildRequest(config, text)
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      const name = (error as Error).name
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new Error('Remote speech request timed out')
      throw new Error(`Remote speech request failed: ${(error as Error).message}`)
    }
    if (!response.ok) throw new Error(`Remote speech request failed with HTTP ${response.status}`)
    if (config.style === 'chat-completions') {
      const payload = (await response.json().catch(() => undefined)) as
        { choices?: { message?: { audio?: { data?: unknown } } }[] } | undefined
      const data = payload?.choices?.[0]?.message?.audio?.data
      if (typeof data !== 'string' || data.length < 1)
        throw new Error('Remote speech response is missing synthesized audio')
      return decodeWav(Buffer.from(data, 'base64'))
    }
    return decodeWav(new Uint8Array(await response.arrayBuffer()))
  }

  return {
    identity,
    async synthesize(text) {
      const audio = await request(text)
      reference = { text, duration: audio.samples.length / audio.sampleRate }
      return audio
    },
    async measureDuration(text) {
      if (!reference) {
        // The narration pipeline always synthesizes a line before probing its boundaries;
        // this fallback only keeps the contract honest if that ordering ever changes.
        const audio = await request(text)
        return audio.samples.length / audio.sampleRate
      }
      const estimate = reference.duration * (text.length / Math.max(1, reference.text.length))
      if (!Number.isFinite(estimate) || estimate <= 0 || estimate > 300)
        throw new Error('Remote speech duration estimate is out of range')
      return estimate
    }
  }
}
