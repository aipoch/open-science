import { RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES } from './source.js'
import { readFile, realpath, stat, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Script } from 'node:vm'
import Papa from 'papaparse'
import { ResearchVideoPlaybackClock } from './playback.js'
import { zipSync } from 'fflate'
import { buildVideoTimeline, type VideoSpec, type VoiceTiming } from './timeline.js'

type SourceSpec = VideoSpec & {
  title: string
  case?: string
  session: string
  files?: string
  profile?: string
  disclaimer?: string
  start_file?: string
}
type SessionSnapshot = {
  messages: Array<{ md?: string; [key: string]: unknown }>
  [key: string]: unknown
}
const mime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav'
}
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c')
const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Resolve only portable source-relative paths, including after symlink resolution. */
export async function readVideoSourceFile(root: string, name: string): Promise<Buffer> {
  if (
    !name ||
    name.includes('\\') ||
    name.includes(':') ||
    isAbsolute(name) ||
    name.split('/').some((p) => p === '..' || p === '' || p === '.')
  )
    throw new Error(`Invalid source path: ${name}`)
  const base = await realpath(root)
  const path = await realpath(resolve(base, name))
  const rel = relative(base, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`Source path escapes bundle: ${name}`)
  const info = await stat(path)
  if (!info.isFile() || info.size > RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES)
    throw new Error(`Invalid or oversized source: ${name}`)
  return readFile(path)
}

export async function buildResearchVideoPlayer(options: {
  specPath: string
  provenance?: Record<string, unknown>
  voiceDirectory: string
  mixPath?: string
  engineDirectory: string
  outputDirectory: string
  signal?: AbortSignal
}): Promise<{ playerPath: string; sourcePath: string; duration: number; preparationMs: number }> {
  const start = performance.now()
  const root = dirname(await realpath(options.specPath))
  const sources: Record<string, Uint8Array> = {}
  let sourceBytes = 0
  const source = async (name: string): Promise<Buffer> => {
    options.signal?.throwIfAborted()
    if (/^(engine\/|voice\/|licenses\/|manifest\.json$|mix\.wav$)/i.test(name))
      throw new Error(`Source path conflicts with generated bundle files: ${name}`)
    if (sources[name]) return Buffer.from(sources[name])
    const bytes = await readVideoSourceFile(root, name)
    sourceBytes += bytes.length
    if (sourceBytes > 200 * 1024 * 1024) throw new Error('Source bundle exceeds 200 MiB')
    sources[name] = bytes
    return bytes
  }
  const spec: SourceSpec = JSON.parse(
    (await source(relative(root, await realpath(options.specPath)))).toString()
  )
  if (typeof spec.title !== 'string' || !spec.title.trim() || typeof spec.session !== 'string')
    throw new Error('Missing video title or session snapshot')
  const session: SessionSnapshot = JSON.parse((await source(spec.session)).toString())
  if (!Array.isArray(session.messages)) throw new Error('Invalid session snapshot')
  const timing = JSON.parse(
    (await readVideoSourceFile(options.voiceDirectory, 'timings.json')).toString()
  )
  const words = JSON.parse(
    (await readVideoSourceFile(options.voiceDirectory, 'word-times.json')).toString()
  )
  const voices: Record<string, VoiceTiming> = {}
  for (const scene of spec.scenes)
    for (const [i, line] of scene.lines.entries()) {
      const key = `${scene.id}_${i}`
      if (timing.say?.[key] !== (line.say || line.caption))
        throw new Error(`Stale or missing voice text: ${key}`)
      voices[key] = { duration: timing.lines[key], words: words[key] }
    }
  const timeline = buildVideoTimeline(spec, voices)
  for (const name of [
    'timings.json',
    'word-times.json',
    ...Object.keys(voices).map((key) => `${key}.wav`)
  ]) {
    const bytes = await readVideoSourceFile(options.voiceDirectory, name)
    sourceBytes += bytes.length
    if (sourceBytes > 200 * 1024 * 1024) throw new Error('Source bundle exceeds 200 MiB')
    sources[`voice/${name}`] = bytes
  }
  const dataUrls: Record<string, string> = {}
  const dataUrl = (name: string, bytes: Buffer): string =>
    `data:${mime[extname(name)] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`
  const file = async (name: string): Promise<Buffer> => source(`${spec.files ?? 'files'}/${name}`)
  const tables: Record<string, { n: number; cols: Record<string, unknown[]> }> = {}
  const table = async (name: string): Promise<{ n: number; cols: Record<string, unknown[]> }> => {
    if (tables[name]) return tables[name]
    const parsed = Papa.parse<Record<string, string>>((await file(name)).toString(), {
      header: true,
      skipEmptyLines: true
    })
    if (parsed.errors.length || !parsed.data.length || parsed.data.length > 100_000)
      throw new Error(`Invalid CSV: ${name}`)
    const cols = Object.fromEntries(
      Object.keys(parsed.data[0]).map((col) => [
        col,
        parsed.data.map((r) =>
          r[col] === '' ? null : Number.isFinite(Number(r[col])) ? Number(r[col]) : r[col]
        )
      ])
    )
    return (tables[name] = { n: parsed.data.length, cols })
  }
  const codes: Record<string, string> = {}
  for (const scene of timeline.scenes) {
    if (
      !Number.isInteger(scene.msg) ||
      Number(scene.msg) < 0 ||
      Number(scene.msg) >= session.messages.length
    )
      throw new Error(`Missing source message: ${scene.id}`)
    for (const panel of scene.panels) {
      if (panel.type === 'animation') {
        const paths = [...(Array.isArray(panel.use) ? panel.use : []), panel.script]
        if (paths.some((p) => typeof p !== 'string')) throw new Error('Invalid animation source')
        const key = `code:${paths.join('+')}`
        codes[key] = (
          await Promise.all(paths.map(async (p) => (await source(String(p))).toString()))
        ).join('\n;\n')
        panel.code = key
        for (const name of Array.isArray(panel.data) ? panel.data : []) await table(String(name))
      }
      if (panel.type === 'figure') {
        const name = String(panel.file)
        dataUrls[`files/${name}`] = dataUrl(name, await file(name))
      }
      if (panel.type === 'line_chart') {
        const t = await table(String(panel.csv))
        const x = String(panel.x)
        const series = panel.series as Array<{ y: string; scale?: number }>
        if (!Array.isArray(series) || !t.cols[x] || series.some((s) => !t.cols[s.y]))
          throw new Error('Missing chart columns')
        const filter = panel.where as Record<string, unknown> | undefined
        const rows = Array.from({ length: t.n }, (_, i) => i).filter(
          (i) =>
            !filter ||
            Object.entries(filter).every(([k, v]) => String(t.cols[k]?.[i]) === String(v))
        )
        if (!rows.length) throw new Error('Chart contains no matching rows')
        const number = (v: unknown): number => {
          if (typeof v !== 'number' || !Number.isFinite(v))
            throw new Error('Chart value is not numeric')
          return v
        }
        panel.data = {
          x: rows.map((i) => number(t.cols[x][i])),
          ys: series.map((s) => rows.map((i) => number(t.cols[s.y][i]) * (s.scale ?? 1)))
        }
      }
    }
  }
  for (const message of session.messages) {
    for (const match of (message.md ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const name = match[1].replace(/^files\//, '')
      dataUrls[match[1]] = dataUrl(name, await file(name))
    }
  }
  const previewFiles: Record<
    string,
    { kind: 'img'; src: string } | { kind: 'text'; text: string }
  > = {}
  const previewOrder = [
    ...new Set(
      [spec.start_file, ...spec.scenes.map((scene) => scene.file)].filter(
        (name): name is string => typeof name === 'string' && Boolean(name)
      )
    )
  ]
  for (const name of previewOrder) {
    const bytes = await file(name)
    if (['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extname(name).toLowerCase()))
      previewFiles[name] = { kind: 'img', src: dataUrl(name, bytes) }
    else if (
      ['.txt', '.md', '.json', '.csv', '.py', '.r', '.R', '.js', '.ts'].includes(extname(name))
    )
      previewFiles[name] = { kind: 'text', text: bytes.toString().slice(0, 100_000) }
    else throw new Error(`Unsupported source preview: ${name}`)
  }
  const engineBytes = async (name: string): Promise<Buffer> => {
    const key = `engine/${name}`
    if (sources[key]) return Buffer.from(sources[key])
    const bytes = await readVideoSourceFile(options.engineDirectory, name)
    sourceBytes += bytes.length
    if (sourceBytes > 200 * 1024 * 1024) throw new Error('Source bundle exceeds 200 MiB')
    sources[key] = bytes
    return bytes
  }
  const engine = async (name: string): Promise<string> => (await engineBytes(name)).toString()
  const tokens = JSON.parse(await engine('tokens.json'))
  const colors = { ...tokens.color, ...tokens.videoExtensions }
  const cssTokens =
    `:root,.stage{${Object.entries(colors)
      .map(([k, v]) => `--c-${k}:${v};`)
      .join('')}${Object.entries(tokens.font)
      .map(([k, v]) => `--f-${k}:${v};`)
      .join('')}${Object.entries(tokens.radius)
      .map(([k, v]) => `--r-${k}:${v}px;`)
      .join('')}${Object.entries(tokens.shadow)
      .map(([k, v]) => `--sh-${k}:${v};`)
      .join('')}}` +
    Object.entries(tokens.text)
      .map(([k, raw]) => {
        const t = raw as {
          weight: number
          size: number
          line: number
          font: string
          tracking: number
          color: string
          upper?: boolean
        }
        return `:root{--t-${k}:${t.weight} ${t.size}px/${t.line}px ${tokens.font[t.font]};--t-${k}-track:${t.tracking}px}.ts-${k}{font:var(--t-${k});letter-spacing:var(--t-${k}-track);color:var(--c-${t.color});${t.upper ? 'text-transform:uppercase;' : ''}}`
      })
      .join('')
  const notices: string[] = []
  for (const name of [
    'brand/fonts/LICENSE-Inter.txt',
    'brand/fonts/LICENSE-RobotoMono.txt',
    'icons/LICENSE-lucide.txt'
  ]) {
    const notice = await engine(name)
    notices.push(notice)
    sources[`licenses/${name.split('/').at(-1)}`] = Buffer.from(notice)
  }
  let css = cssTokens
  for (const name of ['brand/fonts/fonts.css', 'ui/os-app.css', 'ui/os-kit.css', 'css/stage.css']) {
    let content = await engine(name)
    for (const match of content.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
      const path = join(dirname(name), match[1]).split('\\').join('/')
      content = content.replace(match[0], `url("${dataUrl(path, await engineBytes(path))}")`)
    }
    css += content
  }
  for (const name of [
    'open-science-symbol-black.svg',
    'open-science-lockup-black.svg',
    'aipoch-logo-primary.svg'
  ]) {
    const path = `brand/logos/${name}`
    dataUrls[path] = dataUrl(path, await engineBytes(path))
  }
  const mix = options.mixPath
    ? await readVideoSourceFile(
        dirname(options.mixPath),
        relative(dirname(options.mixPath), options.mixPath)
      )
    : await readVideoSourceFile(root, 'mix.wav')
  sourceBytes += mix.length
  if (sourceBytes > 200 * 1024 * 1024) throw new Error('Source bundle exceeds 200 MiB')
  sources['mix.wav'] = mix
  dataUrls['mix.wav'] = dataUrl('mix.wav', mix)
  const data = {
    meta: {
      title: spec.title,
      case: spec.case,
      profile: spec.profile ?? 'user',
      disclaimer: spec.disclaimer ?? ''
    },
    timeline,
    session,
    preview: previewOrder.length
      ? { order: previewOrder, files: previewFiles, name: previewOrder[0] }
      : null,
    tables,
    codes,
    subjects: {},
    assets: [],
    svgs: {}
  }
  let scripts = `window.DATA=${scriptJson(data)};window.TOKENS=${scriptJson(tokens)};window.VIDEO_ASSETS=${scriptJson(dataUrls)};`
  scripts += `window.ResearchVideoPlaybackClock=${ResearchVideoPlaybackClock.toString()};`
  for (const [key, code] of Object.entries(codes)) {
    const factory = `function(k,Math,Date,performance,requestAnimationFrame,setTimeout,setInterval){${code}\n}`
    new Script(`(${factory})`) // Compile without executing imported animation code.
    scripts += `window.VIDEO_ANIMATIONS ??= {}; window.VIDEO_ANIMATIONS[${scriptJson(key)}]=${factory};`
  }
  // The generated document receives only embedded resources. No application bridge or origin.
  for (const name of [
    'js/anim.js',
    'ui/os-kit.js',
    'ui/os-session.js',
    'icons/lucide.js',
    'js/kit.js',
    'js/panels.js',
    'js/stage.js'
  ])
    scripts += '\n;\n' + (await engine(name))
  const inner = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><meta name="open-science-research-video" content="1"><title>${attr(spec.title)}</title><!-- Third-party licenses: ${notices.join('\n\n').replace(/--/g, '—')} --><style>${css}</style><div id="root"></div><div id="controls"></div><script>${scripts.replace(/<\/script/gi, '<\\/script')}</script></html>`
  const html = inner

  const manifest = {
    schemaVersion: 1,
    engineVersion: '1',
    provenance: options.provenance ?? { kind: 'external-source-bundle' },
    files: Object.entries(sources).map(([path, bytes]) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }))
  }
  sources['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2))
  options.signal?.throwIfAborted()
  await mkdir(options.outputDirectory, { recursive: false })
  try {
    const playerPath = join(options.outputDirectory, 'player.html'),
      sourcePath = join(options.outputDirectory, 'sources.zip')
    await writeFile(playerPath, html, { flag: 'wx', signal: options.signal })
    await writeFile(sourcePath, zipSync(sources), { flag: 'wx', signal: options.signal })
    return {
      playerPath,
      sourcePath,
      duration: timeline.duration,
      preparationMs: performance.now() - start
    }
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true })
    throw error
  }
}
