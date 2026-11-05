import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { encodeVideoWav, prepareVideoNarration } from './narration.js'

describe('research video narration', () => {
  it('speaks original skill say text while aligning expanded numbers and units to caption words', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-video-say-'))
    try {
      const synthesize = vi.fn(async (text: string) => ({
        samples: new Float32Array(text.split(' ').length * 2400),
        sampleRate: 24000
      }))
      const say = 'At three hundred kelvin heat is one thousand watts.'
      const result = await prepareVideoNarration({
        spec: {
          scenes: [
            { id: 's', msg: 0, lines: [{ caption: 'At 300 K heat is 1000 W.', say }], panels: [] }
          ]
        },
        synthesizer: { identity: 'fixture', synthesize },
        outputDirectory: join(root, 'voice'),
        signal: new AbortController().signal
      })
      expect(synthesize).toHaveBeenCalledWith(say)
      const words = result.voices.s_0.words
      expect(words).toHaveLength(7)
      expect(words[1][0]).toBeCloseTo(0.1)
      expect(words[1][1]).toBeCloseTo(0.3)
      expect(words[2][0]).toBeCloseTo(0.3)
      expect(words[2][1]).toBeCloseTo(0.4)
      expect(words[5][0]).toBeCloseTo(0.6)
      expect(words[5][1]).toBeCloseTo(0.8)
      expect(words[6][1]).toBeCloseTo(0.9)
      expect(JSON.parse(await readFile(join(root, 'voice/timings.json'), 'utf8')).say.s_0).toBe(say)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('writes bounded PCM and rejects nonfinite samples', () => {
    const wav = encodeVideoWav(new Float32Array([-2, 0, 2]), 24000)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readInt16LE(44)).toBe(-32767)
    expect(wav.readInt16LE(48)).toBe(32767)
    expect(() => encodeVideoWav(new Float32Array([NaN]), 24000)).toThrow('Nonfinite')
  })
  it('measures lines, aligns captions and mixes stereo at resolved timeline positions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-video-voice-'))
    try {
      const onProgress = vi.fn()
      const result = await prepareVideoNarration({
        onProgress,
        spec: { scenes: [{ id: 's', msg: 0, lines: [{ caption: 'one two' }], panels: [] }] },
        synthesizer: {
          identity: 'fixture',
          async synthesize(text) {
            return {
              samples: new Float32Array(text.split(' ').length * 2400).fill(0.5),
              sampleRate: 24000
            }
          }
        },
        outputDirectory: join(root, 'voice'),
        signal: new AbortController().signal
      })
      expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
        ...[0, 1, 2, 3].map((completed) => ({
          phase: 'voice',
          completed,
          total: 3,
          completedLines: 0,
          totalLines: 1
        })),
        { phase: 'voice', completed: 3, total: 3, completedLines: 1, totalLines: 1 },
        { phase: 'mixing' }
      ])
      expect(result.voices.s_0.duration).toBe(0.2)
      expect(result.voices.s_0.words[0][1]).toBeCloseTo(0.1)
      expect(result.mix.readUInt32LE(24)).toBe(48000)
      expect(result.mix.readUInt16LE(22)).toBe(2)
      expect(result.mix.readInt16LE(44)).toBe(0)
      expect(result.mix.readInt16LE(44 + Math.round(0.3 * 48000) * 4)).toBeGreaterThan(0)
      expect(JSON.parse(await readFile(join(root, 'voice/timings.json'), 'utf8')).engine).toBe(
        'fixture'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('runs two lanes concurrently with fixed monotonic progress and the same ordered audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-narration-'))
  try {
    let active = 0,
      peak = 0
    const synthesizer = {
      identity: 'fixture',
      async synthesize(text: string) {
        peak = Math.max(peak, ++active)
        await new Promise((resolve) => setTimeout(resolve, text.startsWith('slow') ? 8 : 1))
        active--
        return {
          samples: new Float32Array(text.split(' ').length * 240).fill(0.5),
          sampleRate: 24000
        }
      }
    }
    const spec = {
      scenes: [
        {
          id: 's',
          msg: 0,
          lines: [{ caption: 'slow first line' }, { caption: 'fast second' }],
          panels: []
        }
      ]
    }
    const progress = vi.fn()
    const parallel = await prepareVideoNarration({
      spec,
      synthesizer,
      additionalSynthesizer: synthesizer,
      outputDirectory: join(root, 'parallel'),
      signal: new AbortController().signal,
      onProgress: progress
    })
    expect(peak).toBe(2)
    const serial = await prepareVideoNarration({
      spec,
      synthesizer,
      outputDirectory: join(root, 'serial'),
      signal: new AbortController().signal
    })
    expect(parallel.mix).toEqual(serial.mix)
    expect(parallel.voices).toEqual(serial.voices)
    const counts = progress.mock.calls.map(([p]) => p).filter((p) => p.phase === 'voice')
    expect(counts.every((p) => p.total === 8 && p.totalLines === 2)).toBe(true)
    expect(counts.map((p) => p.completed)).toEqual(
      [...counts.map((p) => p.completed)].sort((a, b) => a - b)
    )
    expect(counts.at(-1)).toMatchObject({ completed: 8, completedLines: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('drains the other lane before removing a failed narration directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-failure-'))
  try {
    let finish: () => void = () => {}
    let secondStarted = false
    const second = new Promise<void>((resolve) => {
      finish = resolve
    })
    const outputDirectory = join(root, 'voice')
    const result = prepareVideoNarration({
      spec: {
        scenes: [{ id: 's', msg: 0, lines: [{ caption: 'fail' }, { caption: 'wait' }], panels: [] }]
      },
      synthesizer: {
        identity: 'fixture',
        async synthesize() {
          await Promise.resolve()
          throw new Error('speech failed')
        }
      },
      additionalSynthesizer: {
        identity: 'fixture',
        async synthesize() {
          secondStarted = true
          await second
          return { samples: new Float32Array(240), sampleRate: 24000 }
        }
      },
      outputDirectory,
      signal: new AbortController().signal
    })
    let settled = false
    const rejection = expect(
      result.finally(() => {
        settled = true
      })
    ).rejects.toThrow('speech failed')
    await vi.waitFor(() => expect(secondStarted).toBe(true))
    expect(settled).toBe(false)
    finish()
    await rejection
    await expect(readFile(join(outputDirectory, 's_1.wav'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([true, false])(
  'splits long speech without changing line cues or losing words (punctuation: %s)',
  async (punctuation) => {
    const root = await mkdtemp(join(tmpdir(), 'chunked-narration-'))
    try {
      const sentence =
        'The satellite transfers its waste heat through large radiators into space' +
        (punctuation ? '.' : '')
      const caption = Array(7).fill(sentence).join(' ')
      const synthesize = vi.fn(async (text: string) => ({
        samples: new Float32Array(text.split(' ').length * 240).fill(0.5),
        sampleRate: 24000
      }))
      const progress = vi.fn()
      const spec = {
        scenes: [
          {
            id: 's',
            msg: 0,
            lines: [{ caption }, { caption: 'A limitation remains.' }],
            panels: [{ type: 'quote', text: 'Limits', at: '1' }]
          }
        ]
      }
      const result = await prepareVideoNarration({
        spec,
        synthesizer: { identity: 'fixture', synthesize },
        outputDirectory: join(root, 'voice'),
        signal: new AbortController().signal,
        onProgress: progress
      })
      expect(caption.length).toBeGreaterThan(400)
      expect(synthesize.mock.calls.every(([text]) => text.length <= 220)).toBe(true)
      if (punctuation) expect(synthesize.mock.calls[0][0]).toBe(Array(2).fill(sentence).join(' '))
      else expect(synthesize.mock.calls[0][0].length).toBeGreaterThan(210)
      const words = caption.split(' ')
      expect(result.voices.s_0.duration).toBeCloseTo(words.length * 0.01)
      expect(result.voices.s_0.words).toHaveLength(words.length)
      result.voices.s_0.words.forEach(([a, b], i) => {
        expect(a).toBeCloseTo(i * 0.01)
        expect(b).toBeCloseTo((i + 1) * 0.01)
      })
      const { buildVideoTimeline } = await import('./timeline.js')
      const scene = buildVideoTimeline(spec, result.voices).scenes[0]
      expect(scene.panels[0].t_in).toBe(scene.lines[1].t0)
      expect(scene.lines[0].words.map(([word]) => word).join(' ')).toBe(caption)
      const states = progress.mock.calls.map(([p]) => p).filter((p) => p.phase === 'voice')
      expect(new Set(states.map((p) => p.total)).size).toBe(1)
      expect(states.at(-1).completed).toBe(states[0].total)
      expect(states.at(-1).completedLines).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('shares chunks of one long line across lanes and restores source order and identical audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balanced-narration-'))
  try {
    const first = Array(18).fill('satellite').join(' ') + '.'
    const last = Array(16).fill('radiator').join(' ') + '.'
    const spec = {
      scenes: [
        {
          id: 's',
          msg: 0,
          lines: [{ caption: 'End.' }, { caption: `${first} ${last}` }],
          panels: []
        }
      ]
    }
    const audio = (text: string): { samples: Float32Array; sampleRate: number } => ({
      samples: new Float32Array(text.split(' ').length * 24).fill(
        text.includes('satellite') ? 0.2 : 0.5
      ),
      sampleRate: 24000
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const starts: string[] = []
    const synthesizer = {
      identity: 'fixture',
      async synthesize(text: string) {
        starts.push(text)
        if (starts.length <= 2) await gate
        return audio(text)
      }
    }
    const progress = vi.fn()
    const pending = prepareVideoNarration({
      spec,
      synthesizer,
      additionalSynthesizer: synthesizer,
      outputDirectory: join(root, 'parallel'),
      signal: new AbortController().signal,
      onProgress: progress
    })
    await vi.waitFor(() => expect(starts).toHaveLength(2))
    expect(starts).toEqual([first, last])
    release()
    const parallel = await pending
    const serial = await prepareVideoNarration({
      spec,
      synthesizer: { identity: 'fixture', synthesize: async (text) => audio(text) },
      outputDirectory: join(root, 'serial'),
      signal: new AbortController().signal
    })
    expect(parallel).toEqual(serial)
    for (const name of ['s_0.wav', 's_1.wav', 'word-times.json', 'timings.json'])
      expect(await readFile(join(root, 'parallel', name))).toEqual(
        await readFile(join(root, 'serial', name))
      )
    const counts = progress.mock.calls.map(([p]) => p).filter((p) => p.phase === 'voice')
    expect(counts.at(-1)).toMatchObject({
      completed: 67,
      total: 67,
      completedLines: 2,
      totalLines: 2
    })
    expect(
      counts.every(
        (p, i) =>
          !i ||
          (p.completed >= counts[i - 1].completed &&
            p.completedLines >= counts[i - 1].completedLines)
      )
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['sample-rate', 'duration'] as const)(
  'rejects incompatible chunks before publishing audio: %s',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'chunk-validation-'))
    try {
      const first = Array(18).fill('satellite').join(' ') + '.'
      const last = Array(16).fill('radiator').join(' ') + '.'
      const make = (
        rate: number
      ): {
        identity: string
        synthesize: () => Promise<{ samples: Float32Array; sampleRate: number }>
      } => ({
        identity: 'fixture',
        synthesize: async () => ({ samples: new Float32Array(200), sampleRate: rate })
      })
      const outputDirectory = join(root, 'voice')
      await expect(
        prepareVideoNarration({
          spec: {
            scenes: [{ id: 's', msg: 0, lines: [{ caption: `${first} ${last}` }], panels: [] }]
          },
          synthesizer: make(failure === 'duration' ? 1 : 24000),
          additionalSynthesizer: make(failure === 'duration' ? 1 : 48000),
          outputDirectory,
          signal: new AbortController().signal
        })
      ).rejects.toThrow(failure === 'duration' ? 'five minutes' : 'sample rate')
      await expect(readFile(join(outputDirectory, 's_0.wav'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('coalesces identical in-flight duration probes across lanes without retaining them across jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duration-reuse-'))
  try {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const measureDuration = vi.fn(async (text: string) => {
      if (text === 'one') await gate
      return text.split(' ').length * 0.01
    })
    const synthesize = vi.fn(async (text: string) => ({
      samples: new Float32Array(text.split(' ').length * 240).fill(0.5),
      sampleRate: 24000
    }))
    const synthesizer = { identity: 'voice-1', synthesize, measureDuration }
    const spec = {
      scenes: [
        {
          id: 's',
          msg: 0,
          panels: [],
          lines: [{ caption: 'one two three' }, { caption: 'one two three' }]
        }
      ]
    }
    const progress = vi.fn()
    const pending = prepareVideoNarration({
      spec,
      synthesizer,
      additionalSynthesizer: synthesizer,
      outputDirectory: join(root, 'first'),
      signal: new AbortController().signal,
      onProgress: progress
    })
    await vi.waitFor(() => expect(measureDuration).toHaveBeenCalledTimes(1))
    expect(synthesize).toHaveBeenCalledTimes(2)
    release()
    const first = await pending
    expect(measureDuration.mock.calls.map(([text]) => text)).toEqual([
      'one',
      'two three',
      'one two',
      'three'
    ])
    expect(progress.mock.calls.at(-2)?.[0]).toMatchObject({
      completed: 10,
      total: 10,
      completedLines: 2,
      totalLines: 2
    })
    const second = await prepareVideoNarration({
      spec,
      synthesizer,
      additionalSynthesizer: synthesizer,
      outputDirectory: join(root, 'second'),
      signal: new AbortController().signal
    })
    expect(second).toEqual(first)
    expect(measureDuration).toHaveBeenCalledTimes(8)
    const fallback = await prepareVideoNarration({
      spec,
      synthesizer: { identity: 'voice-1', synthesize },
      outputDirectory: join(root, 'fallback'),
      signal: new AbortController().signal
    })
    expect(fallback).toEqual(first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([NaN, Infinity, 0, -1, 301])(
  'rejects invalid duration-only results: %s',
  async (duration) => {
    const root = await mkdtemp(join(tmpdir(), 'invalid-probe-'))
    try {
      const outputDirectory = join(root, 'voice')
      await expect(
        prepareVideoNarration({
          spec: { scenes: [{ id: 's', msg: 0, panels: [], lines: [{ caption: 'one two' }] }] },
          synthesizer: {
            identity: 'fixture',
            synthesize: async () => ({ samples: new Float32Array(480), sampleRate: 24000 }),
            measureDuration: async () => duration
          },
          outputDirectory,
          signal: new AbortController().signal
        })
      ).rejects.toThrow('invalid duration')
      await expect(readFile(join(outputDirectory, 's_0.wav'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('propagates a shared probe failure to both lanes and removes incomplete output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-probe-failure-'))
  try {
    const outputDirectory = join(root, 'voice')
    const measureDuration = vi.fn(async () => {
      await Promise.resolve()
      throw new Error('probe failed')
    })
    const synthesizer = {
      identity: 'fixture',
      synthesize: async () => ({ samples: new Float32Array(480), sampleRate: 24000 }),
      measureDuration
    }
    await expect(
      prepareVideoNarration({
        spec: {
          scenes: [
            {
              id: 's',
              msg: 0,
              panels: [],
              lines: [{ caption: 'one two' }, { caption: 'one three' }]
            }
          ]
        },
        synthesizer,
        additionalSynthesizer: synthesizer,
        outputDirectory,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('probe failed')
    expect(measureDuration).toHaveBeenCalledTimes(1)
    await expect(readFile(join(outputDirectory, 's_0.wav'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('bounds duration reuse so old probes are recomputed after eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bounded-probes-'))
  try {
    const measureDuration = vi.fn(async (text: string) => text.split(' ').length * 0.001)
    const caption = 'alpha beta'
    const lines = [
      caption,
      ...Array.from({ length: 40 }, (_, i) =>
        Array.from({ length: 8 }, (_, j) => `w${i}x${j}`).join(' ')
      ),
      caption
    ].map((caption) => ({ caption }))
    const result = await prepareVideoNarration({
      spec: { scenes: [{ id: 's', msg: 0, panels: [], lines }] },
      synthesizer: {
        identity: 'fixture',
        measureDuration,
        synthesize: async (text) => ({
          samples: new Float32Array(text.split(' ').length * 24),
          sampleRate: 24000
        })
      },
      outputDirectory: join(root, 'voice'),
      signal: new AbortController().signal
    })
    expect(measureDuration.mock.calls.filter(([text]) => text === 'alpha')).toHaveLength(2)
    expect(result.voices.s_0).toEqual(result.voices.s_41)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps duration probes separate for different synthesizer identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-identity-'))
  try {
    const measures = [vi.fn(async () => 0.01), vi.fn(async () => 0.02)]
    const synthesizers = measures.map((measureDuration, i) => ({
      identity: `voice-${i}`,
      measureDuration,
      synthesize: async () => ({ samples: new Float32Array(480 * (i + 1)), sampleRate: 24000 })
    }))
    const result = await prepareVideoNarration({
      spec: {
        scenes: [
          { id: 's', msg: 0, panels: [], lines: [{ caption: 'one two' }, { caption: 'one two' }] }
        ]
      },
      synthesizer: synthesizers[0],
      additionalSynthesizer: synthesizers[1],
      outputDirectory: join(root, 'voice'),
      signal: new AbortController().signal
    })
    expect(measures[0]).toHaveBeenCalledTimes(2)
    expect(measures[1]).toHaveBeenCalledTimes(2)
    expect(result.voices.s_0.words[0][1]).toBeCloseTo(0.01)
    expect(result.voices.s_1.words[0][1]).toBeCloseTo(0.02)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
