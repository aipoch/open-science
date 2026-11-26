import { mkdir, writeFile, rm, open } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { readVideoSourceFile } from './build-player.js'
import { parseReplayCase, replayNarrationSpec, REPLAY_RUNTIME_VERSION } from './replay-case.js'
import { buildVideoTimeline, type VoiceTiming } from './timeline.js'
import { assertResearchVideoPlayerSize, type ResearchVideoSessionSource } from './source.js'
import { researchFilmResources } from './resources.js'
import { replayWorkbench } from './replay-workbench.js'

const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')
const mime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav'
}
const dataUrl = (name: string, bytes: Uint8Array): string =>
  `data:${mime[extname(name)] ?? 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`

export async function freezeReplaySource(
  specPath: string,
  destination: string,
  signal: AbortSignal
): Promise<string> {
  const root = dirname(specPath)
  const sourceBytes = await readVideoSourceFile(root, 'session.json')
  const source = JSON.parse(sourceBytes.toString()) as ResearchVideoSessionSource
  const spec = parseReplayCase(
    (await readVideoSourceFile(root, basename(specPath))).toString(),
    source
  )
  const files = new Map<string, Buffer>([
    ['session.json', sourceBytes],
    ['video.json', Buffer.from(JSON.stringify(spec))]
  ])
  let size = sourceBytes.length
  for (const event of source.replay!.events) {
    signal.throwIfAborted()
    if (!event.image) continue
    if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|svg)$/.test(event.image))
      throw new Error('Invalid replay image identity.')
    const name = 'files/' + event.image
    if (files.has(name)) continue
    const bytes = await readVideoSourceFile(root, name)
    size += bytes.length
    if (size > 200 * 1024 * 1024) throw new Error('Replay source exceeds 200 MiB.')
    files.set(name, bytes)
  }
  await mkdir(destination, { recursive: false })
  for (const [name, bytes] of files) {
    await mkdir(dirname(join(destination, name)), { recursive: true })
    await writeFile(join(destination, name), bytes, { flag: 'wx', signal })
  }
  return join(destination, 'video.json')
}

export async function buildReplayPlayer(options: {
  specPath: string
  voiceDirectory: string
  mixPath?: string
  engineDirectory: string
  outputDirectory: string
  provenance?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<{ playerPath: string; sourcePath: string; duration: number; preparationMs: number }> {
  const started = performance.now(),
    root = dirname(options.specPath)
  const files: Record<string, Uint8Array> = {}
  let size = 0
  const read = async (base: string, name: string, key = name): Promise<Buffer> => {
    options.signal?.throwIfAborted()
    const cached = files[key]
    if (cached) return Buffer.from(cached.buffer, cached.byteOffset, cached.byteLength)
    const bytes = await readVideoSourceFile(base, name)
    size += bytes.length
    if (size > 200 * 1024 * 1024) throw new Error('Replay bundle exceeds 200 MiB.')
    files[key] = bytes
    return bytes
  }
  const source = JSON.parse(
    (await read(root, 'session.json')).toString()
  ) as ResearchVideoSessionSource
  const spec = parseReplayCase((await read(root, 'video.json')).toString(), source)
  const timing = JSON.parse(
    (await read(options.voiceDirectory, 'timings.json', 'voice/timings.json')).toString()
  )
  const words = JSON.parse(
    (await read(options.voiceDirectory, 'word-times.json', 'voice/word-times.json')).toString()
  )
  const voices: Record<string, VoiceTiming> = {}
  for (const scene of spec.scenes) {
    const key = `${scene.id}_0`
    if (timing.say?.[key] !== scene.narration) throw new Error('Stale replay narration.')
    voices[key] = { duration: timing.lines[key], words: words[key] }
    await read(options.voiceDirectory, `${key}.wav`, `voice/${key}.wav`)
  }
  const timeline = buildVideoTimeline(replayNarrationSpec(spec), voices)
  // One speech window can span several pictures. Boundaries are derived from measured speech,
  // never shifted into the next narration window or interpreted as recorded action times.
  const pictures = spec.scenes.flatMap((scene, index) => {
    const timed = timeline.scenes[index]
    return scene.evidenceIds.map((id, i) => ({
      event: source.replay!.events.find((event) => event.id === id)!,
      start: timed.start + (timed.dur * i) / scene.evidenceIds.length,
      end: timed.start + (timed.dur * (i + 1)) / scene.evidenceIds.length
    }))
  })
  const assets: Record<string, string> = {}
  const visibleImages = new Set(pictures.map(({ event }) => event.image).filter(Boolean))
  for (const event of source.replay!.events) {
    if (!event.image) continue
    const bytes = await read(root, 'files/' + event.image)
    // Keep all frozen images in sources.zip; only playback images need an embedded copy.
    if (visibleImages.has(event.image)) assets[event.image] = dataUrl(event.image, bytes)
  }
  const engine = options.engineDirectory
  const asset = async (name: string): Promise<string> =>
    dataUrl(name, await read(engine, name, 'engine/' + name))
  const notices = await Promise.all(
    [
      'brand/fonts/LICENSE-Inter.txt',
      'brand/fonts/LICENSE-RobotoMono.txt',
      'icons/LICENSE-lucide.txt'
    ].map(async (name) => (await read(engine, name, 'licenses/' + basename(name))).toString())
  )
  let css = ''
  for (const name of ['brand/fonts/fonts.css', 'ui/os-app.css', 'ui/os-kit.css']) {
    let part = (await read(engine, name, 'engine/' + name)).toString()
    for (const match of part.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
      const path = join(dirname(name), match[1]).split('\\').join('/')
      part = part.replace(match[0], `url("${await asset(path)}")`)
    }
    css += part
  }
  const replayRoot = researchFilmResources().replayDirectory
  for (const name of ['generic.css', 'opening-layout.css', 'end-card.css', 'player.css'])
    css += (await read(replayRoot, name, 'engine/replay/' + name)).toString()
  for (const name of [
    'aipoch-logo-primary.svg',
    'open-science-lockup-black.svg',
    'open-science-symbol-black.svg'
  ])
    assets['brand/logos/' + name] = await asset('brand/logos/' + name)
  const mixPath = options.mixPath ?? join(root, 'mix.wav')
  assets['mix.wav'] = dataUrl('mix.wav', await read(dirname(mixPath), basename(mixPath), 'mix.wav'))
  const data = replayWorkbench(spec, source, timeline, pictures, assets)
  let scripts = `window.CASE_DATA=${json(data)};window.VIDEO_ASSETS=${json(assets)};`
  scripts += 'window.CASE_DATA.audio=window.VIDEO_ASSETS["mix.wav"];'
  for (const [base, name] of [
    [engine, 'ui/os-kit.js'],
    [engine, 'icons/lucide.js'],
    [replayRoot, 'libs/operations-composer-v2.js'],
    [replayRoot, 'libs/operation-opening.js'],
    [replayRoot, 'libs/operation-end-card.js'],
    [replayRoot, 'generic.js'],
    [replayRoot, 'player.js']
  ]) {
    let script = (
      await read(base, name, 'engine/' + (base === replayRoot ? 'replay/' : '') + name)
    ).toString()
    for (const [name, url] of Object.entries(assets))
      if (name.startsWith('brand/')) script = script.replaceAll(name, url)
    scripts += '\n;\n' + script
  }
  files['timeline.json'] = Buffer.from(JSON.stringify({ ...data, pictures }))
  files['manifest.json'] = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        engineVersion: REPLAY_RUNTIME_VERSION,
        sourceScope: 'Frozen branch evidence, including records not selected for playback.',
        provenance: options.provenance,
        files: Object.entries(files).map(([path, bytes]) => ({
          path,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }))
      },
      null,
      2
    )
  )
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="open-science-research-video" content="1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Operation replay</title><!-- ${notices.join('\n').replace(/--/g, '—')} --><style>${css}</style><body><div id="root"></div><div id="controls"></div><script>${scripts.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
  assertResearchVideoPlayerSize(Buffer.byteLength(html))
  await mkdir(options.outputDirectory, { recursive: false })
  try {
    const playerPath = join(options.outputDirectory, 'player.html'),
      sourcePath = join(options.outputDirectory, 'sources.zip')
    await writeFile(playerPath, html, { flag: 'wx', signal: options.signal })
    const output = await open(sourcePath, 'wx')
    let chunks: Uint8Array[] = []
    let zipError: Error | null = null
    const archive = new Zip((error, chunk) => {
      if (error) zipError = error
      else chunks.push(chunk)
    })
    const flush = async (): Promise<void> => {
      if (zipError) throw zipError
      for (const chunk of chunks) await output.writeFile(chunk, { signal: options.signal })
      chunks = []
    }
    try {
      for (const [path, bytes] of Object.entries(files)) {
        options.signal?.throwIfAborted()
        // Already compressed images/fonts need no recompression; other files use bounded blocks.
        const entry = /\.(png|jpe?g|webp|woff2)$/i.test(path)
          ? new ZipPassThrough(path)
          : new ZipDeflate(path, { level: 1 })
        archive.add(entry)
        for (let offset = 0; offset < bytes.length || offset === 0; offset += 65_536) {
          options.signal?.throwIfAborted()
          entry.push(bytes.subarray(offset, offset + 65_536), offset + 65_536 >= bytes.length)
          await flush()
        }
      }
      archive.end()
      await flush()
    } finally {
      archive.terminate()
      await output.close()
    }
    return {
      playerPath,
      sourcePath,
      duration: timeline.duration,
      preparationMs: performance.now() - started
    }
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true })
    throw error
  }
}
