import { videoIllustrationSchema } from './illustration.js'

export type VideoLine = { caption: string; say?: string }
export type VideoPanel = {
  type: string
  at?: string
  until?: string
  items?: Array<{ at?: string; [key: string]: unknown }>
  rows?: Array<{ at?: string; [key: string]: unknown }>
  marks?: Array<{ at?: string; [key: string]: unknown }>
  elements?: Array<{ at?: string; [key: string]: unknown }>
  left?: { at?: string; [key: string]: unknown }
  right?: { at?: string; [key: string]: unknown }
  band?: { at?: string; [key: string]: unknown }
  [key: string]: unknown
}
export type VideoScene = {
  id: string
  msg: number
  lines: VideoLine[]
  panels: VideoPanel[]
  [key: string]: unknown
}
export type VideoSpec = { scenes: VideoScene[] }
export type WordTime = [word: string, start: number, end: number]
export type ResolvedLine = {
  key: string
  caption: string
  t0: number
  t1: number
  voiced: boolean
  words: WordTime[]
}
export type ResolvedPanel = VideoPanel & { t_in: number; t_out: number | null; occ_from: number }
export type ResolvedScene = Omit<VideoScene, 'lines' | 'panels'> & {
  id: string
  start: number
  dur: number
  veil: number
  lines: ResolvedLine[]
  panels: ResolvedPanel[]
}
export type VoiceTiming = { duration: number; words: Array<[number, number]> }
const round = (n: number): number => Math.round(n * 1000) / 1000
const punctuation = /[,.?!—:;]$/u
const itemKeys: Record<string, 'items' | 'rows' | 'marks'> = {
  stats: 'items',
  bars: 'items',
  criteria: 'items',
  checklist: 'items',
  steps: 'items',
  report: 'rows',
  line_chart: 'marks'
}
const normal = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}_.%,]/gu, '')

export function resolveVideoCue(cue: string, scene: Pick<ResolvedScene, 'dur' | 'lines'>): number {
  const match = /^(end|\d+)(\.end|:([^\s+-]+))?([+-]\d+(?:\.\d+)?)?$/.exec(cue)
  if (!match) throw new Error(`Invalid cue: ${cue}`)
  const [, base, tail, word, offset] = match
  const delta = Number(offset ?? 0)
  if (base === 'end') {
    if (tail) throw new Error(`Invalid end cue: ${cue}`)
    return scene.dur + delta
  }
  const line = scene.lines[Number(base)]
  if (!line) throw new Error(`Cue references missing line: ${cue}`)
  if (!tail) return line.t0 + delta
  if (tail === '.end') return line.t1 + delta
  const key = normal(word)
  if (!key) throw new Error(`Empty cue word: ${cue}`)
  const found = line.words.find(([text]) => normal(text).startsWith(key))
  if (!found) throw new Error(`Cue word not found: ${cue}`)
  return found[1] + delta
}

function alignWords(
  caption: string,
  start: number,
  duration: number,
  measured?: VoiceTiming
): WordTime[] {
  const words = caption.trim().split(/\s+/u)
  if (measured) {
    if (measured.words.length !== words.length)
      throw new Error('Caption alignment word count mismatch')
    let previous = 0
    return measured.words.map(([a, b], index) => {
      if (![a, b].every(Number.isFinite) || a < previous || b < a || b > duration + 0.001) {
        throw new Error('Caption alignment is non-monotonic or outside narration')
      }
      previous = b
      return [words[index], start + a, start + b]
    })
  }
  const weights = words.map((w) => w.length + 2 + (punctuation.test(w) ? 4 : 0))
  const total = weights.reduce((a, b) => a + b, 0)
  let elapsed = 0
  return words.map((word, i) => {
    const a = start + (duration * elapsed) / total
    elapsed += weights[i]
    return [word, a, start + (duration * elapsed) / total]
  })
}

function panelTiming(panel: VideoPanel, scene: ResolvedScene, hook: boolean): ResolvedPanel {
  const cue = (v: unknown, fallback: number): number => {
    const value = v === undefined ? fallback : resolveVideoCue(String(v), scene)
    if (!Number.isFinite(value) || value < 0 || value > scene.dur)
      throw new Error(`Panel cue outside scene ${scene.id}`)
    return round(value)
  }
  const t = hook ? cue(panel.at, 0) : Math.max(0.5, cue(panel.at, scene.lines[0].t0))
  const out = panel.until === undefined ? null : cue(panel.until, scene.dur)
  if (out !== null && out <= t + 0.5)
    throw new Error('Panel exit must follow entrance by more than 0.5 seconds')
  const result: ResolvedPanel = { ...panel, t_in: t, t_out: out, occ_from: 0 }
  if (panel.type === 'illustration')
    result.elements = panel.elements!.map((element) => ({
      ...element,
      t_in: Math.max(t, cue(element.at, t))
    }))
  if (hook && panel.type === 'title') result.fast = true
  const key = itemKeys[panel.type]
  let last = t
  if (key && panel[key]) {
    let next = t + 0.35
    result[key] = panel[key].map((item) => {
      const time = cue(item.at, next)
      const at = item.at === undefined ? time : Math.max(t + 0.2, time)
      if (at > scene.dur) throw new Error('Item reveal is outside scene')
      next = Math.max(next, at) + 0.35
      last = Math.max(last, at)
      return { ...item, t_in: round(at) }
    })
  }
  if (panel.type === 'compare' && panel.left)
    result.left = { ...panel.left, t_in: Math.max(t, cue(panel.left.at, t + 0.2)) }
  if (panel.type === 'compare' && panel.right)
    result.right = { ...panel.right, t_in: Math.max(t + 0.3, cue(panel.right.at, t + 0.6)) }
  if (panel.type === 'line_chart' && panel.band)
    result.band = { ...panel.band, t_in: cue(panel.band.at, t + Number(panel.draw ?? 2.5)) }
  for (const field of ['note', 'badge', 'total', 'foot']) {
    if (panel[field])
      result[`${field}_t`] =
        panel.type === 'title'
          ? Math.max(t + 0.6, cue(panel[`${field}_at`], 0))
          : cue(panel[`${field}_at`], last + 0.6)
  }
  return result
}

/** Estimated timing is explicitly preview-only. Published narration requires measured durations. */
export type VideoTimeline = {
  fps: number
  duration: number
  frames: number
  scenes: ResolvedScene[]
  captions: Record<'16x9' | '9x16', Array<{ words: WordTime[]; end: number }>>
}

export function buildVideoTimeline(
  spec: VideoSpec,
  voices: Record<string, VoiceTiming>,
  preview = false
): VideoTimeline {
  if (!Array.isArray(spec.scenes) || !spec.scenes.length || spec.scenes.length > 100)
    throw new Error('Expected 1–100 scenes')
  const ids = new Set<string>()
  let totalLines = 0
  let totalCharacters = 0
  const scenes: ResolvedScene[] = []
  let start = 0
  for (const [index, scene] of spec.scenes.entries()) {
    const veil = scene.veil ?? 0.6
    if (typeof veil !== 'number' || !Number.isFinite(veil) || veil < 0 || veil > 1)
      throw new Error('Scene veil must be a number between 0 and 1')
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(scene.id) || ids.has(scene.id))
      throw new Error('Invalid or duplicate scene ID')
    ids.add(scene.id)
    if (!Array.isArray(scene.lines) || !scene.lines.length || scene.lines.length > 100)
      throw new Error('Expected 1–100 narration lines')
    if (!Array.isArray(scene.panels) || scene.panels.length > 50) throw new Error('Invalid panels')
    totalLines += scene.lines.length
    totalCharacters += scene.lines.reduce(
      (sum, line) => sum + (typeof line.caption === 'string' ? line.caption.length : 0),
      0
    )
    if (totalLines > 120 || totalCharacters > 12000)
      throw new Error(
        'Split this explanation into smaller videos (120 lines / 12000 characters maximum)'
      )
    for (const panel of scene.panels) {
      if (
        ![
          'title',
          'stats',
          'bars',
          'line_chart',
          'criteria',
          'checklist',
          'formula',
          'progress',
          'quote',
          'steps',
          'compare',
          'figure',
          'report',
          'verdict',
          'animation',
          'illustration',
          'end_card'
        ].includes(panel.type)
      )
        throw new Error('Unsupported video panel type')
      if (panel.type === 'illustration') videoIllustrationSchema.parse(panel)
      for (const key of ['items', 'rows', 'marks'] as const)
        if (
          panel[key] !== undefined &&
          (!Array.isArray(panel[key]) ||
            panel[key].length > 100 ||
            panel[key].some((item) => !item || typeof item !== 'object'))
        )
          throw new Error('Invalid panel items')
    }
    let current = index === 0 ? 0.3 : 0.45
    const lines = scene.lines.map((line, n): ResolvedLine => {
      if (typeof line.caption !== 'string' || !line.caption.trim() || line.caption.length > 5000)
        throw new Error('Invalid caption')
      const key = `${scene.id}_${n}`
      const voice = voices[key]
      if (!voice && !preview) throw new Error(`Missing narration: ${key}`)
      const duration =
        voice?.duration ??
        round((line.say || line.caption).trim().split(/\s+/u).length / 2.6 + 0.35)
      if (!Number.isFinite(duration) || duration <= 0 || duration > 300)
        throw new Error(`Invalid narration duration: ${key}`)
      const result = {
        key,
        caption: line.caption,
        t0: round(current),
        t1: round(current + duration),
        voiced: !!voice,
        words: alignWords(line.caption, current, duration, voice)
      }
      current += duration + 0.3
      return result
    })
    const dur = round(lines.at(-1)!.t1 + (index === spec.scenes.length - 1 ? 2 : 0.6))
    const resolved: ResolvedScene = { ...scene, veil, start: round(start), dur, lines, panels: [] }
    resolved.panels = scene.panels.map((p) => panelTiming(p, resolved, index === 0))
    for (const p of resolved.panels)
      p.occ_from = Math.max(
        0,
        ...resolved.panels
          .filter((q) => q !== p && q.t_out !== null && q.t_out <= p.t_in + 1e-6)
          .map((q) => q.t_out!)
      )
    scenes.push(resolved)
    start += dur
  }
  if (start > 3600) throw new Error('Video exceeds one hour')
  const chunks: Array<{ words: WordTime[]; end: number }> = []
  for (const scene of scenes)
    for (const line of scene.lines) {
      let words: WordTime[] = []
      for (const [i, [word, a, b]] of line.words.entries()) {
        words.push([word, round(scene.start + a), round(scene.start + b)])
        if (
          words.length >= 7 ||
          (punctuation.test(word) && words.length >= 2) ||
          i === line.words.length - 1
        ) {
          chunks.push({ words, end: round(scene.start + b + 0.35) })
          words = []
        }
      }
    }
  chunks.forEach((chunk, i) => {
    const next = chunks[i + 1]?.words[0][1]
    if (next !== undefined && next - chunk.words.at(-1)![2] < 0.6) chunk.end = next
  })
  const tall = chunks.flatMap((chunk) => {
    const parts: typeof chunks = []
    for (let i = 0; i < chunk.words.length; i += 4)
      parts.push({ words: chunk.words.slice(i, i + 4), end: chunk.words[i + 4]?.[1] ?? chunk.end })
    return parts
  })
  return {
    fps: 30,
    duration: round(start),
    frames: Math.ceil(round(start) * 30),
    scenes,
    captions: { '16x9': chunks, '9x16': tall }
  }
}
