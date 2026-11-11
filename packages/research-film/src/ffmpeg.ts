import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { promisify } from 'node:util'
import type { ExportModelSnapshot } from './ports.js'
import type { ExportModelPort } from './ports.js'
import { videoExportBinaries, videoExportTarget } from './ffmpeg-catalog.js'

const execute = promisify(execFile)
import type { VideoEncoderPaths } from './ports.js'
export type { VideoEncoderPaths } from './ports.js'

export async function findSystemVideoEncoders(
  signal: AbortSignal
): Promise<VideoEncoderPaths | undefined> {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform === 'darwin') paths.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  const find = async (name: string): Promise<string | undefined> => {
    for (const directory of new Set(paths)) {
      signal.throwIfAborted()
      const path = join(directory, name + (process.platform === 'win32' ? '.exe' : ''))
      try {
        await access(path, constants.X_OK)
        const { stdout } = await execute(
          path,
          name === 'ffmpeg' ? ['-hide_banner', '-encoders'] : ['-version'],
          { signal, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }
        )
        if (
          name === 'ffmpeg'
            ? /\blibx264\b/.test(stdout) && /\baac\b/.test(stdout)
            : /^ffprobe version /m.test(stdout)
        )
          return path
      } catch {
        signal.throwIfAborted()
      }
    }
    return undefined
  }
  const [encoderPath, probePath] = await Promise.all([find('ffmpeg'), find('ffprobe')])
  return encoderPath && probePath ? { encoderPath, probePath } : undefined
}

export function createVideoExportTools<T extends ExportModelSnapshot>(
  models: ExportModelPort<T>,
  system = findSystemVideoEncoders
): {
  available(signal: AbortSignal): Promise<boolean>
  snapshot(): Promise<T>
  acquire(directory: string, signal: AbortSignal): Promise<VideoEncoderPaths & { release(): void }>
} {
  return {
    async available(signal: AbortSignal): Promise<boolean> {
      if (!videoExportBinaries)
        throw new Error(`Video export is not supported on ${videoExportTarget}`)
      const snapshot = await models.getSnapshot()
      return (
        (snapshot.availability === 'ready' &&
          snapshot.installedRevision === `ffmpeg-6-1-1-${videoExportTarget}`) ||
        Boolean(await system(signal))
      )
    },
    snapshot: () => models.getSnapshot(),
    async acquire(
      directory: string,
      signal: AbortSignal
    ): Promise<VideoEncoderPaths & { release(): void }> {
      const snapshot = await models.getSnapshot()
      if (
        snapshot.availability !== 'ready' ||
        snapshot.installedRevision !== `ffmpeg-6-1-1-${videoExportTarget}`
      ) {
        const paths = await system(signal)
        if (paths) return { ...paths, release: () => undefined }
        throw new Error('Install the video export components before exporting.')
      }
      const lease = await models.acquireUse()
      try {
        if (lease.revision !== `ffmpeg-6-1-1-${videoExportTarget}` || !videoExportBinaries)
          throw new Error('Video export components belong to another platform.')
        const paths: string[] = []
        for (const [index, name] of ['ffmpeg', 'ffprobe'].entries()) {
          signal.throwIfAborted()
          const asset = lease.assets.find((entry) => entry.file === `${name}.bin.gz`)
          if (!asset) throw new Error('Missing video export component')
          const binary = videoExportBinaries[index]
          const path = join(directory, binary.file)
          await pipeline(
            createReadStream(asset.path),
            createGunzip(),
            createWriteStream(path, { flags: 'wx', mode: 0o700 }),
            { signal }
          )
          if ((await stat(path)).size !== binary.size)
            throw new Error('Invalid video export component size')
          const hash = createHash('sha256')
          await pipeline(createReadStream(path), hash, { signal })
          if (hash.digest('hex') !== binary.sha256)
            throw new Error('Invalid video export component checksum')
          await chmod(path, 0o700)
          paths.push(path)
        }
        return { encoderPath: paths[0], probePath: paths[1], release: lease.release }
      } catch (error) {
        lease.release()
        throw error
      }
    }
  }
}
