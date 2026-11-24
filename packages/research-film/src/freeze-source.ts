import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readVideoSourceFile } from './build-player.js'
import { buildVideoTimeline, type VideoSpec } from './timeline.js'

/** Stage only referenced, contained bytes before narration, so edits cannot change the later build. */
export async function freezeResearchVideoSource(
  specPath: string,
  destination: string,
  signal: AbortSignal,
  sessionAppSha256?: string
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
  if (spec.assets || spec.subjects)
    throw new Error(
      'External libraries and asset bundles are not supported by this authoring surface yet'
    )
  const files = new Set<string>([spec.session])
  let approvedApp: Buffer | undefined
  if (spec.libs !== undefined) {
    if (
      !Array.isArray(spec.libs) ||
      spec.libs.length !== 1 ||
      spec.libs[0] !== 'libs/app.js' ||
      typeof sessionAppSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sessionAppSha256)
    )
      throw new Error('Session app approval is required for this film.')
    signal.throwIfAborted()
    approvedApp = await readVideoSourceFile(root, 'libs/app.js')
    if (createHash('sha256').update(approvedApp).digest('hex') !== sessionAppSha256)
      throw new Error('The approved session app changed.')
    files.add('libs/app.js')
  }
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
    // Reuse exactly the bytes whose digest was approved, never a later source read.
    const bytes =
      name === spec.session
        ? sessionBytes
        : name === 'libs/app.js' && approvedApp
          ? approvedApp
          : await readVideoSourceFile(root, name)
    total += bytes.length
    if (total > 200 * 1024 * 1024) throw new Error('Video sources exceed 200 MiB')
    const path = join(destination, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx', signal })
  }
  return join(destination, 'video.json')
}
