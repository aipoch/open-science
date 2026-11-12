import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Script } from 'node:vm'
import type { VideoSpec } from './timeline.js'
import {
  writeWithResearchFilmCorrection,
  type FilmAuthoringCheckpoint
} from './authoring-correction.js'

export type ResearchVideoAnimationInput = {
  path: string
  shared: boolean
  spec: VideoSpec
  sharedFiles: Record<string, string>
}
export type ResearchVideoAnimationWriter = (
  input: ResearchVideoAnimationInput,
  signal: AbortSignal,
  correction?: { draft: string; error: string }
) => Promise<string>

/** Validate before authoring so an invalid plan can use the screenplay's correction allowance. */
export function researchVideoAnimationPlan(spec: VideoSpec): {
  panels: VideoSpec['scenes'][number]['panels']
  shared: string[]
  scripts: string[]
} {
  const panels = spec.scenes.flatMap((scene) => scene.panels).filter((p) => p.type === 'animation')
  const path = (value: unknown): string => {
    if (typeof value !== 'string' || !/^anims\/[a-zA-Z0-9][\w-]{0,100}\.js$/.test(value))
      throw new Error('Animation files must use anims/<name>.js')
    return value
  }
  const shared = [...new Set(panels.flatMap((p) => (Array.isArray(p.use) ? p.use : []).map(path)))]
  const scripts = [...new Set(panels.map((p) => path(p.script)))]
  const paths = [...shared, ...scripts]
  if (paths.length > 16 || new Set(paths.map((p) => p.toLowerCase())).size !== paths.length)
    throw new Error(
      'Use at most 16 distinct animation files; shared helpers and scene scripts must have separate names.'
    )
  return { panels, shared, scripts }
}

/** Original skill format: local shared helpers (`use`) followed by per-scene draw(k) bodies. */
export async function writeResearchVideoAnimations(
  spec: VideoSpec,
  directory: string,
  writer: ResearchVideoAnimationWriter | undefined,
  parentSignal: AbortSignal,
  checkpoint?: FilmAuthoringCheckpoint,
  progress?: (completed: number, total: number) => void
): Promise<void> {
  const { panels, shared, scripts } = researchVideoAnimationPlan(spec)
  const total = shared.length + scripts.length
  let completed = 0
  progress?.(completed, total)
  if (!panels.length) return
  if (!writer) throw new Error('Animation authoring is unavailable.')
  const controller = new AbortController()
  const signal = AbortSignal.any([parentSignal, controller.signal])
  const files: Record<string, string> = {}
  await mkdir(join(directory, 'anims'), { recursive: false })
  const write = async (name: string): Promise<void> => {
    signal.throwIfAborted()
    const input = {
      path: name,
      shared: shared.includes(name),
      spec,
      sharedFiles: Object.fromEntries(shared.filter((p) => files[p]).map((p) => [p, files[p]]))
    }
    const validate = (raw: string): string => {
      const code = raw.trim().replace(/^```(?:javascript|js)?\s*\n([\s\S]*?)\n```$/u, '$1')
      if (!code || Buffer.byteLength(code) > 64 * 1024)
        throw new Error('Animation source must contain 1–65536 bytes.')
      const required = panels
        .filter((p) => p.script === name)
        .flatMap((p) => (Array.isArray(p.use) ? (p.use as string[]) : []))
      const helpers = [...new Set(required)].map((p) => files[p]).join('\n;\n')
      // Compile only. Model-generated code is never executed by the Node runtime.
      new Script(`(function(k){${helpers}\n;\n${code}\n})`, { filename: name })
      return code
    }
    const code = await writeWithResearchFilmCorrection(
      (correction) => writer(input, signal, correction),
      validate,
      signal,
      checkpoint,
      createHash('sha256').update(JSON.stringify(input)).digest('hex')
    )
    signal.throwIfAborted()
    await writeFile(join(directory, name), code, { flag: 'wx', mode: 0o600, signal })
    files[name] = code
    progress?.(++completed, total)
  }
  // Helpers can depend on earlier helpers; scene writers only receive the frozen helper set.
  for (const name of shared) await write(name)
  let next = 0
  let failure: unknown
  const lane = async (): Promise<void> => {
    try {
      for (let name = scripts[next++]; name && !signal.aborted; name = scripts[next++])
        await write(name)
    } catch (error) {
      failure ??= error
      controller.abort(error)
      throw error
    }
  }
  // Drain started requests before the presentation owner removes the job directory.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(2, scripts.length) }, lane)
  )
  if (results.some((result) => result.status === 'rejected')) throw failure
  signal.throwIfAborted()
}
