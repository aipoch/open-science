import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { createVideoExportTools } from '@aipoch/research-film'
import {
  assertResearchVideoPlayerSize,
  type ResearchVideoResolution
} from '@aipoch/research-film/contracts'
import { ResearchVideoEncoderCleanupError } from '@aipoch/research-film/export'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalModelSnapshot } from '../../shared/local-models'
import type { createLocalModelOwner } from '../local-models/owner'
import { renderHeadlessResearchFilmMp4 } from './headless-review'
import { waitForFilmStep } from './wait'

const log = createLogger('research-video')
const PREPARATION_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 15 * 60_000

export class ResearchFilmMp4Error extends Error {
  constructor(
    readonly code: 'film_busy' | 'film_export_tools_unavailable',
    message: string
  ) {
    super(message)
  }
}

type Mp4Request = {
  player: FileHandle
  size: number
  resolution: ResearchVideoResolution
  installExportTools: boolean
}

type Mp4Output = { handle: FileHandle; size: number; dispose(): Promise<void> }

async function readPublishedPlayer(
  player: FileHandle,
  size: number,
  signal: AbortSignal
): Promise<string> {
  const bytes = Buffer.allocUnsafe(size)
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await waitForFilmStep(signal, () =>
      player.read(bytes, offset, Math.min(size - offset, 1024 * 1024), offset)
    )
    if (bytesRead === 0) throw new Error('The Research Film player changed during export.')
    offset += bytesRead
  }
  if ((await waitForFilmStep(signal, () => player.stat())).size !== size)
    throw new Error('The Research Film player changed during export.')
  return bytes.toString('utf8')
}

export function createHeadlessResearchFilmExport(
  tools: Pick<
    ReturnType<typeof createVideoExportTools<LocalModelSnapshot>>,
    'available' | 'acquire'
  >,
  models: Pick<ReturnType<typeof createLocalModelOwner>, 'installForUse'>
): {
  render(request: Mp4Request, signal: AbortSignal): Promise<Mp4Output>
  close(): Promise<void>
} {
  const shutdown = new AbortController()
  const pendingDisposals = new Set<() => Promise<void>>()
  let active: Promise<Mp4Output> | undefined

  const render = async (request: Mp4Request, signal: AbortSignal): Promise<Mp4Output> => {
    if (!Number.isSafeInteger(request.size) || request.size <= 0)
      throw new Error('Invalid Research Film size.')
    assertResearchVideoPlayerSize(request.size)
    const prepare = AbortSignal.any([signal, AbortSignal.timeout(PREPARATION_TIMEOUT_MS)])
    const available = await tools.available(prepare)
    prepare.throwIfAborted()
    if (!available) {
      if (!request.installExportTools)
        throw new ResearchFilmMp4Error(
          'film_export_tools_unavailable',
          'Install FFmpeg with H.264 and AAC support and ffprobe, or enable installation of the video export components.'
        )
      const install = AbortSignal.any([signal, AbortSignal.timeout(INSTALL_TIMEOUT_MS)])
      const snapshot = await models.installForUse(install)
      install.throwIfAborted()
      if (snapshot.availability !== 'ready')
        throw new ResearchFilmMp4Error(
          'film_export_tools_unavailable',
          'Video export component installation did not finish. Retry to continue.'
        )
    }
    signal.throwIfAborted()
    const ready = AbortSignal.any([signal, AbortSignal.timeout(PREPARATION_TIMEOUT_MS)])
    const html = await readPublishedPlayer(request.player, request.size, ready)
    const directory = await mkdtemp(join(tmpdir(), 'research-film-mp4-'))
    const removeScratch = (): Promise<void> =>
      rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) =>
        log.warn('Failed to remove Film export scratch', diagnosticErrorFields(error))
      )
    let release: (() => void) | undefined
    try {
      ready.throwIfAborted()
      const encoders = await tools.acquire(directory, ready)
      release = encoders.release
      ready.throwIfAborted()
      const path = await renderHeadlessResearchFilmMp4(
        {
          html,
          directory,
          resolution: request.resolution,
          encoderPath: encoders.encoderPath,
          probePath: encoders.probePath
        },
        signal
      )
      signal.throwIfAborted()
      const handle = await open(path, 'r')
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size === 0) throw new Error('The rendered MP4 is unavailable.')
        signal.throwIfAborted()
        let disposal: Promise<void> | undefined
        const dispose = (): Promise<void> =>
          (disposal ??= handle
            .close()
            .catch((error: unknown) =>
              log.warn('Failed to close Film export', diagnosticErrorFields(error))
            )
            .then(removeScratch)
            .finally(() => pendingDisposals.delete(dispose)))
        pendingDisposals.add(dispose)
        return { handle, size: info.size, dispose }
      } catch (error) {
        await handle.close()
        throw error
      }
    } catch (error) {
      if (error instanceof ResearchVideoEncoderCleanupError) {
        const releaseTools = release
        release = undefined
        // The renderer may still use the staged executables or files until its encoder exits.
        void error.exited.then(removeScratch).finally(() => releaseTools?.())
      } else await removeScratch()
      throw error
    } finally {
      release?.()
    }
  }

  return {
    async render(request, callerSignal) {
      const signal = AbortSignal.any([callerSignal, shutdown.signal])
      signal.throwIfAborted()
      if (active)
        throw new ResearchFilmMp4Error(
          'film_busy',
          'A Research Film MP4 export is already running.'
        )
      active = render(request, signal)
      try {
        return await active
      } finally {
        active = undefined
      }
    },
    async close() {
      shutdown.abort(new Error('Application is closing.'))
      await active?.catch(() => undefined)
      await Promise.all([...pendingDisposals].map((dispose) => dispose()))
    }
  }
}
