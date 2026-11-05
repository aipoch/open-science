import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readVideoSourceFile } from './build-player.js'
import { buildVideoTimeline, type VideoSpec } from './timeline.js'

/** Stage only referenced, contained bytes before narration, so edits cannot change the later build. */
export async function freezeResearchVideoSource(
  specPath: string,
  destination: string,
  signal: AbortSignal
): Promise<string> {
  const root = dirname(specPath)
  const specBytes = await readVideoSourceFile(root, basename(specPath))
  const spec = JSON.parse(specBytes.toString()) as VideoSpec & {
    session: string
    files?: string
    libs?: unknown
    assets?: unknown
    subjects?: unknown
    voice?: { voice?: unknown; speed?: unknown }
    start_file?: string
  }
  buildVideoTimeline(spec, {}, true)
  if (
    spec.voice &&
    ((spec.voice.voice !== undefined && spec.voice.voice !== 'af_heart') ||
      (spec.voice.speed !== undefined && spec.voice.speed !== 1))
  )
    throw new Error('This version supports af_heart English narration at speed 1 only')
  if (spec.libs || spec.assets || spec.subjects)
    throw new Error(
      'External libraries and asset bundles are not supported by this authoring surface yet'
    )
  const files = new Set<string>([spec.session])
  const asset = (name: unknown): void => {
    if (typeof name !== 'string') throw new Error('Invalid source asset')
    files.add(`${spec.files ?? 'files'}/${name}`)
  }
  if (spec.start_file) asset(spec.start_file)
  for (const scene of spec.scenes) {
    if (scene.file) asset(scene.file)
    for (const panel of scene.panels) {
      if (panel.type === 'animation') {
        if (typeof panel.script !== 'string') throw new Error('Missing animation script')
        files.add(panel.script)
        for (const name of Array.isArray(panel.use) ? panel.use : []) {
          if (typeof name !== 'string') throw new Error('Invalid animation dependency')
          files.add(name)
        }
        for (const name of Array.isArray(panel.data) ? panel.data : []) asset(name)
      }
      if (panel.file) asset(panel.file)
      if (panel.csv) asset(panel.csv)
    }
  }
  const sessionBytes = await readVideoSourceFile(root, spec.session)
  const session = JSON.parse(sessionBytes.toString())
  if (!Array.isArray(session.messages)) throw new Error('Invalid source session')
  for (const message of session.messages)
    for (const match of String(message.md ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g))
      asset(match[1].replace(/^files\//, ''))
  await mkdir(destination, { recursive: false })
  await writeFile(join(destination, 'video.json'), specBytes, { flag: 'wx', signal })
  let total = specBytes.length
  for (const name of files) {
    signal.throwIfAborted()
    const bytes = name === spec.session ? sessionBytes : await readVideoSourceFile(root, name)
    total += bytes.length
    if (total > 200 * 1024 * 1024) throw new Error('Video sources exceed 200 MiB')
    const path = join(destination, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx', signal })
  }
  return join(destination, 'video.json')
}
