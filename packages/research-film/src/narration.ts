import type { ResearchVideoStep } from './progress.js'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildVideoTimeline, type VideoSpec, type VoiceTiming } from './timeline.js'

export type SpeechSynthesizer = {
  identity: string
  measureDuration?(text: string): Promise<number>
  synthesize(text: string): Promise<{ samples: Float32Array; sampleRate: number }>
}

export function encodeVideoWav(samples: Float32Array, sampleRate: number, channels = 1): Buffer {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    ![1, 2].includes(channels) ||
    samples.length % channels
  )
    throw new Error('Invalid PCM format')
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((value, i) => {
    if (!Number.isFinite(value)) throw new Error('Nonfinite audio sample')
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2)
  })
  return buffer
}

// Keep logical line IDs intact: panel cues still refer to the original narration lines.
function narrationChunks(text: string): string[] {
  const words = text.trim().split(/\s+/u)
  const chunks: string[] = []
  if (words.some((word) => word.length > 400))
    throw new Error('Narration contains a word longer than 400 characters')
  for (let start = 0; start < words.length;) {
    let end = start + 1,
      length = words[start].length,
      boundary = /[.!?;,:]["’”')]*$/u.test(words[start]) ? end : 0
    while (end < words.length && length + 1 + words[end].length <= 220) {
      length += 1 + words[end].length
      end++
      if (/[.!?;,:]["’”')]*$/u.test(words[end - 1])) boundary = end
    }
    if (end < words.length && boundary > start) end = boundary
    chunks.push(words.slice(start, end).join(' '))
    start = end
  }
  return chunks
}

// Original skill alignment: identical words anchor runs; number/unit expansions share their spoken run.
function captionWordGroups(caption: string[], spoken: string[]): number[][] {
  const normal = (word: string): string =>
    word
      .toLowerCase()
      .replaceAll('’', "'")
      .replace(/[^a-z0-9'-]/g, '')
      .replace(/^-+|-+$/g, '')
  const numbers = new Set(
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion point minus negative plus percent and'.split(
      ' '
    )
  )
  const spokenNumber = (word: string): boolean =>
    normal(word)
      .split('-')
      .every((part) => numbers.has(part))
  const result: number[][] = []
  let i = 0,
    j = 0
  while (i < caption.length) {
    if (j < spoken.length && normal(caption[i]) === normal(spoken[j])) {
      result.push([j++])
      i++
      continue
    }
    let next = i + 1,
      match = -1
    while (next < caption.length) {
      match = spoken.findIndex(
        (word, index) => index >= j && normal(word) === normal(caption[next])
      )
      if (match >= 0) break
      next++
    }
    if (match < 0) match = spoken.length
    let remaining = Array.from({ length: match - j }, (_, offset) => j + offset)
    for (let k = i; k < next; k++) {
      let count = remaining.length
      if (k < next - 1) {
        count = 1
        if (/^[\d.,%]+$/.test(caption[k])) {
          count = 0
          while (count < remaining.length && spokenNumber(spoken[remaining[count]])) count++
          count = Math.max(1, count)
        } else while (count < remaining.length && !spokenNumber(spoken[remaining[count]])) count++
        // Keep at least one spoken token for each following caption token where possible.
        count = Math.min(count, Math.max(0, remaining.length - (next - k - 1)))
      }
      result.push(remaining.slice(0, count))
      remaining = remaining.slice(count)
    }
    i = next
    j = match
  }
  return result
}

/** Approximate alignment from independently synthesized caption prefixes, never advertised as ASR. */
export async function prepareVideoNarration(options: {
  spec: VideoSpec
  synthesizer: SpeechSynthesizer
  additionalSynthesizer?: SpeechSynthesizer
  outputDirectory: string
  signal: AbortSignal
  onProgress?: (progress: ResearchVideoStep) => void
}): Promise<{ voices: Record<string, VoiceTiming>; mix: Buffer }> {
  // Validate all identities and lengths before constructing filenames or allocating long audio.
  buildVideoTimeline(options.spec, {}, true)
  const voices: Record<string, VoiceTiming> = {}
  const recordings = new Map<string, { samples: Float32Array; sampleRate: number }>()
  const says: Record<string, string> = {}
  const jobs = options.spec.scenes.flatMap((scene) =>
    scene.lines.map((line, n) => ({
      key: `${scene.id}_${n}`,
      line,
      chunks: narrationChunks(line.say || line.caption),
      groups: captionWordGroups(
        line.caption.trim().split(/\s+/u),
        (line.say || line.caption).trim().split(/\s+/u)
      )
    }))
  )
  const total = jobs.reduce(
    (sum, { chunks }) =>
      sum + chunks.reduce((count, chunk) => count + 2 * chunk.split(' ').length - 1, 0),
    0
  )
  type Chunk = { samples: Float32Array; sampleRate: number; words: VoiceTiming['words'] }
  const chunksByLine: Chunk[][] = jobs.map((job) => new Array(job.chunks.length))
  const remaining = jobs.map((job) => job.chunks.length)
  const queue = jobs.flatMap((job, lineIndex) =>
    job.chunks.map((text, chunkIndex) => ({
      text,
      lineIndex,
      chunkIndex,
      cost: text.length * text.split(' ').length
    }))
  )
  // Prefix/suffix inference work grows with both words and text length. Keep one model per lane.
  if (options.additionalSynthesizer) queue.sort((a, b) => b.cost - a.cost)
  await mkdir(options.outputDirectory, { recursive: false })
  let completed = 0,
    completedLines = 0,
    next = 0
  let failure: unknown
  // Job-local scalar promises coalesce identical probes without retaining generated PCM.
  const durations = new Map<string, Promise<number>>()
  const remember = (key: string, value: Promise<number>): void => {
    if (durations.size >= 512) durations.delete(durations.keys().next().value!)
    durations.set(key, value)
  }
  const durationOf = (audio: Awaited<ReturnType<SpeechSynthesizer['synthesize']>>): number => {
    if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0 || !audio.samples.length)
      throw new Error('Speech synthesizer returned invalid audio')
    return audio.samples.length / audio.sampleRate
  }
  const report = (): void =>
    options.onProgress?.({
      phase: 'voice',
      completed,
      total,
      completedLines,
      totalLines: jobs.length
    })
  const lane = async (synthesizer: SpeechSynthesizer): Promise<void> => {
    const synthesize = async (text: string): ReturnType<SpeechSynthesizer['synthesize']> => {
      options.signal.throwIfAborted()
      if (failure) throw failure
      const result = await synthesizer.synthesize(text)
      options.signal.throwIfAborted()
      completed++
      report()
      return result
    }
    const measure = async (text: string): Promise<number> => {
      options.signal.throwIfAborted()
      if (failure) throw failure
      const key = JSON.stringify([synthesizer.identity, text])
      let pending = durations.get(key)
      if (!pending) {
        pending = synthesizer.measureDuration
          ? synthesizer.measureDuration(text)
          : synthesizer.synthesize(text).then(durationOf)
        remember(key, pending)
      }
      const duration = await pending
      options.signal.throwIfAborted()
      if (failure) throw failure
      if (!Number.isFinite(duration) || duration <= 0 || duration > 300)
        throw new Error('Speech synthesizer returned invalid duration')
      completed++
      report()
      return duration
    }
    for (let task = queue[next++]; task && !failure; task = queue[next++]) {
      options.signal.throwIfAborted()
      const { text, lineIndex, chunkIndex } = task
      const audio = await synthesize(text)
      const duration = durationOf(audio)
      if (!Number.isFinite(duration) || duration > 300)
        throw new Error('Narration exceeds five minutes per line')
      const durationKey = JSON.stringify([synthesizer.identity, text])
      if (!durations.has(durationKey)) remember(durationKey, Promise.resolve(duration))
      const words = text.split(' ')
      const boundaries: number[] = [0]
      for (let i = 1; i < words.length; i++) {
        const prefix = await measure(words.slice(0, i).join(' '))
        const suffix = await measure(words.slice(i).join(' '))
        const estimate = (prefix + duration - suffix) / 2
        if (!Number.isFinite(estimate)) throw new Error('Invalid speech alignment')
        boundaries.push(Math.min(duration, Math.max(boundaries.at(-1)!, estimate)))
      }
      boundaries.push(duration)
      chunksByLine[lineIndex][chunkIndex] = {
        ...audio,
        words: words.map((_, i): [number, number] => [boundaries[i], boundaries[i + 1]])
      }
      if (--remaining[lineIndex] === 0) completedLines++
      report()
    }
  }
  try {
    report()
    const lanes = [
      options.synthesizer,
      ...(options.additionalSynthesizer ? [options.additionalSynthesizer] : [])
    ]
    // Drain both lanes before cleanup; a failed peer must not recreate files after removal.
    const results = await Promise.allSettled(
      lanes.map((synthesizer) =>
        lane(synthesizer).catch((error) => {
          failure ??= error
          throw error
        })
      )
    )
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    for (const [index, { key, line, groups }] of jobs.entries()) {
      options.signal.throwIfAborted()
      const chunks = chunksByLine[index]
      const sampleRate = chunks[0].sampleRate
      const parts = chunks.map((chunk) => chunk.samples)
      const wordTimes: VoiceTiming['words'] = []
      let sampleCount = 0
      for (const chunk of chunks) {
        if (chunk.sampleRate !== sampleRate)
          throw new Error('Speech synthesizer changed sample rate within a line')
        const offset = sampleCount / sampleRate
        wordTimes.push(...chunk.words.map(([a, b]): [number, number] => [offset + a, offset + b]))
        sampleCount += chunk.samples.length
      }
      if (sampleCount / sampleRate > 300) throw new Error('Narration exceeds five minutes per line')
      const samples = new Float32Array(sampleCount)
      let offset = 0
      for (const part of parts) {
        samples.set(part, offset)
        offset += part.length
      }
      const audio = { samples, sampleRate }
      let last = 0
      const captionTimes = groups.map((group): [number, number] => {
        const first = wordTimes[group[0]],
          final = wordTimes[group.at(-1)!]
        const span: [number, number] =
          first && final ? [Math.max(last, first[0]), Math.max(last, final[1])] : [last, last]
        last = span[1]
        return span
      })
      voices[key] = { duration: sampleCount / sampleRate, words: captionTimes }
      recordings.set(key, audio)
      says[key] = line.say || line.caption
      await writeFile(
        join(options.outputDirectory, `${key}.wav`),
        encodeVideoWav(audio.samples, audio.sampleRate),
        { flag: 'wx', signal: options.signal }
      )
      chunksByLine[index] = []
    }
    options.onProgress?.({ phase: 'mixing' })
    const timeline = buildVideoTimeline(options.spec, voices)
    const mix = new Float32Array(Math.ceil(timeline.duration * 48000) * 2)
    for (const scene of timeline.scenes)
      for (const line of scene.lines) {
        const audio = recordings.get(line.key)!
        const start = Math.round((scene.start + line.t0) * 48000)
        const count = Math.ceil((audio.samples.length * 48000) / audio.sampleRate)
        for (let i = 0; i < count && start + i < mix.length / 2; i++) {
          const at = (i * audio.sampleRate) / 48000,
            index = Math.floor(at),
            fraction = at - index
          const value =
            audio.samples[index] * (1 - fraction) +
            (audio.samples[index + 1] ?? audio.samples[index]) * fraction
          mix[(start + i) * 2] += value
          mix[(start + i) * 2 + 1] += value
        }
      }
    options.signal.throwIfAborted()
    await writeFile(
      join(options.outputDirectory, 'timings.json'),
      JSON.stringify({
        engine: options.synthesizer.identity,
        alignment: 'synthesis-estimate-v1',
        say: says,
        lines: Object.fromEntries(Object.entries(voices).map(([k, v]) => [k, v.duration]))
      }),
      { flag: 'wx', signal: options.signal }
    )
    await writeFile(
      join(options.outputDirectory, 'word-times.json'),
      JSON.stringify(Object.fromEntries(Object.entries(voices).map(([k, v]) => [k, v.words]))),
      { flag: 'wx', signal: options.signal }
    )
    return { voices, mix: encodeVideoWav(mix, 48000, 2) }
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true })
    throw error
  }
}
