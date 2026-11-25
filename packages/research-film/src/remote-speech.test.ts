import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRemoteSpeechSynthesizer,
  decodeWav,
  remoteSpeechIdentity,
  type RemoteSpeechConfig
} from './remote-speech.js'

const wav = (samples: number[], sampleRate = 24000, channels = 1, bits = 16): Buffer => {
  const bytesPerSample = bits / 8
  const data = Buffer.alloc(samples.length * bytesPerSample)
  samples.forEach((value, index) => {
    if (bits === 16) data.writeInt16LE(Math.round(value * 32767), index * 2)
    else if (bits === 32) data.writeFloatLE(value, index * 4)
    else data.writeIntLE(Math.round(value * 8388607), index * 3, 3)
  })
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(bits === 32 ? 3 : 1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  header.writeUInt16LE(channels * bytesPerSample, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

describe('decodeWav', () => {
  it('decodes 16-bit mono PCM', () => {
    const { samples, sampleRate } = decodeWav(new Uint8Array(wav([0, 0.5, -0.5, 1])))
    expect(sampleRate).toBe(24000)
    expect(samples).toHaveLength(4)
    expect(samples[1]).toBeCloseTo(0.5, 2)
    expect(samples[2]).toBeCloseTo(-0.5, 2)
  })

  it('downmixes interleaved stereo to mono', () => {
    const { samples } = decodeWav(new Uint8Array(wav([1, -1, 0.5, -0.5], 16000, 2)))
    expect(samples).toHaveLength(2)
    expect(samples[0]).toBeCloseTo(0, 2)
    expect(samples[1]).toBeCloseTo(0, 2)
  })

  it('decodes 32-bit IEEE float PCM', () => {
    const bytes = wav([0.25, -0.75], 24000, 1, 32)
    const { samples } = decodeWav(new Uint8Array(bytes))
    expect(samples[0]).toBeCloseTo(0.25, 6)
    expect(samples[1]).toBeCloseTo(-0.75, 6)
  })

  it('decodes 24-bit PCM', () => {
    const { samples } = decodeWav(new Uint8Array(wav([0.5, -0.25], 24000, 1, 24)))
    expect(samples[0]).toBeCloseTo(0.5, 5)
    expect(samples[1]).toBeCloseTo(-0.25, 5)
  })

  it('rejects payloads that are not RIFF/WAVE', () => {
    expect(() => decodeWav(new Uint8Array(Buffer.from('<html>error</html>')))).toThrow(
      /not a WAV file/
    )
  })

  it('rejects a WAV without a data chunk', () => {
    const bytes = wav([1]).subarray(0, 44)
    bytes.write('junk', 36)
    bytes.writeUInt32LE(0, 40)
    expect(() => decodeWav(new Uint8Array(bytes))).toThrow(/missing its data chunk/)
  })

  it('rejects truncated chunk payloads', () => {
    const bytes = wav([1, 1, 1, 1])
    bytes.writeUInt32LE(bytes.length, 40)
    expect(() => decodeWav(new Uint8Array(bytes))).toThrow(/truncated/)
  })

  it('rejects unsupported encodings with an actionable message', () => {
    const bytes = wav([1, 1], 24000, 1, 16)
    bytes.writeUInt16LE(6, 20) // A-law
    expect(() => decodeWav(new Uint8Array(bytes))).toThrow(/not supported; request wav output/)
  })
})

describe('remoteSpeechIdentity', () => {
  const base: RemoteSpeechConfig = {
    kind: 'remote-http',
    style: 'chat-completions',
    endpoint: 'https://api.example.com/v1/chat/completions',
    model: 'tts-1',
    apiKey: 'secret-key'
  }

  it('never embeds the API key', () => {
    expect(remoteSpeechIdentity(base)).not.toContain('secret-key')
  })

  it('hashes a voice sample instead of embedding it', () => {
    const withVoice = remoteSpeechIdentity({ ...base, voice: 'data:audio/wav;base64,AAAA' })
    expect(withVoice).not.toContain('AAAA')
    expect(withVoice).toContain('chat-completions')
  })

  it('distinguishes scheme, query, model, endpoint and voice changes', () => {
    const identity = remoteSpeechIdentity(base)
    expect(remoteSpeechIdentity({ ...base, model: 'tts-2' })).not.toBe(identity)
    expect(remoteSpeechIdentity({ ...base, endpoint: 'https://other.example.com/v1' })).not.toBe(
      identity
    )
    expect(
      remoteSpeechIdentity({ ...base, endpoint: 'http://api.example.com/v1/chat/completions' })
    ).not.toBe(identity)
    expect(remoteSpeechIdentity({ ...base, endpoint: `${base.endpoint}?region=us` })).not.toBe(
      identity
    )
    expect(remoteSpeechIdentity({ ...base, voice: 'alloy' })).not.toBe(identity)
    expect(remoteSpeechIdentity({ ...base, apiKey: 'other' })).toBe(identity)
  })

  it('never collides slash-bearing endpoint and model combinations', () => {
    // Concatenation-ambiguous pairs: the structured-tuple hash must separate them.
    const a = remoteSpeechIdentity({
      ...base,
      style: 'audio-speech',
      endpoint: 'https://api.example.com/v1/audio/speech',
      model: 'tts-1'
    })
    const b = remoteSpeechIdentity({
      ...base,
      style: 'audio-speech',
      endpoint: 'https://api.example.com/v1/audio',
      model: 'speech/tts-1'
    })
    expect(a).not.toBe(b)
    const c = remoteSpeechIdentity({ ...base, endpoint: `${base.endpoint}/extra`, model: '' })
    const d = remoteSpeechIdentity({ ...base, endpoint: base.endpoint, model: '/extra' })
    expect(c).not.toBe(d)
  })
})

let server: Server | undefined
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)))
  server = undefined
})

const listen = async (
  handler: Parameters<typeof createServer>[0]
): Promise<{
  url: string
  requests: { url?: string; body?: string; authorization?: string }[]
}> => {
  const requests: { url?: string; body?: string; authorization?: string }[] = []
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        url: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization
      })
      handler(request, response)
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Failed to bind mock server')
  return { url: `http://127.0.0.1:${address.port}/v1/audio/speech`, requests }
}

describe('createRemoteSpeechSynthesizer', () => {
  it('posts an audio-speech request and returns decoded WAV audio', async () => {
    const payload = wav([0, 0.4, -0.4])
    const { url, requests } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/wav' })
      response.end(payload)
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'audio-speech',
      endpoint: url,
      model: 'tts-1',
      voice: 'alloy',
      apiKey: 'test-key'
    })
    const audio = await synthesizer.synthesize('Hello world')
    expect(audio.sampleRate).toBe(24000)
    expect(audio.samples).toHaveLength(3)
    expect(requests).toHaveLength(1)
    expect(requests[0].authorization).toBe('Bearer test-key')
    const body = JSON.parse(requests[0].body!)
    expect(body).toMatchObject({ model: 'tts-1', input: 'Hello world', voice: 'alloy' })
    expect(body.response_format).toBe('wav')
  })

  it('posts a chat-completions request and decodes base64 audio', async () => {
    const payload = wav([0.1, -0.1, 0.2])
    const { url, requests } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ choices: [{ message: { audio: { data: payload.toString('base64') } } }] })
      )
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'chat-completions',
      endpoint: url,
      model: 'mimo-v2.5-tts',
      voice: '冰糖'
    })
    const audio = await synthesizer.synthesize('研究影片旁白')
    expect(audio.samples).toHaveLength(3)
    expect(requests[0].authorization).toBeUndefined()
    const body = JSON.parse(requests[0].body!)
    expect(body.model).toBe('mimo-v2.5-tts')
    expect(body.messages).toEqual([{ role: 'assistant', content: '研究影片旁白' }])
    expect(body.audio).toEqual({ format: 'wav', voice: '冰糖' })
  })

  it('estimates probe durations as a pure function of the probe text', async () => {
    const payload = wav(new Array(48000).fill(0)) // two seconds at 24 kHz
    const { url, requests } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/wav' })
      response.end(payload)
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'audio-speech',
      endpoint: url,
      model: 'tts-1'
    })
    const audio = await synthesizer.synthesize('abcdefghij')
    expect(audio.samples).toHaveLength(48000)
    // Deterministic regardless of prior synthesis, so the shared probe cache stays coherent.
    const first = await synthesizer.measureDuration?.('abcde')
    const second = await synthesizer.measureDuration?.('completely different probe text')
    expect(first).toBeCloseTo(5 / 15, 6)
    expect(second).toBeCloseTo('completely different probe text'.length / 15, 6)
    expect(requests).toHaveLength(1)
    expect(await synthesizer.measureDuration?.('abcde')).toBe(first)
  })

  it('answers duration probes without any HTTP request', async () => {
    const { url, requests } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/wav' })
      response.end(wav([0]))
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'audio-speech',
      endpoint: url,
      model: 'tts-1'
    })
    expect(await synthesizer.measureDuration?.('cold probe')).toBeCloseTo(
      'cold probe'.length / 15,
      6
    )
    expect(requests).toHaveLength(0)
  })

  it('cancels an in-flight request when the generation signal aborts', async () => {
    const { url } = await listen((_request, _response) => {
      /* never respond: only the abort can end this request */
    })
    const controller = new AbortController()
    const synthesizer = createRemoteSpeechSynthesizer(
      { kind: 'remote-http', style: 'audio-speech', endpoint: url, model: 'tts-1' },
      { signal: controller.signal }
    )
    const pending = synthesizer.synthesize('Hello')
    // Give fetch time to reach the server before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort(new Error('generation cancelled'))
    await expect(pending).rejects.toThrow(/cancelled by generation shutdown/)
  })

  it('maps an expired timeout to a timeout error, not a cancellation', async () => {
    const { url } = await listen((_request, _response) => {
      /* never respond */
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'audio-speech',
      endpoint: url,
      model: 'tts-1',
      timeoutMs: 50
    })
    await expect(synthesizer.synthesize('Hello')).rejects.toThrow(/timed out/)
  })

  it('rejects an oversized response before buffering it', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(64 * 1024 * 1024 + 1)
      })
      response.end()
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'audio-speech',
      endpoint: url,
      model: 'tts-1'
    })
    await expect(synthesizer.synthesize('Hello')).rejects.toThrow(/too large/)
  })

  it('cancels the response body on every early rejection', async () => {
    // Wrap a Response so its stream's cancel() becomes observable from the test.
    const observe = (response: Response): { response: Response; cancelled: () => boolean } => {
      let cancelled = false
      const original = response.body
      const reader = original?.getReader()
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!reader) {
            controller.close()
            return
          }
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        },
        cancel() {
          cancelled = true
        }
      })
      return {
        response: new Response(stream, { status: response.status, headers: response.headers }),
        cancelled: () => cancelled
      }
    }
    const endpoint = 'https://api.example.com/v1/audio/speech'

    // Oversized declared Content-Length: rejected before reading, body released.
    const oversized = observe(
      new Response(new Uint8Array(wav([0])), {
        headers: { 'content-length': String(64 * 1024 * 1024 + 1) }
      })
    )
    const oversizeSynth = createRemoteSpeechSynthesizer(
      { kind: 'remote-http', style: 'audio-speech', endpoint, model: 'tts-1' },
      { fetch: async () => oversized.response }
    )
    await expect(oversizeSynth.synthesize('Hello')).rejects.toThrow(/too large/)
    expect(oversized.cancelled()).toBe(true)

    // Non-OK response: rejected before reading, body released.
    const denied = observe(new Response('forbidden', { status: 403 }))
    const deniedSynth = createRemoteSpeechSynthesizer(
      { kind: 'remote-http', style: 'audio-speech', endpoint, model: 'tts-1' },
      { fetch: async () => denied.response }
    )
    await expect(deniedSynth.synthesize('Hello')).rejects.toThrow(/HTTP 403/)
    expect(denied.cancelled()).toBe(true)
  })

  it('rejects a streamed response that grows past the byte cap', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/wav' })
      // No content-length: force chunked streaming past the cap.
      const chunk = Buffer.alloc(1024 * 1024)
      const timer = setInterval(() => response.write(chunk), 1)
      response.on('close', () => clearInterval(timer))
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'audio-speech',
      endpoint: url,
      model: 'tts-1',
      timeoutMs: 15_000
    })
    await expect(synthesizer.synthesize('Hello')).rejects.toThrow(/too large/)
  })

  it('reports HTTP failures without echoing credentials', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorized')
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'audio-speech',
      endpoint: url,
      model: 'tts-1',
      apiKey: 'do-not-leak'
    })
    await expect(synthesizer.synthesize('Hello')).rejects.toThrow(/HTTP 401/)
    await expect(synthesizer.synthesize('Hello')).rejects.not.toThrow(/do-not-leak/)
  })

  it('reports a chat response that carries no audio', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'no audio' } }] }))
    })
    const synthesizer = createRemoteSpeechSynthesizer({
      kind: 'remote-http',
      style: 'chat-completions',
      endpoint: url,
      model: 'mimo-v2.5-tts'
    })
    await expect(synthesizer.synthesize('Hello')).rejects.toThrow(/missing synthesized audio/)
  })

  it('rejects malformed configuration eagerly', () => {
    expect(() =>
      createRemoteSpeechSynthesizer({
        kind: 'remote-http',
        style: 'audio-speech',
        endpoint: 'not a url',
        model: 'tts-1'
      })
    ).toThrow()
    expect(() =>
      createRemoteSpeechSynthesizer({
        kind: 'remote-http',
        style: 'audio-speech',
        endpoint: 'https://example.com/speech',
        model: 'tts-1',
        timeoutMs: 0
      })
    ).toThrow(/positive number/)
  })
})
